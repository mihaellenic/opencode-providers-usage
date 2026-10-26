export type ActivityRefreshDriver = {
	/** Include initial/read requests in the same in-flight lifecycle. */
	begin(providerID: string): () => void;
	activity(providerID: string): void;
	completed(providerID: string): void;
	observe(
		providerID: string,
		fetchedAt: number | undefined,
		revision?: number,
	): void;
	dispose(): void;
};

type ProviderActivity = {
	fetchedAt?: number;
	revision?: number;
	lastStart?: number;
	timer?: unknown;
	inFlight: boolean;
	reads: number;
	completion: boolean;
};

/** Event-driven throttle only. Recovery retries belong exclusively to the server. */
export function createActivityRefreshDriver(deps: {
	now(): number;
	refresh(providerID: string): Promise<void>;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}): ActivityRefreshDriver {
	const providers = new Map<string, ProviderActivity>();
	let disposed = false;
	const stateFor = (id: string) => {
		let state = providers.get(id);
		if (!state) {
			state = { inFlight: false, reads: 0, completion: false };
			providers.set(id, state);
		}
		return state;
	};
	const eligible = (state: ProviderActivity) =>
		state.fetchedAt === undefined || deps.now() - state.fetchedAt >= 60_000;
	const schedule = (id: string, state: ProviderActivity) => {
		if (
			disposed ||
			state.inFlight ||
			state.reads > 0 ||
			state.timer !== undefined
		)
			return;
		state.timer = deps.setTimer(
			() => {
				state.timer = undefined;
				if (disposed || (!state.completion && !eligible(state))) return;
				// An initial read may have settled after this event was queued.
				if (deps.now() < (state.lastStart ?? -Infinity) + 15_000) {
					schedule(id, state);
					return;
				}
				state.completion = false;
				state.inFlight = true;
				state.lastStart = deps.now();
				void (async () => {
					try {
						await deps.refresh(id);
					} catch {
						// Keep the existing snapshot; transport failure is not a quota attempt.
					} finally {
						state.inFlight = false;
						if (!disposed && state.completion) schedule(id, state);
					}
				})();
			},
			Math.max(0, (state.lastStart ?? -Infinity) + 15_000 - deps.now()),
		);
	};
	return {
		begin(id) {
			if (disposed) return () => {};
			const state = stateFor(id);
			state.reads += 1;
			state.lastStart = deps.now();
			if (state.timer !== undefined) {
				deps.clearTimer(state.timer);
				state.timer = undefined;
			}
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				state.reads -= 1;
				if (state.completion) schedule(id, state);
			};
		},
		activity(id) {
			if (disposed) return;
			const state = stateFor(id);
			if (eligible(state)) schedule(id, state);
		},
		completed(id) {
			if (disposed) return;
			const state = stateFor(id);
			state.completion = true;
			schedule(id, state);
		},
		observe(id, fetchedAt, revision) {
			if (disposed) return;
			const state = stateFor(id);
			if (state.lastStart === undefined) state.lastStart = deps.now();
			// A newly committed server attempt (including a recovery retry) also
			// owns the request floor. Re-reading its revision must not extend it.
			if (revision !== undefined && revision !== state.revision) {
				state.lastStart = deps.now();
				state.revision = revision;
			}
			if (fetchedAt === undefined) state.fetchedAt = undefined;
			if (
				fetchedAt !== undefined &&
				(state.fetchedAt === undefined || fetchedAt > state.fetchedAt)
			) {
				state.fetchedAt = fetchedAt;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const state of providers.values()) {
				if (state.timer !== undefined) deps.clearTimer(state.timer);
			}
			providers.clear();
		},
	};
}

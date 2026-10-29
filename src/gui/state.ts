import type { ClaudeUsage } from "../claude-code/usage";
import type { ProviderSummary } from "../core/contracts";
import type { QuotaProviderRef, QuotaProviderView } from "../rpc";
import {
	type ActivityRefreshDriver,
	createActivityRefreshDriver,
} from "../ui/activity-refresh";
import { nextQuotaExpiry, revalidateQuota } from "../ui/format";
import { sidebarQuotaPresentation } from "../ui/quota-presentation";
import {
	claudeCountdownRefreshMs,
	createClaudeUsageRequest,
	newestQuotaObservation,
	type QuotaObservation,
	successfulFetchedAt,
} from "../ui/usage-shared";
import type { SessionHost, Unsubscribe, UsageRpc } from "./host";
import { createIdleScheduler } from "./idle-refresh";

/** Local deadline for every request; the controller settles it as failed. */
export const RPC_TIMEOUT_MS = 60_000;

export type SummaryState =
	| { kind: "no-selection" }
	| { kind: "loading"; providerID: string }
	| { kind: "ready"; providerID: string; view: QuotaProviderView }
	| { kind: "failed"; providerID: string; lastKnown?: QuotaProviderView };

export type DashboardState = {
	inventory: "loading" | "ready" | "failed";
	providers: QuotaProviderView[];
	cardErrors: Record<string, string>;
	claude: ClaudeUsage | null;
};

export type ControllerView = "summary" | "dashboard";

export type UsageController = {
	readonly session: SessionHost;
	summary(): SummaryState;
	dashboard(): DashboardState;
	view(): ControllerView;
	/** Dashboard open starts a fresh Claude collection. */
	open(view: ControllerView): void;
	/** Manual: selected provider in summary; all providers and Claude in dashboard. */
	refresh(): void;
	retry(providerID: string): void;
	subscribe(listener: () => void): Unsubscribe;
	dispose(): void;
};

type Token = {
	sessionID: string;
	providerID: string;
	view: ControllerView;
	generation: number;
};

type Request = {
	key: string;
	promise: Promise<void>;
	cancel(): void;
};

type Entry = { provider: ProviderSummary | undefined; obs: QuotaObservation };

const LIST_KEY = "list";
const CARD_ERROR = "Refresh failed";

export function createUsageController(deps: {
	session: SessionHost;
	rpc: UsageRpc;
	initialView?: ControllerView;
	onView?(view: ControllerView): void;
	now(): number;
	setTimer(cb: () => void, ms: number): unknown;
	clearTimer(h: unknown): void;
}): UsageController {
	const { session, rpc } = deps;
	let view: ControllerView = deps.initialView ?? "summary";
	// Visibility is learned only from the host's visibility events: construction
	// never collects, whatever the host reports at that moment.
	let visible = false;
	let disposed = false;
	// Bumped whenever in-flight work must stop being applied.
	let generation = 0;

	let inventory: DashboardState["inventory"] = "loading";
	let inventoryList: ProviderSummary[] = [];
	let cardErrors: Record<string, string> = {};
	let claude: ClaudeUsage | null = null;
	let summaryFailedFor: string | undefined;
	const entries = new Map<string, Entry>();

	const listeners = new Set<() => void>();
	const active = new Set<Request>();
	let driver: ActivityRefreshDriver | undefined;
	let claudeRequest: ReturnType<typeof createClaudeUsageRequest> | undefined;
	let claudeSeq = 0;
	let claudeInFlight = false;
	let displayHandle: unknown;
	let displayArmed = false;

	const selected = (): string | undefined => session.selectedProviderID();

	const tokenFor = (providerID: string): Token => ({
		sessionID: session.sessionID,
		providerID,
		view,
		generation,
	});

	const isCurrent = (token: Token): boolean =>
		!disposed &&
		visible &&
		token.generation === generation &&
		token.view === view &&
		token.sessionID === session.sessionID;

	const clearDisplay = (): void => {
		if (!displayArmed) return;
		deps.clearTimer(displayHandle);
		displayArmed = false;
		displayHandle = undefined;
	};

	/** Display deadlines only repaint; nothing here ever calls the rpc. */
	const scheduleDisplay = (): void => {
		clearDisplay();
		if (disposed || !visible || listeners.size === 0) return;
		const now = deps.now();
		const delays: number[] = [];
		const consider = (at: number | undefined): void => {
			if (at !== undefined && at > now) delays.push(at - now);
		};
		if (view === "dashboard") {
			if (claude !== null) {
				const delay = claudeCountdownRefreshMs(claude, now);
				if (delay !== undefined) delays.push(delay);
			}
			for (const provider of inventoryList) {
				const entry = entries.get(provider.providerID);
				if (entry !== undefined)
					consider(nextQuotaExpiry(entry.obs.quota, now));
			}
		} else {
			const id = selected();
			const entry = id === undefined ? undefined : entries.get(id);
			if (entry !== undefined) {
				const shown = sidebarQuotaPresentation({ ...entry.obs, now });
				consider(shown.nextChangeAt);
				consider(nextQuotaExpiry(shown.quota, now));
			}
		}
		if (delays.length === 0) return;
		displayArmed = true;
		displayHandle = deps.setTimer(
			() => {
				displayArmed = false;
				displayHandle = undefined;
				notify();
			},
			Math.min(...delays),
		);
	};

	function notify(): void {
		if (disposed) return;
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// A faulty subscriber must not break request settling or timers.
			}
		}
		scheduleDisplay();
	}

	const refFor = (providerID: string): QuotaProviderRef => {
		const known =
			inventoryList.find((p) => p.providerID === providerID) ??
			entries.get(providerID)?.provider;
		// The rpc schema sends only providerID and the backend resolves the actual
		// source, so an empty authMethod for a not-yet-listed provider is harmless.
		if (known === undefined) return { providerID, authMethod: "" };
		return {
			providerID,
			authMethod: known.authMethod,
			...(known.integrationID === undefined
				? {}
				: { integrationID: known.integrationID }),
		};
	};

	const hasRequest = (key: string): Request | undefined =>
		[...active].find((request) => request.key === key);

	/**
	 * One tracked request: token-checked on settle, bounded by RPC_TIMEOUT_MS,
	 * and total (its promise resolves exactly once and never rejects).
	 */
	const run = <T>(
		key: string,
		token: Token,
		call: (signal: AbortSignal) => Promise<T>,
		onOk: (value: T) => void,
		onFail: () => void,
	): Request => {
		const controller = new AbortController();
		let settle: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			settle = resolve;
		});
		let done = false;
		const request: Request = {
			key,
			promise,
			cancel: () => end(undefined, true),
		};
		const timer = deps.setTimer(() => end(onFail, true), RPC_TIMEOUT_MS);
		function end(apply: (() => void) | undefined, abort: boolean): void {
			if (done) return;
			done = true;
			deps.clearTimer(timer);
			active.delete(request);
			if (abort) controller.abort();
			if (apply !== undefined && isCurrent(token)) {
				try {
					apply();
				} catch {
					// Keep the settle path total; state stays as it was.
				}
			}
			settle();
		}
		active.add(request);
		let pending: Promise<T>;
		try {
			pending = call(controller.signal);
		} catch (error) {
			pending = Promise.reject(error);
		}
		void pending.then(
			(value) => end(() => onOk(value), false),
			() => end(onFail, false),
		);
		return request;
	};

	const accept = (
		providerID: string,
		provider: ProviderSummary | undefined,
		incoming: QuotaObservation,
	): void => {
		const current = entries.get(providerID);
		const chosen = newestQuotaObservation(current?.obs, incoming);
		const next: Entry = {
			provider:
				chosen === incoming
					? (provider ?? current?.provider)
					: (current?.provider ?? provider),
			obs: chosen,
		};
		entries.set(providerID, next);
		driver?.observe(
			providerID,
			successfulFetchedAt(chosen),
			chosen.presentation?.revision,
		);
	};

	const startList = (): void => {
		if (hasRequest(LIST_KEY) !== undefined) return;
		if (inventory !== "ready") inventory = "loading";
		run(
			LIST_KEY,
			tokenFor("*"),
			(signal) => rpc.list(signal),
			(result) => {
				inventoryList = result.providers.map((v) => v.provider);
				for (const v of result.providers) {
					accept(v.provider.providerID, v.provider, {
						quota: v.quota,
						presentation: v.presentation,
					});
				}
				inventory = "ready";
				notify();
			},
			() => {
				// A failed re-list keeps an already usable inventory.
				if (inventory !== "ready") inventory = "failed";
				notify();
			},
		);
		notify();
	};

	const refreshProvider = (providerID: string): Promise<void> => {
		const key = `refresh:${providerID}`;
		const existing = hasRequest(key);
		if (existing !== undefined) return existing.promise;
		if (disposed || !visible) return Promise.resolve();
		return run(
			key,
			tokenFor(providerID),
			(signal) => rpc.refresh(refFor(providerID), signal),
			(result) => {
				accept(providerID, result.provider, {
					quota: result.quota,
					presentation: result.presentation,
				});
				if (summaryFailedFor === providerID) summaryFailedFor = undefined;
				if (providerID in cardErrors) {
					const { [providerID]: _cleared, ...rest } = cardErrors;
					cardErrors = rest;
				}
				notify();
			},
			() => {
				if (view === "summary") summaryFailedFor = providerID;
				else cardErrors = { ...cardErrors, [providerID]: CARD_ERROR };
				notify();
			},
		).promise;
	};

	const startGet = (providerID: string): void => {
		const key = `get:${providerID}`;
		if (hasRequest(key) !== undefined) return;
		const endInitial = driver?.begin(providerID);
		const request = run(
			key,
			tokenFor(providerID),
			(signal) => rpc.get(refFor(providerID), signal),
			(result) => {
				accept(providerID, result.provider, {
					quota: result.quota,
					presentation: result.presentation,
				});
				if (summaryFailedFor === providerID) summaryFailedFor = undefined;
				notify();
			},
			() => {
				summaryFailedFor = providerID;
				notify();
			},
		);
		void request.promise.then(() => endInitial?.());
	};

	const cancelClaude = (): void => {
		claudeRequest?.cancel();
		claudeRequest = undefined;
		claudeSeq += 1;
		claudeInFlight = false;
	};

	/** Bounded Claude collection: a timeout or abort resolves to null. */
	const collectClaude = (
		signal: AbortSignal,
		seq: number,
	): Promise<ClaudeUsage | null> =>
		new Promise<ClaudeUsage | null>((resolve) => {
			const inner = new AbortController();
			let done = false;
			const timer = deps.setTimer(() => {
				inner.abort();
				finish(null);
			}, RPC_TIMEOUT_MS);
			const onAbort = (): void => {
				inner.abort();
				finish(null);
			};
			function finish(value: ClaudeUsage | null): void {
				if (done) return;
				done = true;
				deps.clearTimer(timer);
				signal.removeEventListener("abort", onAbort);
				if (seq === claudeSeq) claudeInFlight = false;
				resolve(value);
			}
			signal.addEventListener("abort", onAbort, { once: true });
			let pending: Promise<ClaudeUsage | null>;
			try {
				pending = rpc.claudeCodeUsage(inner.signal);
			} catch (error) {
				pending = Promise.reject(error);
			}
			void pending.then(finish, () => finish(null));
		});

	const startClaude = (): void => {
		cancelClaude();
		const token = tokenFor("claude-code");
		const seq = claudeSeq;
		claudeInFlight = true;
		const request = createClaudeUsageRequest({
			collect: (signal) => collectClaude(signal, seq),
			apply: (usage) => {
				if (seq !== claudeSeq || !isCurrent(token)) return;
				claude = usage;
				notify();
			},
		});
		claudeRequest = request;
		request.start();
	};

	/** The list is already the connected inventory: every entry is refreshed. */
	const connectedIDs = (): string[] => inventoryList.map((p) => p.providerID);

	const makeDriver = (): void => {
		driver?.dispose();
		const next = createActivityRefreshDriver({
			now: deps.now,
			refresh: refreshProvider,
			setTimer: deps.setTimer,
			clearTimer: deps.clearTimer,
		});
		for (const [id, entry] of entries) {
			next.observe(
				id,
				successfulFetchedAt(entry.obs),
				entry.obs.presentation?.revision,
			);
		}
		driver = next;
	};

	const collect = (): void => {
		if (view === "summary") {
			if (inventory !== "ready") startList();
			const id = selected();
			if (id !== undefined) startGet(id);
		} else {
			startList();
			startClaude();
		}
	};

	const cancelAll = (): void => {
		generation += 1;
		for (const request of [...active]) request.cancel();
		cancelClaude();
	};

	const idle = createIdleScheduler({
		now: deps.now,
		setTimer: deps.setTimer,
		clearTimer: deps.clearTimer,
		fire: () => {
			try {
				if (disposed || !visible) return;
				if (view === "summary") {
					const id = selected();
					if (id !== undefined) driver?.completed(id);
					return;
				}
				if (inventory !== "ready") startList();
				for (const id of connectedIDs()) driver?.completed(id);
				if (!claudeInFlight) startClaude();
			} catch {
				// The scheduler stops re-arming if its callback throws.
			}
		},
	});

	/** Stop all work for the old scope, then collect for the current one. */
	const restart = (): void => {
		cancelAll();
		makeDriver();
		idle.reschedule();
		collect();
	};

	const show = (): void => {
		if (disposed || visible) return;
		visible = true;
		generation += 1;
		makeDriver();
		idle.show();
		collect();
		scheduleDisplay();
	};

	const hide = (): void => {
		if (disposed || !visible) return;
		visible = false;
		cancelAll();
		driver?.dispose();
		driver = undefined;
		idle.hide();
		clearDisplay();
	};

	const relevant = (providerID: string): boolean =>
		view === "summary"
			? providerID === selected()
			: connectedIDs().includes(providerID);

	const handleActivity = (
		event: Parameters<Parameters<SessionHost["onActivity"]>[0]>[0],
	): void => {
		if (disposed || !visible) return;
		try {
			switch (event.kind) {
				case "input":
				case "focus": {
					if (view === "summary") {
						const id = selected();
						if (id !== undefined) driver?.activity(id);
					} else {
						for (const id of connectedIDs()) driver?.activity(id);
					}
					idle.input();
					break;
				}
				case "step-started":
					if (relevant(event.providerID)) driver?.activity(event.providerID);
					break;
				case "step-finished":
				case "step-failed":
					if (relevant(event.providerID)) driver?.completed(event.providerID);
					break;
			}
		} catch {
			// Host callbacks must never throw into the host.
		}
	};

	const viewOf = (entry: Entry): QuotaProviderView | undefined => {
		if (entry.provider === undefined) return undefined;
		const shown = sidebarQuotaPresentation({ ...entry.obs, now: deps.now() });
		return {
			provider: entry.provider,
			quota: shown.quota,
			...(entry.obs.presentation === undefined
				? {}
				: { presentation: entry.obs.presentation }),
		};
	};

	const unsubscribers: Unsubscribe[] = [
		session.onVisible((next) => (next ? show() : hide())),
		session.onSelectedModel(() => {
			if (disposed) return;
			summaryFailedFor = undefined;
			if (visible) {
				if (view === "summary") restart();
				else idle.reschedule();
			}
			notify();
		}),
		session.onActivity(handleActivity),
		rpc.onUpdated((event) => {
			if (disposed || !visible) return;
			accept(event.providerID, undefined, {
				quota: event.quota,
				presentation: event.presentation,
			});
			if (summaryFailedFor === event.providerID) summaryFailedFor = undefined;
			notify();
		}),
	];

	return {
		session,
		summary() {
			const id = selected();
			if (id === undefined) return { kind: "no-selection" };
			const entry = entries.get(id);
			const known = entry === undefined ? undefined : viewOf(entry);
			if (summaryFailedFor === id) {
				return known === undefined
					? { kind: "failed", providerID: id }
					: { kind: "failed", providerID: id, lastKnown: known };
			}
			return known === undefined
				? { kind: "loading", providerID: id }
				: { kind: "ready", providerID: id, view: known };
		},
		dashboard() {
			const now = deps.now();
			return {
				inventory,
				providers: inventoryList.flatMap((summary) => {
					const entry = entries.get(summary.providerID);
					return entry === undefined
						? []
						: [
								{
									provider: entry.provider ?? summary,
									quota: revalidateQuota(entry.obs.quota, now),
								},
							];
				}),
				cardErrors,
				claude,
			};
		},
		view: () => view,
		open(next) {
			if (disposed || next === view) return;
			view = next;
			deps.onView?.(next);
			if (visible) restart();
			notify();
		},
		refresh() {
			if (disposed || !visible) return;
			if (view === "summary") {
				const id = selected();
				if (id !== undefined) void refreshProvider(id);
				return;
			}
			if (inventory !== "ready") startList();
			for (const id of connectedIDs()) void refreshProvider(id);
			startClaude();
		},
		retry(providerID) {
			if (disposed || !visible) return;
			if (view === "summary") {
				if (providerID !== selected()) return;
				summaryFailedFor = undefined;
				startGet(providerID);
			} else {
				const { [providerID]: _cleared, ...rest } = cardErrors;
				cardErrors = rest;
				void refreshProvider(providerID);
			}
			notify();
		},
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			scheduleDisplay();
			return () => {
				listeners.delete(listener);
				scheduleDisplay();
			};
		},
		dispose() {
			if (disposed) return;
			cancelAll();
			disposed = true;
			visible = false;
			for (const unsubscribe of unsubscribers) unsubscribe();
			driver?.dispose();
			driver = undefined;
			idle.dispose();
			clearDisplay();
			listeners.clear();
		},
	};
}

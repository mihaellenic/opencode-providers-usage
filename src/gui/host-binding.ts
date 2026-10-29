// The only module (besides src/gui.tsx) that touches the Desktop GUI host.
// Everything here is validated structurally: SDK outputs are `unknown` JSON
// and are checked by the product guards; no casts, no message matching.
import {
	createEffect,
	createMemo,
	createRoot,
	on,
	onCleanup,
	untrack,
} from "solid-js";
import type { ClaudeUsage } from "../claude-code/usage";
import {
	isClaudeUsage,
	isQuotaGetResult,
	isQuotaListResult,
	isQuotaUpdatedEvent,
	QUOTA_RPC_ID,
	QuotaRpc,
} from "../rpc";
import type { HostActivity, SessionHost, Unsubscribe, UsageRpc } from "./host";

/** Typed narrow view of `ctx.client.rpc(QuotaRpc)`; the real RpcClient is assignable to it. */
export type QuotaRpcClient = {
	list(
		input: Record<string, never>,
		options: { signal: AbortSignal },
	): Promise<unknown>;
	get(
		input: { providerID: string },
		options: { signal: AbortSignal },
	): Promise<unknown>;
	refresh(
		input: { providerID: string },
		options: { signal: AbortSignal },
	): Promise<unknown>;
	claudeCodeUsage(
		input: Record<string, never>,
		options: { signal: AbortSignal },
	): Promise<unknown>;
};

type StepEventType =
	| "session.step.started"
	| "session.step.ended"
	| "session.step.failed";
type RpcEventType = `rpc.${string}`;

/**
 * The synced-data event bus of a server. Unlike the raw `client.event`
 * stream, which ends for good when the connection drops (SharedEvents
 * finishes its subscribers), the host's data controller sits on the SDK's
 * reconnecting connection (createClientConnection: reconnect loop with a
 * `reconnecting` status), so its `on` listeners survive transport drops. A
 * restarted server yields a new `data`; see followEvents.
 */
export type EventData = {
	on(
		type: StepEventType | RpcEventType,
		handler: (event: { type: string; data?: unknown }) => void,
	): () => void;
};

export type RpcBindingContext = {
	readonly signal: AbortSignal;
	readonly client: { rpc(definition: typeof QuotaRpc): QuotaRpcClient };
	/** The server that runs this plugin is the builtin one (documented `Servers.get` example). */
	readonly servers: {
		list(): readonly string[];
		get(
			id: string,
		): { readonly builtin: boolean; readonly data: EventData } | undefined;
	};
};

/**
 * Listens to `types` on whatever data controller `data()` currently returns.
 * The Solid effect re-subscribes when that identity changes (server restart),
 * releasing the previous listeners first, so there are no duplicates and no
 * retry timers: reconnecting itself is the SDK connection's job.
 */
function followEvents(
	data: () => EventData | undefined,
	types: readonly (StepEventType | RpcEventType)[],
	handler: (event: { type: string; data?: unknown }) => void,
	/** Runs whenever the current subscription is released (rebind or teardown). */
	onReset?: () => void,
): Unsubscribe {
	return createRoot((dispose) => {
		createEffect(() => {
			const current = data();
			if (current === undefined) return;
			const offs = types.map((type) =>
				current.on(type, (event) => {
					try {
						handler(event);
					} catch {
						// A faulty subscriber must not break the host event bus.
					}
				}),
			);
			onCleanup(() => {
				for (const off of offs) off();
				onReset?.();
			});
		});
		return dispose;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return isRecord(error) && error.name === "AbortError";
}

/**
 * The host reports cancellation as a transport failure, not an AbortError.
 * Only the caller's own signal (or a real AbortError) counts as cancellation;
 * every other failure stays a failure.
 */
function normalize(error: unknown, signal: AbortSignal): unknown {
	return signal.aborted || isAbortError(error) ? abortError() : error;
}

export function bindUsageRpc(ctx: RpcBindingContext): UsageRpc {
	// Read the client where it is used: a restarted server gets a new client.
	const client = (): QuotaRpcClient => ctx.client.rpc(QuotaRpc);

	return {
		async list(signal) {
			try {
				const result = await client().list({}, { signal });
				if (signal.aborted) throw abortError();
				if (!isQuotaListResult(result))
					throw new Error("Invalid list response");
				return result;
			} catch (error) {
				throw normalize(error, signal);
			}
		},
		async get(ref, signal) {
			try {
				const result = await client().get(
					{ providerID: ref.providerID },
					{ signal },
				);
				if (signal.aborted) throw abortError();
				if (!isQuotaGetResult(result)) throw new Error("Invalid get response");
				return result;
			} catch (error) {
				throw normalize(error, signal);
			}
		},
		async refresh(ref, signal) {
			try {
				const result = await client().refresh(
					{ providerID: ref.providerID },
					{ signal },
				);
				if (signal.aborted) throw abortError();
				if (!isQuotaGetResult(result))
					throw new Error("Invalid refresh response");
				return result;
			} catch (error) {
				throw normalize(error, signal);
			}
		},
		async claudeCodeUsage(signal): Promise<ClaudeUsage | null> {
			if (signal.aborted) throw abortError();
			let result: unknown;
			try {
				result = await client().claudeCodeUsage({}, { signal });
			} catch (error) {
				// rpc.method_not_found and every other failure: no Claude data.
				if (signal.aborted || isAbortError(error)) throw abortError();
				return null;
			}
			if (signal.aborted) throw abortError();
			return isClaudeUsage(result) ? result : null;
		},
		onUpdated(handler) {
			const builtin = (): EventData | undefined => {
				for (const id of ctx.servers.list()) {
					const server = ctx.servers.get(id);
					if (server?.builtin) return server.data;
				}
				return undefined;
			};
			const stop = followEvents(
				builtin,
				[`rpc.${QUOTA_RPC_ID}.updated`],
				(event) => {
					if (isQuotaUpdatedEvent(event.data)) handler(event.data);
				},
			);
			const end = (): void => {
				ctx.signal.removeEventListener("abort", end);
				stop();
			};
			if (ctx.signal.aborted) end();
			else ctx.signal.addEventListener("abort", end, { once: true });
			return end;
		},
	};
}

const STEP_TYPES: readonly StepEventType[] = [
	"session.step.started",
	"session.step.ended",
	"session.step.failed",
];

/** Narrow view of the owning session's server; the real `ServerRef` is assignable to it. */
export type SessionServer = {
	readonly data: EventData & {
		readonly session: {
			get(
				sessionID: string,
			): { model?: { providerID: string } | undefined } | undefined;
		};
	};
};

export type SessionBindingContext = { readonly signal: AbortSignal };

/**
 * Render-scoped inputs the global context cannot derive: the owning session's
 * server (read lazily), the owning screen's effective composer model and the
 * panel's visibility (`usePanel`, render-scoped).
 */
export type SessionScope = {
	server(): SessionServer;
	/**
	 * Provider of the model the owning screen's composer would send the next
	 * prompt with (the picker choice, else the agent or app default). Reactive.
	 * Undefined while the model catalog loads, when no connected provider offers
	 * the choice and in a subagent's session, which has no composer.
	 */
	composerProviderID(): string | undefined;
	visible(): boolean;
};

function stepFields(
	data: unknown,
):
	| { sessionID: string; assistantMessageID: string; model: unknown }
	| undefined {
	if (!isRecord(data)) return undefined;
	const { sessionID, assistantMessageID, model } = data;
	if (typeof sessionID !== "string" || typeof assistantMessageID !== "string")
		return undefined;
	return { sessionID, assistantMessageID, model };
}

function providerOf(model: unknown): string | undefined {
	return isRecord(model) &&
		typeof model.providerID === "string" &&
		model.providerID.length > 0
		? model.providerID
		: undefined;
}

const INPUT_DEDUPE_MS = 100;

export function bindSessionHost(
	ctx: SessionBindingContext,
	sessionID: string,
	scope: SessionScope,
): SessionHost {
	const activity = new Set<(event: HostActivity) => void>();
	let stopActivity: (() => void) | undefined;

	const emit = (event: HostActivity): void => {
		for (const handler of [...activity]) {
			try {
				handler(event);
			} catch {
				// A faulty subscriber must not break the host stream.
			}
		}
	};

	const startActivity = (): (() => void) => {
		// Provider per started step, keyed by session + assistant message.
		const started = new Map<string, string>();
		const keyOf = (assistantMessageID: string): string =>
			`${sessionID}\n${assistantMessageID}`;

		const onStep = (type: string, data: unknown): void => {
			const fields = stepFields(data);
			if (fields === undefined || fields.sessionID !== sessionID) return;
			const key = keyOf(fields.assistantMessageID);
			if (type === "session.step.started") {
				const providerID = providerOf(fields.model);
				if (providerID === undefined) return;
				started.set(key, providerID);
				emit({ kind: "step-started", providerID });
				return;
			}
			if (type === "session.step.ended" || type === "session.step.failed") {
				const providerID = started.get(key);
				started.delete(key);
				// An end without an observed start has no provider: never guess one.
				if (providerID === undefined) return;
				emit({
					kind: type === "session.step.ended" ? "step-finished" : "step-failed",
					providerID,
				});
			}
		};

		// Native step events come from the owning server's reconnect-safe data bus.
		const stopSteps = followEvents(
			() => scope.server().data,
			STEP_TYPES,
			(event) => onStep(event.type, event.data),
			// Steps seen on a replaced data controller must not attribute later ends.
			() => started.clear(),
		);

		let lastKeydown = Number.NEGATIVE_INFINITY;
		const onKeydown = (event: KeyboardEvent): void => {
			lastKeydown = event.timeStamp;
			emit({ kind: "input" });
		};
		const onInput = (event: Event): void => {
			// The input event of a key press the keydown already reported.
			if (
				event.timeStamp - lastKeydown < INPUT_DEDUPE_MS &&
				event.timeStamp >= lastKeydown
			)
				return;
			emit({ kind: "input" });
		};
		const onPointer = (): void => emit({ kind: "input" });
		const onFocus = (): void => emit({ kind: "focus" });
		document.addEventListener("keydown", onKeydown, true);
		document.addEventListener("input", onInput, true);
		document.addEventListener("pointerdown", onPointer, true);
		window.addEventListener("focus", onFocus);

		return () => {
			stopSteps();
			started.clear();
			document.removeEventListener("keydown", onKeydown, true);
			document.removeEventListener("input", onInput, true);
			document.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("focus", onFocus);
		};
	};

	// The effective composer model is the selection the user sees, picked or
	// default, sent or not. The owning session's durable model is only the
	// fallback when the composer has none (catalog loading, subagent session).
	// Step attribution never uses either: it comes from native start events.
	const selected = (): string | undefined =>
		scope.composerProviderID() ??
		scope.server().data.session.get(sessionID)?.model?.providerID;

	// Every subscription is tracked so the plugin signal can end them all, and
	// the signal listener is held only while at least one is live.
	const subscriptions = new Set<() => void>();
	const onPluginAbort = (): void => {
		for (const end of [...subscriptions]) end();
		activity.clear();
	};
	const track = (teardown: () => void): Unsubscribe => {
		let done = false;
		const end = (): void => {
			if (done) return;
			done = true;
			subscriptions.delete(end);
			if (subscriptions.size === 0)
				ctx.signal.removeEventListener("abort", onPluginAbort);
			teardown();
		};
		if (subscriptions.size === 0 && !ctx.signal.aborted)
			ctx.signal.addEventListener("abort", onPluginAbort, { once: true });
		subscriptions.add(end);
		if (ctx.signal.aborted) queueMicrotask(onPluginAbort);
		return end;
	};

	const watch = (
		run: () => void,
		source: () => unknown,
		defer: boolean,
	): Unsubscribe => {
		const dispose = createRoot((disposeRoot) => {
			createEffect(on(createMemo(source), () => untrack(run), { defer }));
			return disposeRoot;
		});
		return track(dispose);
	};

	return {
		sessionID,
		selectedProviderID: () => untrack(selected),
		onSelectedModel: (handler) => watch(handler, selected, true),
		visible: () => untrack(scope.visible),
		onVisible(handler) {
			// The current visibility is delivered once right after subscribing (in a
			// microtask, so a constructor that subscribes several hosts finishes
			// first), then on every change. Equal consecutive values are dropped.
			let delivered: boolean | undefined;
			let active = true;
			const deliver = (): void => {
				const next = untrack(scope.visible);
				if (!active || next === delivered) return;
				delivered = next;
				handler(next);
			};
			const stop = watch(deliver, scope.visible, true);
			queueMicrotask(deliver);
			return () => {
				active = false;
				stop();
			};
		},
		onActivity(handler) {
			activity.add(handler);
			if (stopActivity === undefined) {
				const teardown = startActivity();
				stopActivity = track(() => {
					stopActivity = undefined;
					teardown();
				});
			}
			return () => {
				activity.delete(handler);
				if (activity.size === 0) {
					stopActivity?.();
					stopActivity = undefined;
				}
			};
		},
	};
}

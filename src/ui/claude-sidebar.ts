import type { ClaudeUsage } from "../claude-code/usage";
import type { LocaleContext } from "../core/contracts";
import type { SidebarModel } from "./sidebar-model";
import { claudeUsageCard } from "./usage-page-model";
import { claudeAllWindowsReset } from "./usage-shared";

export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export const CLAUDE_SIDEBAR_FLOOR_MS = 60_000;
/** Backoff delays for consecutive failed collections; the last one is the cap. */
export const CLAUDE_SIDEBAR_RETRY_CAP_MS = 60_000;
export const CLAUDE_SIDEBAR_RETRY_DELAYS_MS = [
	5_000,
	15_000,
	30_000,
	CLAUDE_SIDEBAR_RETRY_CAP_MS,
] as const;
/** A collection that has not settled by then is treated as failed. */
export const CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS = 35_000;

export type ClaudeSidebarState =
	| { status: "loading" }
	| { status: "ready"; usage: ClaudeUsage }
	| { status: "failed" };

export type ClaudeSidebarController = {
	/** Called whenever the selected provider becomes / stops being claude-agent. */
	select(active: boolean): void;
	/** Activity or step-completion signal. */
	trigger(): void;
	state(): ClaudeSidebarState;
	dispose(): void;
};

const LOADING: ClaudeSidebarState = { status: "loading" };
const FAILED: ClaudeSidebarState = { status: "failed" };

/**
 * Sidebar collection policy for the Claude Code card. Collection runs only
 * while the claude-agent provider is selected: selecting it always collects,
 * while triggers collect at most once per floor, measured from the start of
 * the previous attempt, and never overlap an in-flight collection. A late
 * result from an aborted, superseded, or timed-out collection is dropped.
 *
 * A failed collection keeps the last good figures while at least one window
 * has not reset yet, so a lost reply after sleep does not blank the card, and
 * schedules a retry with backoff (5s, 15s, 30s, then every 60s). Retries are
 * single-flight and only run while the provider is selected; a success resets
 * the backoff. Every attempt is bounded by a watchdog timer, so a collection
 * that never settles cannot hold the single-flight slot forever.
 */
export function createClaudeSidebarController(options: {
	collect(signal: AbortSignal): Promise<ClaudeUsage | null>;
	now(): number;
	onChange(state: ClaudeSidebarState): void;
	setTimer(callback: () => void, delay: number): unknown;
	clearTimer(handle: unknown): void;
}): ClaudeSidebarController {
	let state: ClaudeSidebarState = LOADING;
	let active = false;
	let disposed = false;
	let inFlight: AbortController | undefined;
	let generation = 0;
	let lastAttemptStart: number | undefined;
	let lastReady: ClaudeUsage | undefined;
	let failures = 0;
	let retry: unknown | undefined;
	let watchdog: unknown | undefined;

	const setState = (next: ClaudeSidebarState): void => {
		if (next === state) return;
		state = next;
		options.onChange(next);
	};

	const clearRetry = (): void => {
		if (retry === undefined) return;
		options.clearTimer(retry);
		retry = undefined;
	};

	const clearWatchdog = (): void => {
		if (watchdog === undefined) return;
		options.clearTimer(watchdog);
		watchdog = undefined;
	};

	const scheduleRetry = (): void => {
		if (disposed || !active) return;
		clearRetry();
		const delay =
			CLAUDE_SIDEBAR_RETRY_DELAYS_MS[
				Math.min(failures, CLAUDE_SIDEBAR_RETRY_DELAYS_MS.length) - 1
			] ?? CLAUDE_SIDEBAR_RETRY_CAP_MS;
		retry = options.setTimer(() => {
			retry = undefined;
			if (disposed || !active) return;
			// A slow attempt still owns the slot; try again after the same delay.
			if (inFlight !== undefined) {
				scheduleRetry();
				return;
			}
			start();
		}, delay);
	};

	const succeed = (usage: ClaudeUsage): void => {
		lastReady = usage;
		failures = 0;
		clearRetry();
		setState({ status: "ready", usage });
	};

	const fail = (): void => {
		failures += 1;
		// A lost reply is not evidence that the figures expired; keep them while
		// at least one window still has a future reset.
		if (
			lastReady !== undefined &&
			!claudeAllWindowsReset(lastReady, options.now())
		) {
			if (state.status !== "ready") {
				setState({ status: "ready", usage: lastReady });
			}
		} else {
			setState(FAILED);
		}
		scheduleRetry();
	};

	const start = (): void => {
		clearRetry();
		const controller = new AbortController();
		const request = ++generation;
		let settled = false;
		inFlight = controller;
		lastAttemptStart = options.now();
		watchdog = options.setTimer(() => {
			watchdog = undefined;
			if (settled) return;
			settled = true;
			// A reply lost across sleep never arrives; stop waiting on it.
			controller.abort();
			if (request !== generation) return;
			inFlight = undefined;
			fail();
		}, CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS);
		const settle = (usage: ClaudeUsage | null): void => {
			if (settled || request !== generation || controller.signal.aborted)
				return;
			settled = true;
			clearWatchdog();
			inFlight = undefined;
			if (usage === null) {
				fail();
				return;
			}
			succeed(usage);
		};
		new Promise<ClaudeUsage | null>((resolve) =>
			resolve(options.collect(controller.signal)),
		).then(
			(usage) => settle(usage),
			() => settle(null),
		);
	};

	const abortInFlight = (): void => {
		clearWatchdog();
		inFlight?.abort();
		inFlight = undefined;
		generation += 1;
	};

	return {
		select(next) {
			if (disposed || next === active) return;
			active = next;
			clearRetry();
			failures = 0;
			if (next) {
				setState(LOADING);
				start();
				return;
			}
			abortInFlight();
			setState(LOADING);
		},
		trigger() {
			if (!active || disposed || inFlight !== undefined) return;
			if (
				lastAttemptStart !== undefined &&
				options.now() - lastAttemptStart < CLAUDE_SIDEBAR_FLOOR_MS
			)
				return;
			start();
		},
		state() {
			return state;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearRetry();
			abortInFlight();
		},
	};
}

/**
 * Terminal sidebar view of the Claude Code card. Ready reuses the page card's
 * lines exactly; loading and failed carry fixed copy with no figures or error
 * detail.
 */
export function claudeSidebarModel(
	state: ClaudeSidebarState,
	locale: LocaleContext,
	now: number,
): SidebarModel {
	const provider = "Claude Code";
	if (state.status === "ready") {
		return {
			provider,
			lines: claudeUsageCard(state.usage, locale, now).lines,
		};
	}
	if (state.status === "loading") {
		return {
			provider,
			lines: [
				{
					id: "quota:pending",
					kind: "status",
					text: "Checking quota…",
					tone: "muted",
				},
			],
		};
	}
	return {
		provider,
		lines: [
			{
				id: "claude:unavailable",
				kind: "status",
				text: "Usage unavailable",
				tone: "muted",
			},
		],
	};
}

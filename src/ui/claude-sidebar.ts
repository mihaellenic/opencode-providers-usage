import type { ClaudeUsage } from "../claude-code/usage";
import type { LocaleContext } from "../core/contracts";
import type { SidebarModel } from "./sidebar-model";
import { claudeUsageCard } from "./usage-page-model";

export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export const CLAUDE_SIDEBAR_FLOOR_MS = 60_000;

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
 * Timer-free sidebar collection policy. Collection runs only while the
 * claude-agent provider is selected: selecting it always collects, while
 * triggers collect at most once per floor, measured from the start of the
 * previous attempt, and never overlap an in-flight collection. A late result
 * from an aborted or superseded collection is dropped.
 */
export function createClaudeSidebarController(options: {
	collect(signal: AbortSignal): Promise<ClaudeUsage | null>;
	now(): number;
	onChange(state: ClaudeSidebarState): void;
}): ClaudeSidebarController {
	let state: ClaudeSidebarState = LOADING;
	let active = false;
	let disposed = false;
	let inFlight: AbortController | undefined;
	let generation = 0;
	let lastAttemptStart: number | undefined;

	const setState = (next: ClaudeSidebarState): void => {
		if (next === state) return;
		state = next;
		options.onChange(next);
	};

	const start = (): void => {
		const controller = new AbortController();
		const request = ++generation;
		inFlight = controller;
		lastAttemptStart = options.now();
		const settle = (next: ClaudeSidebarState | undefined): void => {
			if (request !== generation || controller.signal.aborted) return;
			inFlight = undefined;
			if (next !== undefined) setState(next);
		};
		new Promise<ClaudeUsage | null>((resolve) =>
			resolve(options.collect(controller.signal)),
		).then(
			(usage) => settle(usage === null ? FAILED : { status: "ready", usage }),
			() => settle(FAILED),
		);
	};

	const abortInFlight = (): void => {
		inFlight?.abort();
		inFlight = undefined;
		generation += 1;
	};

	return {
		select(next) {
			if (disposed || next === active) return;
			active = next;
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

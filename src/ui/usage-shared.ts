import type { ClaudeUsage } from "../claude-code/usage";
import type { QuotaPresentation, QuotaRead } from "../core/contracts";
import { CLAUDE_AGENT_PROVIDER_ID } from "./claude-sidebar";
import { CLAUDE_CARD_ID, type UsagePageCard } from "./usage-page-model";

/**
 * Display-only cadence for the Claude Code reset countdown. The card can be
 * the only one on the page, so provider expiry deadlines may not schedule any
 * repaint; this bounded timer keeps the text current without ever collecting
 * usage again. Sub-minute countdowns tick every second so their seconds do not
 * visibly freeze.
 */
export const CLAUDE_USAGE_COUNTDOWN_REFRESH_MS = 30_000;

/**
 * Delay until the soonest still-future Claude reset needs a repaint, or
 * `undefined` when every window has already reset and the text can no longer
 * change.
 */
export function claudeCountdownRefreshMs(
	usage: ClaudeUsage,
	now: number,
): number | undefined {
	const soonest = Math.min(
		...[usage.session.resetsAt, usage.week.resetsAt].filter(
			(resetsAt) => resetsAt > now,
		),
	);
	if (!Number.isFinite(soonest)) return undefined;
	return soonest - now < 60_000 ? 1_000 : CLAUDE_USAGE_COUNTDOWN_REFRESH_MS;
}

export type QuotaObservation = {
	quota: QuotaRead;
	presentation?: QuotaPresentation;
};

/** Server revisions order RPC responses and pushes together, including invalidations. */
export function newestQuotaObservation(
	current: QuotaObservation | undefined,
	incoming: QuotaObservation,
): QuotaObservation {
	const previous = current?.presentation?.revision;
	const next = incoming.presentation?.revision;
	return current !== undefined &&
		previous !== undefined &&
		(next === undefined || next < previous)
		? current
		: incoming;
}

export function successfulFetchedAt(
	view: QuotaObservation,
): number | undefined {
	const read = view.presentation?.lastKnown ?? view.quota;
	if (read.state !== "available" || read.sections.length === 0)
		return undefined;
	const times = read.sections.flatMap((section) =>
		section.result.state === "available" ? [section.result.fetchedAt] : [],
	);
	return times.length === read.sections.length ? Math.min(...times) : undefined;
}

export type ClaudeUsageRequest = {
	/** Starts a fresh collection, hiding the previous value and superseding any in-flight one. */
	start(): void;
	/** Aborts the in-flight collection and ignores every late result. */
	cancel(): void;
};

/**
 * Page-local Claude Code request lifecycle. The full page starts one request
 * on mount and another on every refresh; overlapping requests are aborted and
 * generation-checked so only the newest result can be applied. Cancellation
 * (route unmount) also invalidates late results. Failure is applied as `null`,
 * which renders no card, never an error or stale figure.
 */
export function createClaudeUsageRequest(options: {
	collect(signal: AbortSignal): Promise<ClaudeUsage | null>;
	apply(usage: ClaudeUsage | null): void;
}): ClaudeUsageRequest {
	let inFlight: AbortController | undefined;
	let generation = 0;
	let cancelled = false;
	const start = (): void => {
		if (cancelled) return;
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		const request = ++generation;
		options.apply(null);
		void options.collect(controller.signal).then(
			(usage) => {
				if (cancelled || controller.signal.aborted || request !== generation)
					return;
				options.apply(usage);
			},
			() => {
				if (cancelled || controller.signal.aborted || request !== generation)
					return;
				options.apply(null);
			},
		);
	};
	return {
		start,
		cancel() {
			if (cancelled) return;
			cancelled = true;
			generation += 1;
			inFlight?.abort();
			inFlight = undefined;
		},
	};
}

const UNAVAILABLE_NOTE_PREFIX = "Usage unavailable for: ";

/**
 * Splits page cards into the card grid and one combined note. Only providers
 * whose read is `unsupported` or `not-applicable` move to the note; their
 * resolved display names are listed in input order. Every other card, including
 * pending, loading, transient-failure, and Claude Code cards, keeps its input
 * order. The `claude-agent` provider is left out of the note while the Claude
 * Code card is shown, since that card is its usage. Inputs are not mutated.
 */
export function partitionUsageCards(
	cards: UsagePageCard[],
	quotaByProvider: Record<string, QuotaRead>,
): { cards: UsagePageCard[]; unavailableNote: string | undefined } {
	const unavailable = (id: string) => {
		const state = quotaByProvider[id]?.state;
		return state === "unsupported" || state === "not-applicable";
	};
	const claudeShown = cards.some((card) => card.id === CLAUDE_CARD_ID);
	const names = cards
		.filter((card) => unavailable(card.id))
		.filter((card) => !(claudeShown && card.id === CLAUDE_AGENT_PROVIDER_ID))
		.map((card) => card.name);
	return {
		cards: cards.filter((card) => !unavailable(card.id)),
		unavailableNote:
			names.length === 0
				? undefined
				: `${UNAVAILABLE_NOTE_PREFIX}${names.join(", ")}`,
	};
}

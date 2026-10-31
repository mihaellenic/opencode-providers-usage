import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type { QuotaRead } from "../../src/core/contracts";
import type { UsagePageCard } from "../../src/ui/usage-page-model";
import {
	CLAUDE_USAGE_COUNTDOWN_REFRESH_MS,
	claudeCountdownRefreshMs,
	createClaudeUsageRequest,
	newestQuotaObservation,
	partitionUsageCards,
	successfulFetchedAt,
} from "../../src/ui/usage-shared";

const NOW = 1_800_000_000_000;
const CLAUDE_USAGE: ClaudeUsage = {
	session: { usedPercent: 10, resetsAt: NOW + 3_600_000 },
	week: { usedPercent: 20, resetsAt: NOW + 86_400_000 },
};
const CLAUDE_USAGE_LATER: ClaudeUsage = {
	session: { usedPercent: 30, resetsAt: NOW + 7_200_000 },
	week: { usedPercent: 40, resetsAt: NOW + 172_800_000 },
};

function unsupportedRead(): QuotaRead {
	return { state: "unsupported", reason: "unsupported", attemptedAt: 0 };
}

test("newer RPC metadata supersedes old pushes and identity reset cannot be rolled back", () => {
	const view = (revision: number) => ({
		quota: unsupportedRead(),
		presentation: { revision },
	});
	const oldPush = view(5);
	const recovery = view(6);
	const reset = view(7);
	expect(newestQuotaObservation(oldPush, recovery)).toBe(recovery);
	expect(newestQuotaObservation(recovery, oldPush)).toBe(recovery);
	expect(newestQuotaObservation(reset, recovery)).toBe(reset);
	expect(newestQuotaObservation(recovery, { quota: unsupportedRead() })).toBe(
		recovery,
	);
});

test("successfulFetchedAt is undefined without a complete available read", () => {
	expect(successfulFetchedAt({ quota: unsupportedRead() })).toBeUndefined();
});

describe("Claude Code request lifecycle", () => {
	type ClaudeCall = {
		signal: AbortSignal;
		resolve(usage: ClaudeUsage | null): void;
		reject(error: unknown): void;
	};

	function pendingClaude(calls: ClaudeCall[]) {
		return (signal: AbortSignal) =>
			new Promise<ClaudeUsage | null>((resolve, reject) => {
				calls.push({ signal, resolve, reject });
			});
	}

	function deferredPage() {
		const calls: ClaudeCall[] = [];
		const updates: (ClaudeUsage | null)[] = [];
		const request = createClaudeUsageRequest({
			collect: pendingClaude(calls),
			apply: (usage) => updates.push(usage),
		});
		return { calls, updates, request };
	}

	test("starts a fresh request on every page mount and cancels on unmount", async () => {
		const calls: ClaudeCall[] = [];
		const first = createClaudeUsageRequest({
			collect: pendingClaude(calls),
			apply: () => {},
		});
		first.start();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal.aborted).toBe(false);

		first.cancel();
		expect(calls[0]?.signal.aborted).toBe(true);
		first.start();
		expect(calls).toHaveLength(1);

		const second = createClaudeUsageRequest({
			collect: pendingClaude(calls),
			apply: () => {},
		});
		second.start();
		expect(calls).toHaveLength(2);
		second.cancel();
	});

	test("clears the previous value and ignores superseded results", async () => {
		const { calls, updates, request } = deferredPage();
		request.start();
		calls[0]?.resolve(CLAUDE_USAGE);
		await Promise.resolve();
		expect(updates).toEqual([null, CLAUDE_USAGE]);

		request.start();
		expect(updates.at(-1)).toBeNull();
		expect(calls[0]?.signal.aborted).toBe(true);
		calls[1]?.resolve(CLAUDE_USAGE_LATER);
		await Promise.resolve();
		expect(updates.at(-1)).toBe(CLAUDE_USAGE_LATER);
		calls[0]?.resolve(CLAUDE_USAGE);
		await Promise.resolve();
		expect(updates.at(-1)).toBe(CLAUDE_USAGE_LATER);
		request.cancel();
	});

	test("treats null, rejection, and missing-method rejection as no card", async () => {
		for (const failure of [
			(_signal: AbortSignal) => Promise.resolve<ClaudeUsage | null>(null),
			() => Promise.reject(new Error("collector failed")),
			() => Promise.reject(new Error("rpc.method_not_found")),
		]) {
			const updates: (ClaudeUsage | null)[] = [];
			const request = createClaudeUsageRequest({
				collect: failure,
				apply: (usage) => updates.push(usage),
			});
			request.start();
			await Promise.resolve();
			await Promise.resolve();
			expect(updates.every((usage) => usage === null)).toBe(true);
			expect(updates.at(-1)).toBeNull();
			request.cancel();
		}
	});

	test("cancellation after a request settles discards every late result", async () => {
		const { calls, updates, request } = deferredPage();
		request.start();
		request.cancel();
		calls[0]?.resolve(CLAUDE_USAGE);
		await Promise.resolve();
		expect(updates).toEqual([null]);
	});
});

test("countdown repaint cadence is bounded and adapts to seconds", () => {
	const week = { usedPercent: 20, resetsAt: NOW + 86_400_000 };
	expect(CLAUDE_USAGE_COUNTDOWN_REFRESH_MS).toBe(30_000);
	expect(
		claudeCountdownRefreshMs(
			{ session: { usedPercent: 10, resetsAt: NOW + 61_000 }, week },
			NOW,
		),
	).toBe(CLAUDE_USAGE_COUNTDOWN_REFRESH_MS);
	expect(
		claudeCountdownRefreshMs(
			{ session: { usedPercent: 10, resetsAt: NOW + 31_000 }, week },
			NOW,
		),
	).toBe(1_000);
	expect(
		claudeCountdownRefreshMs(
			{ session: { usedPercent: 10, resetsAt: NOW - 1 }, week },
			NOW,
		),
	).toBe(CLAUDE_USAGE_COUNTDOWN_REFRESH_MS);
	expect(
		claudeCountdownRefreshMs(
			{
				session: { usedPercent: 10, resetsAt: NOW - 1 },
				week: { usedPercent: 20, resetsAt: NOW - 1 },
			},
			NOW,
		),
	).toBeUndefined();
});

describe("partitionUsageCards", () => {
	const card = (id: string, name = id): UsagePageCard => ({
		id,
		name,
		lines: [],
	});
	const available: QuotaRead = {
		state: "available",
		authSource: "opencode",
		sections: [],
	};
	const transient: QuotaRead = {
		state: "unavailable",
		reason: "transport",
		attemptedAt: 0,
	};
	const notApplicable: QuotaRead = {
		state: "not-applicable",
		reason: "no_validated_quota_source",
		attemptedAt: 0,
	};

	test("moves unsupported and not-applicable cards into one combined note", () => {
		const cards = [
			card("zen", "OpenCode"),
			card("ollama", "Ollama Cloud"),
			card("openai", "OpenAI"),
		];
		const out = partitionUsageCards(cards, {
			zen: unsupportedRead(),
			ollama: notApplicable,
			openai: available,
		});
		expect(out.cards.map((c) => c.id)).toEqual(["openai"]);
		expect(out.unavailableNote).toBe(
			"Usage unavailable for: OpenCode, Ollama Cloud",
		);
	});

	test("note lists resolved names in input order, not state or map order", () => {
		const cards = [
			card("b", "Beta Custom"),
			card("a", "Alpha Custom"),
			card("c", "Gamma"),
		];
		const out = partitionUsageCards(cards, {
			a: notApplicable,
			c: available,
			b: unsupportedRead(),
		});
		expect(out.unavailableNote).toBe(
			"Usage unavailable for: Beta Custom, Alpha Custom",
		);
	});

	test("preserves every remaining card in input order", () => {
		const cards = [
			card("a"),
			card("u1"),
			card("b"),
			card("t"),
			card("c"),
			card("u2"),
		];
		const out = partitionUsageCards(cards, {
			a: available,
			u1: unsupportedRead(),
			b: available,
			t: transient,
			c: available,
			u2: notApplicable,
		});
		expect(out.cards.map((c) => c.id)).toEqual(["a", "b", "t", "c"]);
	});

	test("returns no note when no card is unavailable", () => {
		const cards = [card("a"), card("b")];
		const out = partitionUsageCards(cards, {
			a: available,
			b: transient,
		});
		expect(out.cards).toEqual(cards);
		expect(out.unavailableNote).toBeUndefined();
	});

	test("all-unavailable input yields no cards and a note", () => {
		const out = partitionUsageCards([card("a", "A"), card("b", "B")], {
			a: unsupportedRead(),
			b: notApplicable,
		});
		expect(out.cards).toEqual([]);
		expect(out.unavailableNote).toBe("Usage unavailable for: A, B");
	});

	test("empty input yields no cards and no note", () => {
		expect(partitionUsageCards([], {})).toEqual({
			cards: [],
			unavailableNote: undefined,
		});
	});

	test("missing reads stay visible as cards", () => {
		const cards = [card("pending", "Pending"), card("ok", "Ok")];
		const out = partitionUsageCards(cards, { ok: available });
		expect(out.cards.map((c) => c.id)).toEqual(["pending", "ok"]);
		expect(out.unavailableNote).toBeUndefined();
	});

	test("transient failures stay visible as cards", () => {
		const cards = [card("a"), card("b")];
		const out = partitionUsageCards(cards, {
			a: transient,
			b: { state: "auth-required", reason: "expired", attemptedAt: 0 },
		});
		expect(out.cards).toEqual(cards);
		expect(out.unavailableNote).toBeUndefined();
	});

	test("a Claude card without a quota-map entry stays a card", () => {
		const claude = card("claude-code", "Claude Code");
		const out = partitionUsageCards([card("zen", "OpenCode"), claude], {
			zen: unsupportedRead(),
		});
		expect(out.cards).toEqual([claude]);
		expect(out.unavailableNote).toBe("Usage unavailable for: OpenCode");
	});

	test("does not mutate its inputs", () => {
		const cards = [card("u", "U"), card("a", "A")];
		const quota: Record<string, QuotaRead> = {
			u: unsupportedRead(),
			a: available,
		};
		const cardsBefore = structuredClone(cards);
		const quotaBefore = structuredClone(quota);
		partitionUsageCards(cards, quota);
		expect(cards).toEqual(cardsBefore);
		expect(quota).toEqual(quotaBefore);
	});
});

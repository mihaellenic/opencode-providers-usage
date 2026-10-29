import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type { QuotaRead } from "../../src/core/contracts";
import type { UsagePageCard } from "../../src/ui/usage-page-model";
import {
	CLAUDE_USAGE_COUNTDOWN_REFRESH_MS,
	claudeCountdownRefreshMs,
	createClaudeUsageRequest,
	newestQuotaObservation,
	orderUsageCards,
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

describe("orderUsageCards", () => {
	const cards: UsagePageCard[] = ["a", "b", "c"].map((id) => ({
		id,
		name: id,
		lines: [],
	}));

	for (const state of ["unsupported", "not-applicable"] as const) {
		test(`moves ${state} cards last as full rows`, () => {
			const a: QuotaRead =
				state === "unsupported"
					? { state, reason: "unsupported", attemptedAt: 0 }
					: { state, reason: "not-applicable", attemptedAt: 0 };
			const out = orderUsageCards(cards, {
				a,
				b: { state: "unavailable", reason: "transport", attemptedAt: 0 },
				c: { state: "available", authSource: "opencode", sections: [] },
			});
			expect(out.map((e) => e.card.id)).toEqual(["b", "c", "a"]);
			expect(out.map((e) => e.fullRow)).toEqual([false, false, true]);
		});
	}

	test("a transient failure retains its relative position", () => {
		const out = orderUsageCards(cards, {
			a: { state: "unavailable", reason: "transport", attemptedAt: 0 },
			b: { state: "available", authSource: "opencode", sections: [] },
			c: { state: "unavailable", reason: "transport", attemptedAt: 0 },
		});
		expect(out.map((e) => e.card.id)).toEqual(["a", "b", "c"]);
		expect(out.map((e) => e.fullRow)).toEqual([false, false, false]);
	});
});

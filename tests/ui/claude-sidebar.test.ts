import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import {
	CLAUDE_SIDEBAR_FLOOR_MS,
	type ClaudeSidebarState,
	claudeSidebarModel,
	createClaudeSidebarController,
} from "../../src/ui/claude-sidebar";
import { buildUsagePageModel } from "../../src/ui/usage-page-model";

type Pending = {
	signal: AbortSignal;
	resolve(usage: ClaudeUsage | null): void;
	reject(error: unknown): void;
};

function usage(percent: number): ClaudeUsage {
	return {
		session: { usedPercent: percent, resetsAt: 0 },
		week: { usedPercent: percent, resetsAt: 0 },
	};
}

function harness() {
	let now = 1_800_000_000_000;
	const pending: Pending[] = [];
	const changes: ClaudeSidebarState[] = [];
	const controller = createClaudeSidebarController({
		collect: (signal) =>
			new Promise<ClaudeUsage | null>((resolve, reject) => {
				pending.push({ signal, resolve, reject });
			}),
		now: () => now,
		onChange: (state) => changes.push(state),
	});
	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return {
		controller,
		pending,
		changes,
		flush,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("claude sidebar controller", () => {
	test("select(true) starts one collection even when repeated and loading becomes ready", async () => {
		const h = harness();
		expect(h.controller.state()).toEqual({ status: "loading" });
		h.controller.select(true);
		h.controller.select(true);
		expect(h.pending).toHaveLength(1);
		h.pending[0]?.resolve(usage(10));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(10) });
		expect(h.changes).toEqual([{ status: "ready", usage: usage(10) }]);
		h.controller.dispose();
	});

	test("triggers respect the floor from attempt start and are single-flight", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(usage(1));
		await h.flush();
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS - 1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(1);
		h.advance(1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		h.pending[1]?.resolve(usage(2));
		await h.flush();
		h.controller.dispose();
	});

	test("triggers while inactive make no call", async () => {
		const h = harness();
		h.controller.trigger();
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.pending).toHaveLength(0);
		expect(h.changes).toEqual([]);
		h.controller.dispose();
	});

	test("a trigger refresh keeps the previous ready value until the new result arrives", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(usage(1));
		await h.flush();
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(1) });
		expect(h.changes).toHaveLength(1);
		h.pending[1]?.resolve(usage(2));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(2) });
		expect(h.changes).toHaveLength(2);
		h.controller.dispose();
	});

	test("null and rejected collections both fail and respect the floor", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(null);
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS - 1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(1);
		h.advance(1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		h.pending[1]?.reject(new Error("boom"));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.changes).toEqual([{ status: "failed" }]);
		h.controller.dispose();
	});

	test("select(false) aborts and drops late results; reselect resets and collects", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(usage(1));
		await h.flush();
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		const late = h.pending[1];
		expect(late?.signal.aborted).toBe(false);
		h.controller.select(false);
		expect(late?.signal.aborted).toBe(true);
		expect(h.controller.state()).toEqual({ status: "loading" });
		const changesBefore = h.changes.length;
		late?.resolve(usage(9));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "loading" });
		expect(h.changes).toHaveLength(changesBefore);
		h.controller.select(true);
		expect(h.pending).toHaveLength(3);
		expect(h.controller.state()).toEqual({ status: "loading" });
		h.pending[2]?.resolve(usage(3));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(3) });
		h.controller.dispose();
	});

	test("dispose aborts, ignores late results, blocks later calls, and is idempotent", async () => {
		const h = harness();
		h.controller.select(true);
		const first = h.pending[0];
		h.controller.dispose();
		h.controller.dispose();
		expect(first?.signal.aborted).toBe(true);
		first?.resolve(usage(5));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "loading" });
		expect(h.changes).toEqual([]);
		h.controller.select(true);
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.pending).toHaveLength(1);
	});
});

describe("claudeSidebarModel", () => {
	const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
	const LOCALE = { locale: "en-US", timeZone: "UTC" };
	const CLAUDE_USAGE: ClaudeUsage = {
		session: { usedPercent: 37, resetsAt: NOW + 11 * 3_600_000 + 7 * 60_000 },
		week: { usedPercent: 64, resetsAt: NOW + 4 * 86_400_000 + 2 * 3_600_000 },
	};

	test("ready lines match the page's Claude Code card exactly", () => {
		const page = buildUsagePageModel({
			providers: [],
			quotaByProvider: {},
			locale: LOCALE,
			now: NOW,
			claudeUsage: CLAUDE_USAGE,
		});
		const card = page.cards.find((item) => item.id === "claude-code");
		const model = claudeSidebarModel(
			{ status: "ready", usage: CLAUDE_USAGE },
			LOCALE,
			NOW,
		);

		expect(card).toBeDefined();
		expect(model.lines).toEqual(card?.lines ?? []);
		expect(model.lines).toHaveLength(2);
	});

	test("failed gives one muted unavailable line with no figures", () => {
		const model = claudeSidebarModel({ status: "failed" }, LOCALE, NOW);

		expect(model).toEqual({
			provider: "Claude Code",
			lines: [
				{
					id: "claude:unavailable",
					kind: "status",
					text: "Usage unavailable",
					tone: "muted",
				},
			],
		});
		expect(JSON.stringify(model)).not.toMatch(/[0-9%]/);
	});

	test("loading gives one muted checking line with no figures", () => {
		const model = claudeSidebarModel({ status: "loading" }, LOCALE, NOW);

		expect(model).toEqual({
			provider: "Claude Code",
			lines: [
				{
					id: "quota:pending",
					kind: "status",
					text: "Checking quota…",
					tone: "muted",
				},
			],
		});
		expect(JSON.stringify(model)).not.toMatch(/[0-9%]/);
	});

	test("ready model names the provider and carries the 5h and 7d rows", () => {
		const model = claudeSidebarModel(
			{ status: "ready", usage: CLAUDE_USAGE },
			LOCALE,
			NOW,
		);
		const labels = model.lines.map((line) =>
			line.kind === "window" ? line.label : "",
		);

		expect(model.provider).toBe("Claude Code");
		expect(labels).toEqual(["5h", "7d"]);
	});
});

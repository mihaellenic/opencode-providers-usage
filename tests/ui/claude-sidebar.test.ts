import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import {
	CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS,
	CLAUDE_SIDEBAR_FLOOR_MS,
	CLAUDE_SIDEBAR_RETRY_CAP_MS,
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

/** All windows already reset, so the figures describe no current period. */
function usage(percent: number): ClaudeUsage {
	return {
		session: { usedPercent: percent, resetsAt: 0 },
		week: { usedPercent: percent, resetsAt: 0 },
	};
}

/** Both windows reset in the future, i.e. the reading is still current. */
function liveUsage(now: number, percent: number): ClaudeUsage {
	return {
		session: { usedPercent: percent, resetsAt: now + 3_600_000 },
		week: { usedPercent: percent, resetsAt: now + 2 * 86_400_000 },
	};
}

type FakeTimer = {
	callback(): void;
	delay: number;
	at: number;
	cancelled: boolean;
	fired: boolean;
};

function harness() {
	let now = 1_800_000_000_000;
	const pending: Pending[] = [];
	const changes: ClaudeSidebarState[] = [];
	const timers: FakeTimer[] = [];
	const fired: number[] = [];
	const controller = createClaudeSidebarController({
		collect: (signal) =>
			new Promise<ClaudeUsage | null>((resolve, reject) => {
				pending.push({ signal, resolve, reject });
			}),
		now: () => now,
		onChange: (state) => changes.push(state),
		setTimer: (callback, delay) => {
			const timer: FakeTimer = {
				callback,
				delay,
				at: now + delay,
				cancelled: false,
				fired: false,
			};
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			(handle as FakeTimer).cancelled = true;
		},
	});
	const pendingTimers = () =>
		timers.filter((timer) => !timer.cancelled && !timer.fired);
	const fire = (timer: FakeTimer) => {
		timer.fired = true;
		fired.push(timer.delay);
		timer.callback();
	};
	const byDeadline = (a: FakeTimer, b: FakeTimer) =>
		a.at - b.at || timers.indexOf(a) - timers.indexOf(b);
	const fireDue = () => {
		for (;;) {
			const due = pendingTimers()
				.filter((timer) => timer.at <= now)
				.sort(byDeadline)[0];
			if (due === undefined) return;
			fire(due);
		}
	};
	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return {
		controller,
		pending,
		changes,
		flush,
		now: () => now,
		/** Moves the clock forward and fires every timer that falls due. */
		advance: (ms: number) => {
			now += ms;
			fireDue();
		},
		/** Moves the clock without firing timers, to reach a floor first. */
		jump: (ms: number) => {
			now += ms;
		},
		/** Fires the earliest pending timer at the current clock. */
		fireNext: () => {
			const next = pendingTimers().sort(byDeadline)[0];
			if (next !== undefined) fire(next);
			return next?.delay;
		},
		pendingTimers,
		pendingDelays: () => pendingTimers().map((timer) => timer.delay),
		firedDelays: () => [...fired],
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
		expect(h.pendingDelays()).toEqual([5_000]);
		// The 5s retry lands inside the floor window and owns the slot.
		h.advance(4_999);
		expect(h.pending).toHaveLength(1);
		h.advance(1);
		expect(h.pending).toHaveLength(2);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		h.pending[1]?.reject(new Error("boom"));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.changes).toEqual([{ status: "failed" }]);
		expect(h.pendingDelays()).toEqual([15_000]);
		// The floor is measured from the retried attempt's start, not the first.
		h.jump(CLAUDE_SIDEBAR_FLOOR_MS - 1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		h.jump(1);
		h.controller.trigger();
		expect(h.pending).toHaveLength(3);
		expect(h.pendingDelays()).toEqual([CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS]);
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

	test("failures retry at 5s, 15s, 30s, then 60s, and a success resets the backoff", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(null);
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });

		for (const delay of [5_000, 15_000, 30_000, 60_000, 60_000]) {
			expect(h.pendingDelays()).toEqual([delay]);
			expect(h.pendingTimers()).toHaveLength(1);
			const before = h.pending.length;
			h.advance(delay);
			expect(h.pending).toHaveLength(before + 1);
			h.pending[before]?.resolve(null);
			await h.flush();
			expect(h.controller.state()).toEqual({ status: "failed" });
		}

		// Success clears the retry and resets the backoff.
		expect(h.pendingDelays()).toEqual([CLAUDE_SIDEBAR_RETRY_CAP_MS]);
		const beforeSuccess = h.pending.length;
		h.advance(CLAUDE_SIDEBAR_RETRY_CAP_MS);
		h.pending[beforeSuccess]?.resolve(usage(20));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(20) });
		expect(h.pendingTimers()).toHaveLength(0);

		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.pending).toHaveLength(beforeSuccess + 2);
		h.pending[beforeSuccess + 1]?.resolve(null);
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.pendingDelays()).toEqual([5_000]);
		h.controller.dispose();
	});

	test("a failure keeps the last figures while one of their windows is live", async () => {
		const h = harness();
		h.controller.select(true);
		const reading = liveUsage(h.now(), 42);
		h.pending[0]?.resolve(reading);
		await h.flush();
		const onChange = h.changes.length;

		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		h.pending[1]?.resolve(null);
		await h.flush();

		expect(h.controller.state()).toEqual({ status: "ready", usage: reading });
		expect(h.changes).toHaveLength(onChange);
		expect(h.changes.some((state) => state.status === "failed")).toBe(false);
		expect(h.pendingDelays()).toEqual([5_000]);
		h.controller.dispose();
	});

	test("a failure drops to unavailable once every window of the last reading has reset", async () => {
		const h = harness();
		h.controller.select(true);
		const reading = liveUsage(h.now(), 42);
		h.pending[0]?.resolve(reading);
		await h.flush();

		h.advance(2 * 86_400_000 + 1);
		h.controller.trigger();
		h.pending[1]?.resolve(null);
		await h.flush();

		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.changes.at(-1)).toEqual({ status: "failed" });
		h.controller.dispose();
	});

	test("the watchdog aborts a hung attempt so retries and triggers can collect again", async () => {
		const h = harness();
		h.controller.select(true);
		const hung = h.pending[0];
		expect(h.pendingDelays()).toEqual([CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS]);

		h.advance(CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS - 1);
		expect(hung?.signal.aborted).toBe(false);
		expect(h.pending).toHaveLength(1);
		h.advance(1);
		expect(hung?.signal.aborted).toBe(true);
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.pendingDelays()).toEqual([5_000]);

		// A late reply from the aborted attempt is dropped.
		hung?.resolve(usage(99));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.pending).toHaveLength(1);

		// The retry is not blocked by the stuck attempt.
		h.advance(5_000);
		expect(h.pending).toHaveLength(2);
		const retried = h.pending[1];
		expect(retried?.signal.aborted).toBe(false);
		retried?.resolve(usage(50));
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "ready", usage: usage(50) });

		// Nor is a later trigger.
		h.advance(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.pending).toHaveLength(3);
		h.controller.dispose();
	});

	test("select(false) and dispose cancel retry and watchdog timers and reset the backoff", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(null);
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.pendingDelays()).toEqual([5_000]);

		h.controller.select(false);
		expect(h.pendingTimers()).toHaveLength(0);
		h.advance(5_000);
		expect(h.pending).toHaveLength(1);
		expect(h.controller.state()).toEqual({ status: "loading" });

		// Reselecting cancels nothing stale and starts clean: one attempt, one
		// watchdog, and the next failure waits 5s again.
		h.controller.select(true);
		expect(h.pending).toHaveLength(2);
		expect(h.pendingDelays()).toEqual([CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS]);
		expect(h.pending[1]?.signal.aborted).toBe(false);
		h.pending[1]?.resolve(null);
		await h.flush();
		expect(h.controller.state()).toEqual({ status: "failed" });
		expect(h.pendingDelays()).toEqual([5_000]);

		h.controller.dispose();
		expect(h.pendingTimers()).toHaveLength(0);

		// Deselecting a hung attempt also cancels its watchdog.
		const hungHarness = harness();
		hungHarness.controller.select(true);
		expect(hungHarness.pendingDelays()).toEqual([
			CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS,
		]);
		hungHarness.controller.select(false);
		expect(hungHarness.pendingTimers()).toHaveLength(0);
		expect(hungHarness.pending[0]?.signal.aborted).toBe(true);
		hungHarness.controller.dispose();
	});

	test("retries are single-flight and never run while inactive", async () => {
		const h = harness();
		h.controller.select(true);
		h.pending[0]?.resolve(null);
		await h.flush();
		expect(h.pendingDelays()).toEqual([5_000]);

		// A manual collection takes the slot and cancels the pending retry, so
		// the two never overlap.
		h.jump(CLAUDE_SIDEBAR_FLOOR_MS);
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		expect(h.pendingDelays()).toEqual([CLAUDE_SIDEBAR_ATTEMPT_TIMEOUT_MS]);
		h.pending[1]?.resolve(null);
		await h.flush();
		expect(h.pendingDelays()).toEqual([15_000]);

		// A trigger before the floor starts nothing and leaves the retry alone.
		h.controller.trigger();
		expect(h.pending).toHaveLength(2);
		expect(h.pendingDelays()).toEqual([15_000]);

		// The retry fires into an empty slot and starts exactly one collection
		// that a trigger cannot join.
		h.advance(15_000);
		expect(h.pending).toHaveLength(3);
		h.controller.trigger();
		expect(h.pending).toHaveLength(3);
		expect(h.pending[2]?.signal.aborted).toBe(false);

		// Once inactive, the retry is cancelled and never collects.
		h.controller.select(false);
		expect(h.pendingTimers()).toHaveLength(0);
		h.advance(CLAUDE_SIDEBAR_RETRY_CAP_MS);
		expect(h.pending).toHaveLength(3);
		h.controller.dispose();
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

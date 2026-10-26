import { describe, expect, test } from "bun:test";
import { createActivityRefreshDriver } from "../../src/ui/activity-refresh";

function harness() {
	let now = 1_800_000_000_000;
	let sequence = 0;
	const timers = new Map<number, { at: number; callback(): void }>();
	const calls: string[] = [];
	let request: () => Promise<void> = async () => {};
	const driver = createActivityRefreshDriver({
		now: () => now,
		refresh: async (providerID) => {
			calls.push(providerID);
			await request();
		},
		setTimer: (callback, delay) => {
			const id = ++sequence;
			timers.set(id, { at: now + delay, callback });
			return id;
		},
		clearTimer: (id) => timers.delete(id as number),
	});
	const advance = async (ms: number) => {
		const target = now + ms;
		for (;;) {
			const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > target) break;
			now = next[1].at;
			timers.delete(next[0]);
			next[1].callback();
			for (let i = 0; i < 20; i++) await Promise.resolve();
		}
		now = target;
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return {
		driver,
		calls,
		advance,
		now: () => now,
		timers,
		request: (run: () => Promise<void>) => {
			request = run;
		},
	};
}

describe("activity refresh", () => {
	test("a completion during an initial read waits for settlement then refreshes once", async () => {
		const h = harness();
		const endInitial = h.driver.begin("a");
		await h.advance(1_000);
		h.driver.completed("a");
		await h.advance(4_000);
		expect(h.calls).toEqual([]);
		h.driver.observe("a", h.now() - 5_000, 1);
		endInitial();
		endInitial();
		await h.advance(14_999);
		expect(h.calls).toEqual([]);
		await h.advance(1);
		expect(h.calls).toEqual(["a"]);
		await h.advance(3_600_000);
		expect(h.calls).toEqual(["a"]);
		h.driver.dispose();
	});
	test("a new server retry revision starts a floor but rereading that failure does not", async () => {
		const h = harness();
		const fetchedAt = h.now();
		h.driver.observe("a", fetchedAt, 1);
		await h.advance(61_000);
		h.driver.observe("a", fetchedAt, 2);
		h.driver.completed("a");
		await h.advance(10_000);
		h.driver.observe("a", fetchedAt, 2);
		expect(h.calls).toEqual([]);
		await h.advance(5_000);
		expect(h.calls).toEqual(["a"]);
		h.driver.dispose();
	});
	test("a settling initial read moves an already queued request behind the floor", async () => {
		const h = harness();
		h.driver.activity("a");
		h.driver.observe("a", h.now() - 80_000);
		await h.advance(0);
		expect(h.calls).toEqual([]);
		await h.advance(15_000);
		expect(h.calls).toEqual(["a"]);
		h.driver.dispose();
	});
	test("fresh inputs do nothing; old inputs coalesce; an idle hour does not fetch", async () => {
		const h = harness();
		h.driver.observe("a", h.now());
		await h.advance(59_999);
		h.driver.activity("a");
		await h.advance(0);
		expect(h.calls).toEqual([]);
		await h.advance(1);
		for (let i = 0; i < 100; i++) h.driver.activity("a");
		await h.advance(0);
		expect(h.calls).toEqual(["a"]);
		await h.advance(3_600_000);
		expect(h.calls).toEqual(["a"]);
		h.driver.dispose();
	});

	test("completion inside floor gets exactly one trailing refresh shared with inputs", async () => {
		const h = harness();
		h.driver.activity("a");
		await h.advance(0);
		await h.advance(1_000);
		for (let i = 0; i < 100; i++) {
			h.driver.completed("a");
			h.driver.activity("a");
		}
		await h.advance(13_999);
		expect(h.calls).toEqual(["a"]);
		await h.advance(1);
		expect(h.calls).toEqual(["a", "a"]);
		await h.advance(60_000);
		expect(h.calls).toHaveLength(2);
		h.driver.dispose();
	});

	test("in-flight ordinary input is absorbed but completions get one trailing request", async () => {
		const h = harness();
		let finish: () => void = () => {};
		h.request(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		h.driver.activity("a");
		await h.advance(0);
		for (let i = 0; i < 100; i++) {
			h.driver.completed("a");
			h.driver.activity("a");
		}
		await h.advance(20_000);
		expect(h.calls).toHaveLength(1);
		finish();
		h.request(async () => {});
		await h.advance(0);
		await h.advance(0);
		expect(h.calls).toEqual(["a", "a"]);
		h.driver.dispose();
	});

	test("transport rejection has no client retry and providers are independent", async () => {
		const h = harness();
		h.request(async () => {
			throw new Error("transport");
		});
		h.driver.completed("a");
		h.driver.activity("b");
		await h.advance(0);
		expect(h.calls).toEqual(["a", "b"]);
		await h.advance(3_600_000);
		expect(h.calls).toHaveLength(2);
		h.driver.dispose();
	});

	test("observing the same snapshot does not postpone a completion; dispose cancels late work", async () => {
		const h = harness();
		const fetchedAt = h.now();
		h.driver.observe("a", fetchedAt);
		h.driver.completed("a");
		await h.advance(10_000);
		h.driver.observe("a", fetchedAt);
		await h.advance(5_000);
		expect(h.calls).toEqual(["a"]);
		h.driver.completed("a");
		h.driver.dispose();
		h.driver.activity("b");
		h.driver.completed("b");
		await h.advance(60_000);
		expect(h.calls).toEqual(["a"]);
		expect(h.timers.size).toBe(0);
	});
});

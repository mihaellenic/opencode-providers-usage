import { describe, expect, test } from "bun:test";
import { fakeClock, fakeRpc, fakeSession } from "./fakes";

describe("fakeClock", () => {
	test("advance(299_999) fires nothing, advance(1) fires one", () => {
		const clock = fakeClock();
		let fired = 0;
		clock.setTimer(() => {
			fired += 1;
		}, 300_000);
		clock.advance(299_999);
		expect(fired).toBe(0);
		expect(clock.pending()).toBe(1);
		clock.advance(1);
		expect(fired).toBe(1);
		expect(clock.pending()).toBe(0);
	});

	test("wall clock moves first and new timers are relative to it", () => {
		const clock = fakeClock();
		const seen: number[] = [];
		clock.setTimer(() => {
			seen.push(clock.now());
			clock.setTimer(() => seen.push(clock.now()), 10);
		}, 5);
		clock.advance(100);
		expect(seen).toEqual([100]);
		expect(clock.pending()).toBe(1);
		clock.advance(10);
		expect(seen).toEqual([100, 110]);
	});

	test("canceled timers never execute, even when canceled by a due callback", () => {
		const clock = fakeClock();
		let fired = 0;
		const later = clock.setTimer(() => {
			fired += 1;
		}, 20);
		clock.setTimer(() => clock.clearTimer(later), 10);
		clock.advance(50);
		expect(fired).toBe(0);
	});
});

describe("fakeRpc", () => {
	test("records calls in order", async () => {
		const rpc = fakeRpc();
		const signal = new AbortController().signal;
		const ref = { providerID: "p" } as never;
		const a = rpc.list(signal);
		const b = rpc.claudeCodeUsage(signal);
		expect(rpc.calls.map((call) => call.method)).toEqual([
			"list",
			"claudeCodeUsage",
		]);
		rpc.resolve("claudeCodeUsage", null);
		expect(await b).toBeNull();
		rpc.reject("list", new Error("x"));
		await expect(a).rejects.toThrow("x");
		void ref;
	});

	test("settles the oldest matching call and keeps hung ones pending", async () => {
		const rpc = fakeRpc();
		const controller = new AbortController();
		const first = rpc.claudeCodeUsage(controller.signal);
		const second = rpc.claudeCodeUsage(new AbortController().signal);
		rpc.hang("claudeCodeUsage");
		controller.abort();
		rpc.resolve("claudeCodeUsage", null);
		expect(await first).toBeNull();
		let settled = false;
		void second.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		rpc.resolve("claudeCodeUsage", null);
		expect(await second).toBeNull();
		expect(() => rpc.resolve("claudeCodeUsage", null)).toThrow();
	});

	test("emitUpdated reaches only subscribed handlers", () => {
		const rpc = fakeRpc();
		const got: unknown[] = [];
		const off = rpc.onUpdated((e) => got.push(e));
		const event = { providerID: "p" } as never;
		rpc.emitUpdated(event);
		off();
		rpc.emitUpdated(event);
		expect(got).toEqual([event]);
	});
});

describe("fakeSession", () => {
	test("tracks provider, visibility and activity with real unsubscribe", () => {
		const session = fakeSession("s1");
		expect(session.sessionID).toBe("s1");
		expect(session.visible()).toBe(true);
		let models = 0;
		const visibility: boolean[] = [];
		const activity: string[] = [];
		const offModel = session.onSelectedModel(() => {
			models += 1;
		});
		const offVisible = session.onVisible((v) => visibility.push(v));
		const offActivity = session.onActivity((e) => activity.push(e.kind));
		session.setProvider("anthropic");
		expect(session.selectedProviderID()).toBe("anthropic");
		session.setVisible(false);
		session.emit({ kind: "input" });
		offModel();
		offVisible();
		offActivity();
		session.setProvider(undefined);
		session.setVisible(true);
		session.emit({ kind: "focus" });
		expect(models).toBe(1);
		expect(visibility).toEqual([false]);
		expect(activity).toEqual(["input"]);
		expect(session.visible()).toBe(true);
		expect(session.selectedProviderID()).toBeUndefined();
	});
});

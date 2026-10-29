import { describe, expect, test } from "bun:test";
import {
	createIdleScheduler,
	IDLE_REFRESH_MS,
} from "../../src/gui/idle-refresh";
import { fakeClock } from "./fakes";

function harness() {
	const clock = fakeClock();
	let fired = 0;
	const scheduler = createIdleScheduler({
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		fire: () => {
			fired += 1;
		},
	});
	return {
		clock,
		scheduler,
		fired: () => fired,
	};
}

describe("idle scheduler", () => {
	test("exports the five minute idle interval", () => {
		expect(IDLE_REFRESH_MS).toBe(300_000);
	});

	test("fires exactly at the 300000 ms boundary and then every 300000 ms", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(299_999);
		expect(fired()).toBe(0);
		clock.advance(1);
		expect(fired()).toBe(1);
		clock.advance(300_000);
		expect(fired()).toBe(2);
	});

	test("input() at 200000 moves the first fire to 500000", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(200_000);
		scheduler.input();
		clock.advance(299_999);
		expect(fired()).toBe(0);
		clock.advance(1);
		expect(fired()).toBe(1);
	});

	test("input() at exactly the deadline minus one resets the window from the input time", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(299_999);
		scheduler.input();
		clock.advance(1);
		expect(fired()).toBe(0);
		clock.advance(299_999);
		expect(fired()).toBe(1);
	});

	test("hide() leaves no pending timer and never fires", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		scheduler.hide();
		expect(clock.pending()).toBe(0);
		clock.advance(900_000);
		expect(fired()).toBe(0);
	});

	test("input() while hidden does not arm a timer", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.input();
		expect(clock.pending()).toBe(0);
		scheduler.show();
		scheduler.hide();
		scheduler.input();
		expect(clock.pending()).toBe(0);
		clock.advance(900_000);
		expect(fired()).toBe(0);
	});

	test("show() after hide() starts a fresh window", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(100_000);
		scheduler.hide();
		clock.advance(50_000);
		scheduler.show();
		clock.advance(299_999);
		expect(fired()).toBe(0);
		clock.advance(1);
		expect(fired()).toBe(1);
	});

	test("repeated show() while shown does not postpone the existing deadline", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(200_000);
		scheduler.show();
		expect(clock.pending()).toBe(1);
		clock.advance(99_999);
		expect(fired()).toBe(0);
		clock.advance(1);
		expect(fired()).toBe(1);
	});

	test("dispose() clears the timer and ignores later input, show and reschedule", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		scheduler.dispose();
		expect(clock.pending()).toBe(0);
		scheduler.input();
		scheduler.show();
		scheduler.reschedule();
		expect(clock.pending()).toBe(0);
		clock.advance(900_000);
		expect(fired()).toBe(0);
	});

	test("an overdue timer after a long sleep fires exactly once and the next fire is 300000 ms later", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(3_600_000);
		expect(fired()).toBe(1);
		expect(clock.pending()).toBe(1);
		clock.advance(299_999);
		expect(fired()).toBe(1);
		clock.advance(1);
		expect(fired()).toBe(2);
		expect(clock.pending()).toBe(1);
	});

	test("reschedule() resets the window", () => {
		const { clock, scheduler, fired } = harness();
		scheduler.show();
		clock.advance(200_000);
		scheduler.reschedule();
		clock.advance(299_999);
		expect(fired()).toBe(0);
		clock.advance(1);
		expect(fired()).toBe(1);
	});

	test("hide() inside fire() stops the next window", () => {
		const clock = fakeClock();
		let fired = 0;
		const scheduler = createIdleScheduler({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			fire: () => {
				fired += 1;
				scheduler.hide();
			},
		});
		scheduler.show();
		clock.advance(300_000);
		expect(fired).toBe(1);
		expect(clock.pending()).toBe(0);
		clock.advance(900_000);
		expect(fired).toBe(1);
	});
});

export const IDLE_REFRESH_MS = 300_000;

export type IdleScheduler = {
	show(): void;
	hide(): void;
	input(): void;
	reschedule(): void;
	dispose(): void;
};

export function createIdleScheduler(deps: {
	now(): number;
	setTimer(cb: () => void, ms: number): unknown;
	clearTimer(h: unknown): void;
	/** Controller decides what to refresh. Called once per expired window. */
	fire(): void;
}): IdleScheduler {
	let shown = false;
	let disposed = false;
	let handle: unknown;
	let armed = false;

	const cancel = (): void => {
		if (!armed) return;
		deps.clearTimer(handle);
		armed = false;
		handle = undefined;
	};

	const arm = (): void => {
		cancel();
		// Each arm is a fresh window starting now. Expired windows are not replayed.
		handle = deps.setTimer(() => {
			armed = false;
			handle = undefined;
			deps.fire();
			// fire() may have hidden, disposed, reset, or re-armed the scheduler.
			if (shown && !disposed && !armed) arm();
		}, IDLE_REFRESH_MS);
		armed = true;
	};

	return {
		show() {
			if (disposed || shown) return;
			shown = true;
			arm();
		},
		hide() {
			if (disposed) return;
			shown = false;
			cancel();
		},
		input() {
			if (disposed || !shown) return;
			arm();
		},
		reschedule() {
			if (disposed || !shown) return;
			arm();
		},
		dispose() {
			disposed = true;
			shown = false;
			cancel();
		},
	};
}

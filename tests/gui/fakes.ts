import type { HostActivity, SessionHost, UsageRpc } from "../../src/gui/host";
import type { QuotaUpdatedEvent } from "../../src/rpc";

type Timer = { id: number; due: number; cb: () => void; canceled: boolean };

/** Deterministic clock. `advance` moves wall time first, then runs due timers. */
export function fakeClock() {
	let time = 0;
	let nextId = 0;
	let timers: Timer[] = [];
	return {
		now: () => time,
		setTimer(cb: () => void, ms: number): unknown {
			const timer: Timer = {
				id: nextId++,
				due: time + ms,
				cb,
				canceled: false,
			};
			timers.push(timer);
			return timer;
		},
		clearTimer(handle: unknown): void {
			const timer = timers.find((candidate) => candidate === handle);
			if (timer === undefined) return;
			timer.canceled = true;
			timers = timers.filter((candidate) => candidate !== timer);
		},
		advance(ms: number): void {
			time += ms;
			// Snapshot: timers scheduled by callbacks wait for a later advance.
			const due = timers
				.filter((timer) => timer.due <= time)
				.sort((a, b) => a.due - b.due || a.id - b.id);
			for (const timer of due) {
				if (timer.canceled) continue;
				timers = timers.filter((candidate) => candidate !== timer);
				timer.cb();
			}
		},
		pending: () => timers.length,
	};
}

type PendingCall = {
	method: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
};

/**
 * Queued fake RPC. `resolve`/`reject` settle the oldest unsettled call of a
 * method, whether or not its signal aborted: the controller under test must
 * prove its own stale-result guards. `hang` asserts a call is left pending.
 */
export function fakeRpc(): UsageRpc & {
	calls: { method: string; args: unknown[] }[];
	resolve(method: string, value: unknown): void;
	reject(method: string, error: unknown): void;
	hang(method: string): void;
	emitUpdated(e: QuotaUpdatedEvent): void;
} {
	const calls: { method: string; args: unknown[] }[] = [];
	const pending: PendingCall[] = [];
	const handlers = new Set<(event: QuotaUpdatedEvent) => void>();

	const request = <T>(method: string, args: unknown[]): Promise<T> => {
		calls.push({ method, args });
		return new Promise<T>((resolve, reject) => {
			pending.push({
				method,
				// The test supplies the value for the method under test.
				resolve: (value) => resolve(value as T),
				reject,
			});
		});
	};
	const take = (method: string): PendingCall => {
		const index = pending.findIndex((call) => call.method === method);
		const call = pending[index];
		if (call === undefined) throw new Error(`no pending ${method} call`);
		pending.splice(index, 1);
		return call;
	};

	return {
		calls,
		list: (signal) => request("list", [signal]),
		get: (ref, signal) => request("get", [ref, signal]),
		refresh: (ref, signal) => request("refresh", [ref, signal]),
		claudeCodeUsage: (signal) => request("claudeCodeUsage", [signal]),
		onUpdated(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		resolve: (method, value) => take(method).resolve(value),
		reject: (method, error) => take(method).reject(error),
		hang(method) {
			if (!pending.some((call) => call.method === method))
				throw new Error(`no pending ${method} call to hang`);
		},
		emitUpdated(event) {
			for (const handler of [...handlers]) handler(event);
		},
	};
}

export function fakeSession(id: string): SessionHost & {
	setProvider(id?: string): void;
	setVisible(v: boolean): void;
	emit(e: HostActivity): void;
} {
	let provider: string | undefined;
	let visible = true;
	const models = new Set<() => void>();
	const visibility = new Set<(visible: boolean) => void>();
	const activity = new Set<(event: HostActivity) => void>();
	return {
		sessionID: id,
		selectedProviderID: () => provider,
		onSelectedModel(handler) {
			models.add(handler);
			return () => {
				models.delete(handler);
			};
		},
		visible: () => visible,
		onVisible(handler) {
			visibility.add(handler);
			return () => {
				visibility.delete(handler);
			};
		},
		onActivity(handler) {
			activity.add(handler);
			return () => {
				activity.delete(handler);
			};
		},
		setProvider(next) {
			provider = next;
			for (const handler of [...models]) handler();
		},
		setVisible(next) {
			visible = next;
			for (const handler of [...visibility]) handler(next);
		},
		emit(event) {
			for (const handler of [...activity]) handler(event);
		},
	};
}

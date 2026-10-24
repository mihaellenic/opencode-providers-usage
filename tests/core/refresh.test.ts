import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CoordinatorDeps,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
	ResolvedQuotaSource,
} from "../../src/core/contracts";
import { createQuotaCoordinator } from "../../src/core/refresh";
import { setupQuotaServer } from "../../src/index";
import type { QuotaUpdatedEvent } from "../../src/rpc";
import { type QuotaTuiContext, subscribeQuotaUpdates } from "../../src/tui";

const NOW = 1_800_000_000_000;
const POLL_MS = 60_000;
const FLOOR_MS = 15_000;
const MAX_AGE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 10_000;

type TimerHandle = { at: number; callback: () => void };

/** Resolves after every queued microtask has run. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeClock(start = NOW) {
	let now = start;
	let nextHandle = 1;
	const timers = new Map<number, TimerHandle>();
	const scheduled: number[] = [];

	function setTimer(callback: () => void, delayMs: number): unknown {
		const handle = nextHandle++;
		timers.set(handle, { at: now + delayMs, callback });
		scheduled.push(delayMs);
		return handle;
	}

	function clearTimer(handle: unknown): void {
		if (typeof handle === "number") {
			timers.delete(handle);
		}
	}

	async function advance(ms: number): Promise<void> {
		const target = now + ms;
		await settle();
		for (;;) {
			let next: [number, TimerHandle] | undefined;
			for (const candidate of timers) {
				if (
					candidate[1].at <= target &&
					(next === undefined || candidate[1].at < next[1].at)
				) {
					next = candidate;
				}
			}
			if (next === undefined) {
				break;
			}
			timers.delete(next[0]);
			now = Math.max(now, next[1].at);
			next[1].callback();
			await settle();
		}
		now = target;
		await settle();
	}

	return {
		advance,
		clearTimer,
		now: () => now,
		pending: () => timers.size,
		scheduled,
		setTimer,
	};
}

function windowMetric(
	overrides: Partial<Extract<QuotaMetric, { kind: "window" }>> = {},
): QuotaMetric {
	const id = overrides.id ?? "metric-a";
	return {
		kind: "window",
		id,
		scope: "provider-balance",
		label: "Window",
		windowSeconds: 3_600,
		remainingPercent: 42,
		usedPercent: 58,
		...overrides,
	};
}

function availableSection(
	fetchedAt: number,
	options: {
		expiresAt?: number;
		remaining?: number;
		resetsAt?: number;
		scope?: QuotaScope;
		id?: string;
	} = {},
) {
	const remaining = options.remaining ?? 42;
	return {
		scope: options.scope ?? "provider-balance",
		result: {
			state: "available" as const,
			metrics: [
				windowMetric({
					id: options.id ?? "metric-a",
					scope: options.scope ?? "provider-balance",
					remainingPercent: remaining,
					usedPercent: 100 - remaining,
					...(options.resetsAt === undefined
						? {}
						: { resetsAt: options.resetsAt }),
				}),
			],
			fetchedAt,
			expiresAt: options.expiresAt ?? fetchedAt + POLL_MS,
		},
	};
}

function availableRead(
	fetchedAt: number,
	options: {
		expiresAt?: number;
		remaining?: number;
		resetsAt?: number;
	} = {},
): QuotaRead {
	return {
		state: "available",
		authSource: "opencode",
		sections: [availableSection(fetchedAt, options)],
	};
}

function unavailableRead(
	attemptedAt: number,
	reason: string,
	retryAfterMs?: number,
): QuotaRead {
	return {
		state: reason === "companion_expired" ? "auth-required" : "unavailable",
		reason,
		attemptedAt,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

function metrics(read: QuotaRead): QuotaMetric[] {
	if (!("sections" in read)) {
		return [];
	}
	return read.sections.flatMap((section) =>
		section.result.state === "available" ? section.result.metrics : [],
	);
}

function moneyRemaining(read: QuotaRead): number | undefined {
	const metric = metrics(read)[0];
	return metric?.kind === "money" ? metric.remaining : undefined;
}

function remainingPercents(read: QuotaRead): number[] {
	return metrics(read).flatMap((metric) =>
		metric.kind === "window" && metric.remainingPercent !== undefined
			? [metric.remainingPercent]
			: [],
	);
}

function availableScopes(read: QuotaRead): QuotaScope[] {
	if (!("sections" in read)) {
		return [];
	}
	return read.sections
		.filter((section) => section.result.state === "available")
		.map((section) => section.scope);
}

function source(options: {
	identityKey: string;
	read(signal: AbortSignal): Promise<QuotaRead>;
	isCurrent?(): Promise<boolean>;
}): ResolvedQuotaSource {
	return {
		identityKey: options.identityKey,
		read: options.read,
		isCurrent: options.isCurrent ?? (async () => true),
	};
}

function harness(initial: (providerID: string) => ResolvedQuotaSource) {
	const clock = fakeClock();
	let current = initial;
	const counts = { resolves: 0, requests: 0 };
	const deps: CoordinatorDeps = {
		now: clock.now,
		async resolve(providerID) {
			counts.resolves += 1;
			return current(providerID);
		},
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	};
	const coordinator = createQuotaCoordinator(deps);
	return {
		clock,
		coordinator,
		counts,
		setCurrent(next: (providerID: string) => ResolvedQuotaSource) {
			current = next;
		},
	};
}

function pollDelays(scheduled: number[]): number[] {
	return scheduled.filter((delay) => delay >= POLL_MS);
}

describe("quota refresh lifecycle", () => {
	test("two_views_share_one_request", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return availableRead(NOW);
				},
			}),
		);

		const sidebar: QuotaRead[] = [];
		const page: QuotaRead[] = [];
		const disposeSidebar = coordinator.watch("alpha", (value) =>
			sidebar.push(value),
		);
		const disposePage = coordinator.watch("alpha", (value) => page.push(value));
		await settle();

		expect(requests).toBe(1);
		expect(sidebar.at(-1)).toEqual(availableRead(NOW));
		expect(page.at(-1)).toEqual(availableRead(NOW));

		// One provider poll serves both views; neither view owns a timer.
		await clock.advance(POLL_MS);
		expect(requests).toBe(2);
		expect(sidebar).toHaveLength(2);
		expect(page).toHaveLength(2);

		disposeSidebar();
		disposePage();
		coordinator.dispose();
	});

	test("manual_refresh_respects_fifteen_second_floor", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return availableRead(NOW);
				},
			}),
		);

		const first = await coordinator.refresh("alpha");
		expect(requests).toBe(1);

		await clock.advance(14_999);
		const cached = await coordinator.refresh("alpha");
		expect(requests).toBe(1);
		expect(cached).toEqual(first);

		await clock.advance(1);
		await coordinator.refresh("alpha");
		expect(requests).toBe(2);

		coordinator.dispose();
	});

	test("ninety_second_old_values_are_not_current", async () => {
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					// Deliberately outlives the poll window so the 90s cache
					// limit itself is exercised, not the adapter expiry.
					return availableRead(NOW, { expiresAt: NOW + 600_000 });
				},
			}),
		);

		await coordinator.refresh("alpha");
		await clock.advance(MAX_AGE_MS - 1);
		expect(metrics(coordinator.read("alpha"))).toHaveLength(1);

		await clock.advance(2);
		const stale = coordinator.read("alpha");
		expect(metrics(stale)).toEqual([]);
		expect(stale.state).not.toBe("available");

		coordinator.dispose();
	});

	test("passed_reset_never_infers_replenishment", async () => {
		const resetsAt = NOW + 30_000;
		let failing = false;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					if (failing) {
						return unavailableRead(NOW, "network_error");
					}
					return availableRead(NOW, {
						remaining: 0,
						resetsAt,
						expiresAt: resetsAt,
					});
				},
			}),
		);

		const before = await coordinator.refresh("alpha");
		expect(remainingPercents(before)[0]).toBe(0);

		await clock.advance(30_001);
		const afterReset = coordinator.read("alpha");
		expect(metrics(afterReset)).toEqual([]);
		expect(JSON.stringify(afterReset)).not.toContain('"remainingPercent":100');

		// A failed revalidation after the boundary hides figures and shows the
		// observed reason instead of an assumed refill.
		failing = true;
		const failed = await coordinator.refresh("alpha");
		expect(failed).toMatchObject({
			state: "unavailable",
			reason: "network_error",
		});
		expect(metrics(failed)).toEqual([]);

		coordinator.dispose();
	});
});

describe("quota identity isolation and cleanup", () => {
	test("account_switch_during_inflight_never_shows_old_account", async () => {
		let releaseOld: (value: QuotaRead) => void = () => {};
		const oldResponse = new Promise<QuotaRead>((resolve) => {
			releaseOld = resolve;
		});
		const observed: QuotaRead[] = [];

		let requests = 0;
		const { coordinator, setCurrent } = harness(() =>
			source({
				identityKey: "account-a",
				read: () => {
					requests += 1;
					return oldResponse;
				},
				// The old account is no longer current once B is selected.
				isCurrent: async () => false,
			}),
		);

		const disposeWatch = coordinator.watch("alpha", (value) =>
			observed.push(value),
		);
		await settle();
		expect(observed).toEqual([]);

		setCurrent(() =>
			source({
				identityKey: "account-b",
				async read() {
					requests += 1;
					return availableRead(NOW, { remaining: 77 });
				},
			}),
		);

		const selected = await coordinator.refresh("alpha");
		expect(remainingPercents(selected)[0]).toBe(77);

		// The late account-A response must be discarded, not committed.
		releaseOld(availableRead(NOW, { remaining: 12 }));
		await settle();

		const after = coordinator.read("alpha");
		expect(remainingPercents(after)[0]).toBe(77);
		expect(
			observed.some((value) => remainingPercents(value).includes(12)),
		).toBe(false);

		expect(requests).toBe(2);
		disposeWatch();
		coordinator.dispose();
	});

	test("snapshot_stays_visible_while_refresh_is_in_flight", async () => {
		let release: (value: QuotaRead) => void = () => {};
		let refreshed = false;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					if (!refreshed) {
						return availableRead(NOW, { remaining: 40 });
					}
					return new Promise<QuotaRead>((resolve) => {
						release = resolve;
					});
				},
			}),
		);

		await coordinator.refresh("alpha");
		refreshed = true;
		await clock.advance(FLOOR_MS);
		const pending = coordinator.refresh("alpha");
		await settle();

		// The still-valid snapshot (and its age) stays visible while fetching.
		expect(remainingPercents(coordinator.read("alpha"))).toEqual([40]);

		release(availableRead(NOW, { remaining: 30 }));
		await pending;
		expect(remainingPercents(coordinator.read("alpha"))).toEqual([30]);

		coordinator.dispose();
	});

	test("companion_cache_replacement_discards_cached_values", async () => {
		let identity = "companion-cache-a";
		let releaseReplacement: (value: QuotaRead) => void = () => {};
		const replacement = new Promise<QuotaRead>((resolve) => {
			releaseReplacement = resolve;
		});

		const { coordinator } = harness(() =>
			source({
				identityKey: identity,
				read: async () =>
					identity === "companion-cache-a"
						? availableRead(NOW, { remaining: 10 })
						: replacement,
			}),
		);

		await coordinator.refresh("alpha");
		expect(remainingPercents(coordinator.read("alpha"))[0]).toBe(10);

		identity = "companion-cache-b";
		const refresh = coordinator.refresh("alpha");
		await settle();

		// While the replacement cache is being read, the stale cache's values
		// are already gone.
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		releaseReplacement(availableRead(NOW, { remaining: 20 }));
		await refresh;
		expect(remainingPercents(coordinator.read("alpha"))[0]).toBe(20);

		coordinator.dispose();
	});

	test("companion_token_expiry_ends_snapshot_before_ninety_seconds", async () => {
		const companionExpiry = NOW + 20_000;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "companion-a",
				async read() {
					return availableRead(NOW, { expiresAt: companionExpiry });
				},
			}),
		);

		await coordinator.refresh("alpha");
		await clock.advance(19_999);
		expect(metrics(coordinator.read("alpha"))).toHaveLength(1);

		await clock.advance(2);
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		coordinator.dispose();
	});

	test("explicit_failure_clears_previous_values", async () => {
		let failing = false;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					return failing
						? unavailableRead(NOW, "network_error")
						: availableRead(NOW, { remaining: 42 });
				},
			}),
		);

		await coordinator.refresh("alpha");
		expect(remainingPercents(coordinator.read("alpha"))[0]).toBe(42);

		failing = true;
		await clock.advance(FLOOR_MS);
		const failed = await coordinator.refresh("alpha");
		expect(failed).toMatchObject({
			state: "unavailable",
			reason: "network_error",
		});
		expect(metrics(failed)).toEqual([]);
		expect(coordinator.read("alpha")).toEqual(failed);

		coordinator.dispose();
	});

	test("partial_sections_expire_independently", async () => {
		const read: QuotaRead = {
			state: "available",
			authSource: "codex-companion",
			sections: [
				availableSection(NOW, {
					scope: "app",
					id: "app-window",
					expiresAt: NOW + 20_000,
					remaining: 90,
				}),
				availableSection(NOW, {
					scope: "shared-plan",
					id: "plan-window",
					expiresAt: NOW + 70_000,
					remaining: 80,
				}),
			],
		};
		const { coordinator, clock } = harness(() =>
			source({ identityKey: "identity-a", read: async () => read }),
		);

		await coordinator.refresh("alpha");
		expect(availableScopes(coordinator.read("alpha"))).toEqual([
			"app",
			"shared-plan",
		]);

		await clock.advance(20_001);
		expect(availableScopes(coordinator.read("alpha"))).toEqual(["shared-plan"]);
		expect(remainingPercents(coordinator.read("alpha"))[0]).toBe(80);

		await clock.advance(50_000);
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		coordinator.dispose();
	});

	test("retry_after_overrides_backoff_when_longer", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return unavailableRead(NOW, "rate_limited", 200_000);
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);
		expect(pollDelays(clock.scheduled).at(-1)).toBe(200_000);

		await clock.advance(199_999);
		expect(requests).toBe(1);

		// A user refresh never bypasses an active cooldown.
		await coordinator.refresh("alpha");
		expect(requests).toBe(1);

		await clock.advance(1);
		expect(requests).toBe(2);

		dispose();
		coordinator.dispose();
	});

	test("capped_backoff_60_120_240_300", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return unavailableRead(NOW, "network_error");
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);

		for (const nextDelay of [120_000, 240_000, 300_000, 300_000]) {
			const delay = pollDelays(clock.scheduled).at(-1);
			if (delay === undefined) {
				throw new Error("no poll scheduled");
			}
			await clock.advance(delay);
			expect(pollDelays(clock.scheduled).at(-1)).toBe(nextDelay);
		}

		expect(pollDelays(clock.scheduled)).toEqual([
			60_000, 120_000, 240_000, 300_000, 300_000,
		]);
		expect(requests).toBe(5);

		dispose();
		coordinator.dispose();
	});

	test("partial_retry_after_delays_the_next_poll", async () => {
		const partial: QuotaRead = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				availableSection(NOW, { scope: "app", remaining: 90 }),
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW,
						retryAfterMs: 180_000,
					},
				},
			],
		};
		const { coordinator, clock } = harness(() =>
			source({ identityKey: "identity-a", read: async () => partial }),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(pollDelays(clock.scheduled).at(-1)).toBe(180_000);

		await clock.advance(179_999);
		expect(pollDelays(clock.scheduled)).toEqual([180_000]);

		dispose();
		coordinator.dispose();
	});

	test("request_timeout_discards_late_value", async () => {
		let release: (value: QuotaRead) => void = () => {};
		const hanging = new Promise<QuotaRead>((resolve) => {
			release = resolve;
		});
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return hanging;
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);

		await clock.advance(REQUEST_TIMEOUT_MS);
		expect(coordinator.read("alpha")).toMatchObject({
			state: "unavailable",
			reason: "timeout",
		});

		release(availableRead(NOW, { remaining: 99 }));
		await settle();
		expect(coordinator.read("alpha")).toMatchObject({ reason: "timeout" });
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		dispose();
		coordinator.dispose();
	});

	test("unsubscribe_stops_future_requests", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return availableRead(NOW);
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);

		await clock.advance(POLL_MS);
		expect(requests).toBe(2);

		dispose();
		expect(clock.pending()).toBe(0);

		await clock.advance(300_000);
		expect(requests).toBe(2);

		coordinator.dispose();
	});

	test("dispose_discards_inflight_and_stops_requests", async () => {
		let release: (value: QuotaRead) => void = () => {};
		const hanging = new Promise<QuotaRead>((resolve) => {
			release = resolve;
		});
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return hanging;
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);

		coordinator.dispose();
		expect(clock.pending()).toBe(0);
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		release(availableRead(NOW, { remaining: 100 }));
		await settle();
		expect(metrics(coordinator.read("alpha"))).toEqual([]);

		await coordinator.refresh("alpha");
		expect(requests).toBe(1);

		dispose();
	});

	test("invalidate_clears_only_the_matching_identity", async () => {
		const { coordinator } = harness((providerID) =>
			source({
				identityKey: `identity-${providerID}`,
				async read() {
					return availableRead(NOW);
				},
			}),
		);

		await coordinator.refresh("alpha");
		await coordinator.refresh("beta");
		expect(metrics(coordinator.read("alpha"))).toHaveLength(1);

		coordinator.invalidate("identity-alpha");

		expect(metrics(coordinator.read("alpha"))).toEqual([]);
		expect(metrics(coordinator.read("beta"))).toHaveLength(1);

		coordinator.dispose();
	});

	test("unsupported_connections_are_not_polled", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "unsupported",
				async read() {
					requests += 1;
					return unavailableRead(NOW, "no_validated_quota_source");
				},
			}),
		);

		const dispose = coordinator.watch("alpha", () => {});
		await settle();
		expect(requests).toBe(1);
		expect(pollDelays(clock.scheduled)).toEqual([]);
		expect(clock.pending()).toBe(0);

		await clock.advance(300_000);
		expect(requests).toBe(1);

		dispose();
		coordinator.dispose();
	});

	test("auth_required_failures_do_not_auto_retry", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "companion-a",
				async read() {
					requests += 1;
					return unavailableRead(NOW, "companion_expired");
				},
			}),
		);

		const dispose = coordinator.watch("alpha", (value) => {
			expect(value).toMatchObject({
				state: "auth-required",
				reason: "companion_expired",
			});
		});
		await settle();
		expect(requests).toBe(1);
		expect(pollDelays(clock.scheduled)).toEqual([]);

		await clock.advance(300_000);
		expect(requests).toBe(1);

		dispose();
		coordinator.dispose();
	});

	test("unread_provider_has_no_timer", async () => {
		let requests = 0;
		const { coordinator, clock } = harness(() =>
			source({
				identityKey: "identity-a",
				async read() {
					requests += 1;
					return availableRead(NOW);
				},
			}),
		);

		await coordinator.refresh("alpha");
		expect(requests).toBe(1);
		expect(clock.pending()).toBe(0);
		expect(pollDelays(clock.scheduled)).toEqual([]);

		coordinator.dispose();
	});
});

function emptyRpcContext() {
	return {
		signal: new AbortController().signal,
		error: (type: string, message: string, data?: unknown) => ({
			type,
			message,
			data,
		}),
	};
}

type RegisteredHandlers = {
	list(input: unknown, context: unknown): Promise<unknown>;
	get(input: unknown, context: unknown): Promise<unknown>;
	refresh(input: unknown, context: unknown): Promise<unknown>;
};

function fakeHostContext(input: {
	providers: Array<{ id: string; integrationID?: string }>;
	active(
		integrationID: string,
	): Promise<
		{ type: string; id: string; label: string; method: string } | undefined
	>;
	resolve?(connection: unknown): Promise<unknown>;
	options?: Record<string, unknown>;
}) {
	const registrations: Array<{
		handlers: RegisteredHandlers;
		disposed: boolean;
	}> = [];
	const context = {
		options: input.options ?? {},
		provider: {
			list: async () => ({
				location: { directory: "/tmp/quota-refresh" },
				data: input.providers,
			}),
		},
		integration: {
			connection: {
				active: input.active,
				resolve: input.resolve ?? (async () => undefined),
			},
		},
		rpc: {
			register: async (_definition: unknown, handlers: RegisteredHandlers) => {
				const record = { handlers, disposed: false };
				registrations.push(record);
				return {
					dispose: async () => {
						record.disposed = true;
					},
					events: { emit: async () => {} },
				};
			},
		},
	};
	return {
		context: context as never,
		registrations,
	};
}

async function withFetch<T>(
	handler: (url: string) => Response,
	run: () => Promise<T>,
): Promise<{ result: T; requests: number }> {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async (url: string) => {
		requests += 1;
		return handler(String(url));
	}) as unknown as typeof fetch;
	try {
		const result = await run();
		return { result, requests };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function balancePayload(): unknown {
	return {
		included: {
			balance_usd: 40,
			allowance_usd: 60,
			period: {
				until: Math.floor((Date.now() + 86_400_000) / 1000),
			},
		},
		purchased: { balance_usd: 5 },
	};
}

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function jwt(payload: Record<string, unknown>): string {
	return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(
		JSON.stringify(payload),
	)}.synthetic-signature`;
}

describe("host wiring smoke", () => {
	test("mounted_views_share_one_request_and_unload_stops_requests", async () => {
		const host = fakeHostContext({
			providers: [{ id: "ollama", integrationID: "ollama-cloud" }],
			async active() {
				return {
					type: "credential",
					id: "credential-1",
					label: "Account",
					method: "key",
				};
			},
			resolve: async () => ({ type: "key", key: "synthetic-ollama-key" }),
		});

		const cleanup = await setupQuotaServer(host.context);
		const handlers = host.registrations[0]?.handlers;
		if (handlers === undefined) {
			throw new Error("rpc was not registered");
		}

		const { result, requests } = await withFetch(
			() =>
				new Response(JSON.stringify(balancePayload()), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			() =>
				Promise.all([
					// Sidebar and full page both read the same provider.
					handlers.get({ providerID: "ollama" }, emptyRpcContext()),
					handlers.list({}, emptyRpcContext()),
				]),
		);

		expect(requests).toBe(1);
		const [get, list] = result as [
			{ quota: QuotaRead },
			{ providers: Array<{ quota: QuotaRead }> },
		];
		expect(moneyRemaining(get.quota)).toBe(40);
		expect(
			moneyRemaining(list.providers[0]?.quota ?? unavailableRead(0, "timeout")),
		).toBe(40);

		await cleanup();
		expect(host.registrations[0]?.disposed).toBe(true);

		const afterUnload = await withFetch(
			() => new Response(JSON.stringify(balancePayload()), { status: 200 }),
			() => handlers.get({ providerID: "ollama" }, emptyRpcContext()),
		);
		expect(afterUnload.requests).toBe(0);
		expect(afterUnload.result).toBeDefined();
	});

	test("enabled_companion_uses_real_bounded_reads_without_stub_mislabel", async () => {
		const codexHome = await mkdtemp(join(tmpdir(), "quota-refresh-"));
		const clientID = "synthetic-refresh-client-id";
		const accountID = "synthetic-refresh-account-id";
		const nowSeconds = Math.floor(Date.now() / 1000);
		const nativeAccess = jwt({
			iss: "https://auth.openai.com",
			aud: "https://api.openai.com/v1",
			client_id: clientID,
			scope: "openid chatgpt.tokens.use.direct",
			exp: nowSeconds + 3_600,
		});
		const companionAccess = jwt({
			"https://api.openai.com/auth": { chatgpt_account_id: accountID },
			exp: nowSeconds + 3_600,
		});

		try {
			await writeFile(
				join(codexHome, "auth.json"),
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: companionAccess,
						account_id: accountID,
					},
				}),
				"utf8",
			);

			const host = fakeHostContext({
				providers: [{ id: "openai", integrationID: "openai" }],
				async active() {
					return {
						type: "credential",
						id: "credential-openai",
						label: "Account",
						method: "oauth",
					};
				},
				resolve: async () => ({
					type: "oauth",
					methodID: "chatgpt-token-sharing",
					access: nativeAccess,
					metadata: {
						clientID,
						scopes: ["chatgpt.tokens.use.direct"],
					},
				}),
				options: {
					codexCompanion: { enabled: true, home: codexHome },
				},
			});

			const cleanup = await setupQuotaServer(host.context);
			const handlers = host.registrations[0]?.handlers;
			if (handlers === undefined) {
				throw new Error("rpc was not registered");
			}

			const { result, requests } = await withFetch(
				(url) =>
					new Response(
						JSON.stringify(
							url.endsWith("/chatpass/apps")
								? {
										items: [
											{
												id: clientID,
												allowed_usage_percent: 100,
												windows: [
													{
														used_percent: 10,
														remaining_percent: 90,
														limit_window_seconds: 604_800,
														reset_at: nowSeconds + 604_800,
													},
												],
											},
										],
									}
								: {
										rate_limit: {
											primary_window: {
												used_percent: 20,
												remaining_percent: 80,
												limit_window_seconds: 18_000,
												reset_at: nowSeconds + 18_000,
											},
										},
									},
						),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
				() => handlers.get({ providerID: "openai" }, emptyRpcContext()),
			);

			const read = (result as { quota: QuotaRead }).quota;
			expect(requests).toBe(2);
			expect(read.state).toBe("available");
			expect("sections" in read).toBe(true);
			if ("sections" in read) {
				expect(read.authSource).toBe("codex-companion");
				expect(read.sections.map((section) => section.scope)).toEqual([
					"app",
					"shared-plan",
				]);
				expect(remainingPercents(read)).toEqual([90, 80]);
			}
			expect(JSON.stringify(read)).not.toContain(
				"unsupported_companion_storage",
			);
			expect(JSON.stringify(read)).not.toContain(companionAccess);

			// A genuinely absent companion cache is reported honestly instead of
			// surfacing a stub wiring error.
			await rm(join(codexHome, "auth.json"));
			const missing = await withFetch(
				() => new Response("{}", { status: 200 }),
				() => handlers.get({ providerID: "openai" }, emptyRpcContext()),
			);
			expect(missing.result).toMatchObject({
				quota: { state: "unavailable", reason: "companion_missing" },
			});
			expect(missing.requests).toBe(0);

			await cleanup();
		} finally {
			await rm(codexHome, { recursive: true, force: true });
		}
	});
});

describe("tui update subscription", () => {
	test("listener_is_disposed_on_unload_and_validates_payloads", () => {
		const handlers: Array<(payload: unknown) => void> = [];
		let disposals = 0;
		const context = {
			client: {
				rpc: () => ({
					events: {
						on(name: string, handler: (payload: unknown) => void) {
							expect(name).toBe("updated");
							handlers.push(handler);
							return () => {
								disposals += 1;
							};
						},
					},
				}),
			},
		} as unknown as QuotaTuiContext;

		const received: QuotaUpdatedEvent[] = [];
		const dispose = subscribeQuotaUpdates(context, (event) =>
			received.push(event),
		);

		const data: QuotaUpdatedEvent = {
			version: 1,
			providerID: "alpha",
			quota: availableRead(NOW),
		};
		handlers[0]?.({ type: "rpc.provider-usage.updated", data });
		handlers[0]?.({ type: "rpc.provider-usage.updated", data: { foo: 1 } });
		handlers[0]?.(undefined);

		expect(received).toEqual([data]);
		dispose();
		expect(disposals).toBe(1);
	});

	test("clients_without_event_support_degrade_to_polled_reads", () => {
		const context = {
			client: { rpc: () => ({}) },
		} as unknown as QuotaTuiContext;
		const dispose = subscribeQuotaUpdates(context, () => {});
		expect(typeof dispose).toBe("function");
		dispose();
	});
});

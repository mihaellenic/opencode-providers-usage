import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type { QuotaRead } from "../../src/core/contracts";
import type { HostActivity } from "../../src/gui/host";
import {
	type ControllerView,
	createUsageController,
	RPC_TIMEOUT_MS,
} from "../../src/gui/state";
import {
	QUOTA_RPC_VERSION,
	type QuotaGetResult,
	type QuotaListResult,
	type QuotaUpdatedEvent,
} from "../../src/rpc";
import { fakeClock, fakeRpc, fakeSession } from "./fakes";

function viewFor(id: string): QuotaGetResult {
	return {
		version: QUOTA_RPC_VERSION,
		provider: {
			providerID: id,
			name: id,
			authMethod: "oauth",
			support: "supported",
			evidence: "unverified",
		},
		quota: { state: "unavailable", reason: "transport", attemptedAt: 0 },
	};
}

function availableQuota(fetchedAt: number, expiresAt?: number): QuotaRead {
	return {
		state: "available",
		authSource: "opencode",
		sections: [
			{
				scope: "shared-plan",
				result: {
					state: "available",
					metrics: [],
					fetchedAt,
					expiresAt: expiresAt ?? fetchedAt + 3_600_000,
				},
			},
		],
	};
}

function availableFor(
	id: string,
	fetchedAt: number,
	revision: number,
): QuotaGetResult {
	return {
		...viewFor(id),
		quota: availableQuota(fetchedAt),
		presentation: { revision },
	};
}

function updatedFor(
	id: string,
	quota: QuotaRead,
	revision: number,
): QuotaUpdatedEvent {
	return {
		version: QUOTA_RPC_VERSION,
		providerID: id,
		quota,
		presentation: { revision },
	};
}

function listOf(...ids: string[]): QuotaListResult {
	return {
		version: QUOTA_RPC_VERSION,
		providers: ids.map((id) => {
			const { provider, quota } = viewFor(id);
			return { provider, quota };
		}),
	};
}

const usage = (resetsAt: number): ClaudeUsage => ({
	session: { usedPercent: 10, resetsAt },
	week: { usedPercent: 20, resetsAt },
});

const flush = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

function setup(
	options: {
		provider?: string | undefined;
		initialView?: ControllerView;
		hidden?: boolean;
		sessionID?: string;
	} = {},
) {
	const rpc = fakeRpc();
	const session = fakeSession(options.sessionID ?? "s1");
	const clock = fakeClock();
	if (options.hidden) session.setVisible(false);
	if ("provider" in options) session.setProvider(options.provider);
	else session.setProvider("a");
	const views: ControllerView[] = [];
	const controller = createUsageController({
		session,
		rpc,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		onView: (view) => views.push(view),
		...(options.initialView ? { initialView: options.initialView } : {}),
	});
	return { rpc, session, clock, controller, views };
}

type Harness = ReturnType<typeof setup>;

const callsOf = (h: Harness, method: string) =>
	h.rpc.calls.filter((call) => call.method === method);

const signalOf = (call: { args: unknown[] } | undefined): AbortSignal => {
	const signal = call?.args.at(-1);
	if (!(signal instanceof AbortSignal)) throw new Error("no signal");
	return signal;
};

const counts = (h: Harness) => ({
	list: callsOf(h, "list").length,
	get: callsOf(h, "get").length,
	refresh: callsOf(h, "refresh").length,
	claude: callsOf(h, "claudeCodeUsage").length,
});

async function showSummary(h: Harness, fetchedAt?: number) {
	h.session.setVisible(true);
	h.rpc.resolve("list", listOf("a"));
	h.rpc.resolve(
		"get",
		fetchedAt === undefined ? viewFor("a") : availableFor("a", fetchedAt, 1),
	);
	await flush();
}

async function showDashboard(h: Harness, ...ids: string[]) {
	h.controller.open("dashboard");
	h.session.setVisible(true);
	h.rpc.resolve("list", listOf(...ids));
	h.rpc.resolve("claudeCodeUsage", null);
	await flush();
}

describe("usage controller", () => {
	test("discards a stale get after the selected provider changed", async () => {
		const rpc = fakeRpc(),
			session = fakeSession("s1"),
			clock = fakeClock();
		session.setProvider("a");
		const c = createUsageController({ session, rpc, ...clock });
		session.setVisible(true);
		session.setProvider("b");
		rpc.resolve("get", viewFor("a")); // resolve the oldest pending get (A)
		await Promise.resolve();
		await Promise.resolve();
		expect(c.summary()).not.toMatchObject({ providerID: "a" });
		const before = c.summary();
		await flush();
		expect(c.summary()).toEqual(before);
		expect(c.summary()).toEqual({ kind: "loading", providerID: "b" });
	});

	test("construction makes no rpc call; first visible makes list+get once", async () => {
		const h = setup();
		h.clock.advance(3_600_000);
		expect(h.rpc.calls).toEqual([]);
		h.session.setVisible(true);
		h.session.setVisible(true);
		expect(counts(h)).toEqual({ list: 1, get: 1, refresh: 0, claude: 0 });
		expect(callsOf(h, "get")[0]?.args[0]).toMatchObject({ providerID: "a" });
	});

	test("restored dashboard view is rendered but fetches nothing while hidden", () => {
		const h = setup({ initialView: "dashboard", hidden: true });
		expect(h.controller.view()).toBe("dashboard");
		h.clock.advance(3_600_000);
		expect(h.rpc.calls).toEqual([]);
		expect(h.clock.pending()).toBe(0);
		expect(h.views).toEqual([]);
	});

	test("open while hidden records navigation only until visible", () => {
		const h = setup({ hidden: true });
		h.controller.open("dashboard");
		expect(h.controller.view()).toBe("dashboard");
		expect(h.views).toEqual(["dashboard"]);
		expect(h.rpc.calls).toEqual([]);
		h.session.setVisible(true);
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 0, claude: 1 });
	});

	test("summary never collects Claude, even on manual refresh", async () => {
		const h = setup();
		await showSummary(h, 0);
		h.controller.refresh();
		expect(counts(h).refresh).toBe(1);
		expect(counts(h).claude).toBe(0);
	});

	test("summary renders through sidebarQuotaPresentation", async () => {
		const h = setup();
		const lastKnown = availableQuota(0);
		h.session.setVisible(true);
		h.rpc.resolve("list", listOf("a"));
		h.rpc.resolve("get", {
			...viewFor("a"),
			presentation: { revision: 1, lastKnown, failedSince: 0 },
		});
		await flush();
		const state = h.controller.summary();
		if (state.kind !== "ready") throw new Error("expected ready");
		expect(state.view.quota).toEqual(lastKnown);
	});

	test("dashboard open collects Claude once; manual refresh collects again", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		expect(counts(h).claude).toBe(1);
		h.rpc.resolve("list", listOf("a", "b"));
		h.rpc.resolve("claudeCodeUsage", usage(5_000_000));
		await flush();
		expect(h.controller.dashboard().claude).toEqual(usage(5_000_000));
		h.controller.refresh();
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 2, claude: 2 });
		expect(h.controller.dashboard().claude).toBeNull();
	});

	test("dashboard shows raw revalidated quota without history", async () => {
		const h = setup();
		const lastKnown = availableQuota(0);
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.resolve("list", {
			version: QUOTA_RPC_VERSION,
			providers: [
				{
					provider: viewFor("a").provider,
					quota: availableQuota(0),
					presentation: { revision: 1, lastKnown },
				},
			],
		});
		h.rpc.resolve("claudeCodeUsage", null);
		await flush();
		const [card] = h.controller.dashboard().providers;
		expect(card?.presentation).toBeUndefined();
		expect(card?.quota.state).toBe("available");
		let notified = 0;
		h.controller.subscribe(() => {
			notified += 1;
		});
		h.clock.advance(90_000);
		expect(notified).toBeGreaterThan(0);
		expect(h.controller.dashboard().providers[0]?.quota.state).toBe("partial");
		expect(counts(h).refresh).toBe(0);
	});

	test("idle at 300000 refreshes only the selected provider in summary", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(299_999);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(counts(h)).toEqual({ list: 1, get: 1, refresh: 1, claude: 0 });
		expect(callsOf(h, "refresh")[0]?.args[0]).toMatchObject({
			providerID: "a",
		});
	});

	test("idle in dashboard refreshes every provider and Claude", async () => {
		const h = setup();
		await showDashboard(h, "a", "b");
		h.clock.advance(300_000);
		h.clock.advance(0);
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 2, claude: 2 });
		expect(
			callsOf(h, "refresh").map((call) => {
				const ref = call.args[0];
				return typeof ref === "object" && ref !== null && "providerID" in ref
					? ref.providerID
					: undefined;
			}),
		).toEqual(["a", "b"]);
	});

	test("idle does not start a second Claude collection while one is in flight", async () => {
		const h = setup();
		await showDashboard(h, "a");
		h.clock.advance(250_000);
		h.controller.refresh();
		expect(counts(h).claude).toBe(2);
		h.clock.advance(50_000);
		h.clock.advance(0);
		expect(counts(h).claude).toBe(2);
	});

	test("idle refreshes a snapshot fetched 20s earlier (bypasses 60s freshness)", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(280_000);
		h.rpc.emitUpdated(updatedFor("a", availableQuota(280_000), 2));
		h.clock.advance(20_000);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	test("idle defers a snapshot fetched 5s earlier by the 15s floor", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(295_000);
		h.rpc.emitUpdated(updatedFor("a", availableQuota(295_000), 2));
		h.clock.advance(5_000);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(9_999);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		expect(counts(h).refresh).toBe(1);
	});

	test("idle during an in-flight refresh issues no second call", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(299_000);
		h.session.emit({ kind: "step-finished", providerID: "a" });
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
		h.clock.advance(1_000);
		h.clock.advance(0);
		h.controller.refresh();
		expect(counts(h).refresh).toBe(1);
	});

	test("input within 60s of a fetch does not refresh; a stale snapshot does", async () => {
		const h = setup();
		await showSummary(h, 0);
		h.clock.advance(30_000);
		h.session.emit({ kind: "input" });
		h.clock.advance(20_000);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(11_000);
		h.session.emit({ kind: "input" });
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	test("step-failed and step-finished refresh the matching provider only", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(15_000);
		h.session.emit({ kind: "step-failed", providerID: "other" });
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.session.emit({ kind: "step-failed", providerID: "a" });
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
		expect(callsOf(h, "refresh")[0]?.args[0]).toMatchObject({
			providerID: "a",
		});
	});

	test("display-only ticks make no rpc call and do not move the idle deadline", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.resolve("list", listOf("a"));
		h.rpc.resolve("claudeCodeUsage", usage(10_000_000));
		await flush();
		let notified = 0;
		h.controller.subscribe(() => {
			notified += 1;
		});
		h.clock.advance(30_000);
		expect(notified).toBe(1);
		h.clock.advance(30_000);
		expect(notified).toBe(2);
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 0, claude: 1 });
		h.clock.advance(239_999);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	test("step-started does not reset idle", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(199_000);
		h.rpc.emitUpdated(updatedFor("a", availableQuota(199_000), 2));
		h.clock.advance(1_000);
		h.session.emit({ kind: "step-started", providerID: "a" });
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(99_999);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	const inputs: HostActivity[] = [{ kind: "input" }, { kind: "focus" }];
	test.each(inputs)("$kind resets idle", async (event) => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(199_000);
		h.rpc.emitUpdated(updatedFor("a", availableQuota(199_000), 2));
		h.clock.advance(1_000);
		h.session.emit(event);
		h.clock.advance(299_999);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	test("model change resets idle", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(200_000);
		h.session.setProvider("b");
		h.rpc.resolve("get", availableFor("b", 200_000, 1));
		await flush();
		h.clock.advance(299_999);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(callsOf(h, "refresh")).toHaveLength(1);
		expect(callsOf(h, "refresh")[0]?.args[0]).toMatchObject({
			providerID: "b",
		});
	});

	test("view change resets idle", async () => {
		const h = setup();
		await showSummary(h);
		h.clock.advance(200_000);
		h.controller.open("dashboard");
		h.rpc.resolve("list", listOf("a"));
		h.rpc.resolve("claudeCodeUsage", null);
		await flush();
		h.clock.advance(299_999);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(0);
		h.clock.advance(1);
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(1);
	});

	test("failed list is retried once at idle", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.reject("list", new Error("down"));
		h.rpc.resolve("claudeCodeUsage", null);
		await flush();
		expect(h.controller.dashboard().inventory).toBe("failed");
		h.clock.advance(300_000);
		expect(counts(h).list).toBe(2);
		expect(h.controller.dashboard().inventory).toBe("loading");
		h.rpc.resolve("list", listOf("a"));
		await flush();
		expect(h.controller.dashboard().inventory).toBe("ready");
		expect(h.controller.dashboard().providers).toHaveLength(1);
	});

	test("failed list is retried on refresh()", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.reject("list", new Error("down"));
		await flush();
		h.controller.refresh();
		expect(counts(h).list).toBe(2);
		h.controller.refresh();
		expect(counts(h).list).toBe(2);
	});

	test("synchronous rpc throw fails the inventory without throwing", async () => {
		const h = setup();
		const failing = {
			...h.rpc,
			list: (): never => {
				throw new Error("sync");
			},
		};
		const c = createUsageController({
			session: h.session,
			rpc: failing,
			now: h.clock.now,
			setTimer: h.clock.setTimer,
			clearTimer: h.clock.clearTimer,
			initialView: "dashboard",
		});
		expect(() => h.session.setVisible(true)).not.toThrow();
		await flush();
		expect(c.dashboard().inventory).toBe("failed");
	});

	test("failed get keeps the prior snapshot as lastKnown", async () => {
		const h = setup();
		await showSummary(h, 0);
		h.session.setProvider("b");
		h.session.setProvider("a");
		h.rpc.reject("get", new Error("down")); // oldest: get(b)
		h.rpc.reject("get", new Error("down")); // get(a)
		await flush();
		const state = h.controller.summary();
		expect(state).toMatchObject({ kind: "failed", providerID: "a" });
		if (state.kind !== "failed") throw new Error("expected failed");
		expect(state.lastKnown?.provider.providerID).toBe("a");
	});

	test("failed get without a snapshot has no lastKnown and can be retried", async () => {
		const h = setup();
		h.session.setVisible(true);
		h.rpc.reject("get", new Error("down"));
		await flush();
		expect(h.controller.summary()).toEqual({
			kind: "failed",
			providerID: "a",
		});
		h.controller.retry("a");
		expect(counts(h).get).toBe(2);
		h.rpc.resolve("get", viewFor("a"));
		await flush();
		expect(h.controller.summary().kind).toBe("ready");
	});

	test("a hanging get fails locally at RPC_TIMEOUT_MS, aborts, and ignores a late result", async () => {
		const h = setup();
		h.session.setVisible(true);
		h.rpc.hang("get");
		const signal = signalOf(callsOf(h, "get")[0]);
		h.clock.advance(RPC_TIMEOUT_MS - 1);
		expect(signal.aborted).toBe(false);
		h.clock.advance(1);
		expect(signal.aborted).toBe(true);
		expect(h.controller.summary()).toMatchObject({ kind: "failed" });
		h.rpc.resolve("get", viewFor("a"));
		await flush();
		expect(h.controller.summary()).toMatchObject({ kind: "failed" });
	});

	test("a hanging list fails the inventory and a late result is ignored", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.hang("list");
		h.clock.advance(RPC_TIMEOUT_MS);
		expect(h.controller.dashboard().inventory).toBe("failed");
		h.rpc.resolve("list", listOf("a"));
		await flush();
		expect(h.controller.dashboard().inventory).toBe("failed");
		expect(h.controller.dashboard().providers).toEqual([]);
	});

	test("a hanging Claude collection times out to null and ignores a late result", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.hang("claudeCodeUsage");
		const signal = signalOf(callsOf(h, "claudeCodeUsage")[0]);
		h.clock.advance(RPC_TIMEOUT_MS);
		expect(signal.aborted).toBe(true);
		expect(h.controller.dashboard().claude).toBeNull();
		h.rpc.resolve("claudeCodeUsage", usage(5_000_000));
		await flush();
		expect(h.controller.dashboard().claude).toBeNull();
	});

	test("a late list after dispose never notifies", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		let notified = 0;
		h.controller.subscribe(() => {
			notified += 1;
		});
		h.controller.dispose();
		const before = notified;
		h.rpc.resolve("list", listOf("a"));
		await flush();
		expect(notified).toBe(before);
		expect(h.controller.dashboard().providers).toEqual([]);
	});

	test("a superseded Claude open is discarded", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.controller.open("summary");
		h.controller.open("dashboard");
		const [first, second] = callsOf(h, "claudeCodeUsage");
		expect(signalOf(first).aborted).toBe(true);
		expect(signalOf(second).aborted).toBe(false);
		h.rpc.resolve("claudeCodeUsage", usage(1_111_111));
		await flush();
		expect(h.controller.dashboard().claude).toBeNull();
		h.rpc.resolve("claudeCodeUsage", usage(2_222_222));
		await flush();
		expect(h.controller.dashboard().claude).toEqual(usage(2_222_222));
	});

	test("Claude null leaves provider cards loaded without card errors", async () => {
		const h = setup();
		await showDashboard(h, "a", "b");
		const dashboard = h.controller.dashboard();
		expect(dashboard.claude).toBeNull();
		expect(dashboard.cardErrors).toEqual({});
		expect(dashboard.inventory).toBe("ready");
		expect(dashboard.providers.map((p) => p.provider.providerID)).toEqual([
			"a",
			"b",
		]);
	});

	test("an old server rejecting Claude yields null only", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.resolve("list", listOf("a"));
		h.rpc.reject("claudeCodeUsage", new Error("rpc.method_not_found"));
		await flush();
		expect(h.controller.dashboard().claude).toBeNull();
		expect(h.controller.dashboard().cardErrors).toEqual({});
		expect(h.controller.dashboard().inventory).toBe("ready");
	});

	test("hidden controller makes no calls and owns no timers", async () => {
		const h = setup({ hidden: true });
		h.session.emit({ kind: "input" });
		h.session.emit({ kind: "step-failed", providerID: "a" });
		h.clock.advance(3_600_000);
		expect(h.rpc.calls).toEqual([]);
		expect(h.clock.pending()).toBe(0);
	});

	test("hiding during collection aborts locally, clears timers, and ignores late results", async () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		const list = signalOf(callsOf(h, "list")[0]);
		const claude = signalOf(callsOf(h, "claudeCodeUsage")[0]);
		let notified = 0;
		h.controller.subscribe(() => {
			notified += 1;
		});
		h.session.setVisible(false);
		const before = notified;
		expect(list.aborted).toBe(true);
		expect(claude.aborted).toBe(true);
		expect(h.clock.pending()).toBe(0);
		h.rpc.resolve("list", listOf("a"));
		h.rpc.resolve("claudeCodeUsage", usage(5_000_000));
		await flush();
		expect(notified).toBe(before);
		expect(h.controller.dashboard().providers).toEqual([]);
		expect(h.controller.dashboard().claude).toBeNull();
		h.clock.advance(3_600_000);
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 0, claude: 1 });
	});

	test("hiding removes activity and display timers", async () => {
		const h = setup();
		await showSummary(h, 0);
		h.clock.advance(61_000);
		h.session.emit({ kind: "step-finished", providerID: "a" });
		expect(h.clock.pending()).toBeGreaterThan(0);
		h.session.setVisible(false);
		expect(h.clock.pending()).toBe(0);
		h.clock.advance(3_600_000);
		expect(counts(h).refresh).toBe(0);
	});

	test("two visible controllers issue at most one refresh per provider each per idle fire", async () => {
		const rpc = fakeRpc();
		const clock = fakeClock();
		const make = (id: string) => {
			const session = fakeSession(id);
			session.setProvider("a");
			const controller = createUsageController({ session, rpc, ...clock });
			session.setVisible(true);
			return controller;
		};
		const first = make("s1");
		const second = make("s2");
		for (let i = 0; i < 2; i++) {
			rpc.resolve("list", listOf("a"));
			rpc.resolve("get", viewFor("a"));
		}
		await flush();
		clock.advance(300_000);
		clock.advance(0);
		clock.advance(0);
		expect(rpc.calls.filter((call) => call.method === "refresh")).toHaveLength(
			2,
		);
		first.dispose();
		second.dispose();
	});

	test("an older updated revision does not replace a newer observation", async () => {
		const h = setup();
		h.session.setVisible(true);
		h.rpc.resolve("list", listOf("a"));
		h.rpc.resolve("get", availableFor("a", 0, 5));
		await flush();
		h.rpc.emitUpdated(
			updatedFor(
				"a",
				{ state: "unavailable", reason: "transport", attemptedAt: 1 },
				3,
			),
		);
		const state = h.controller.summary();
		if (state.kind !== "ready") throw new Error("expected ready");
		expect(state.view.presentation?.revision).toBe(5);
		expect(state.view.quota.state).toBe("available");
		h.rpc.emitUpdated(
			updatedFor(
				"a",
				{ state: "unavailable", reason: "transport", attemptedAt: 2 },
				7,
			),
		);
		const next = h.controller.summary();
		if (next.kind !== "ready") throw new Error("expected ready");
		expect(next.view.presentation?.revision).toBe(7);
	});

	test("dispose leaves nothing pending and aborts in-flight signals", () => {
		const h = setup();
		h.controller.open("dashboard");
		h.session.setVisible(true);
		const signals = [
			signalOf(callsOf(h, "list")[0]),
			signalOf(callsOf(h, "claudeCodeUsage")[0]),
		];
		h.controller.dispose();
		expect(signals.map((s) => s.aborted)).toEqual([true, true]);
		expect(h.clock.pending()).toBe(0);
		h.session.emit({ kind: "input" });
		h.session.setVisible(false);
		h.session.setVisible(true);
		h.controller.open("summary");
		h.controller.refresh();
		expect(counts(h)).toEqual({ list: 1, get: 0, refresh: 0, claude: 1 });
	});

	test("a throwing listener never breaks idle refresh or leaks a rejection", async () => {
		const h = setup();
		await showSummary(h);
		h.controller.subscribe(() => {
			throw new Error("listener");
		});
		expect(() => h.clock.advance(300_000)).not.toThrow();
		h.clock.advance(0);
		h.rpc.resolve("refresh", viewFor("a"));
		await flush();
		expect(() => h.clock.advance(300_000)).not.toThrow();
		h.clock.advance(0);
		expect(counts(h).refresh).toBe(2);
	});

	test("a card refresh failure is reported per provider and cleared by retry", async () => {
		const h = setup();
		await showDashboard(h, "a", "b");
		h.controller.refresh();
		h.rpc.reject("refresh", new Error("down")); // a
		h.rpc.resolve("refresh", viewFor("b"));
		await flush();
		const errors = h.controller.dashboard().cardErrors;
		expect(Object.keys(errors)).toEqual(["a"]);
		h.controller.retry("a");
		h.rpc.resolve("refresh", viewFor("a"));
		await flush();
		expect(h.controller.dashboard().cardErrors).toEqual({});
	});

	test("manual refresh in summary refreshes only the selected provider", async () => {
		const h = setup();
		await showSummary(h);
		h.controller.refresh();
		expect(counts(h)).toEqual({ list: 1, get: 1, refresh: 1, claude: 0 });
		h.rpc.resolve("refresh", availableFor("a", 0, 2));
		await flush();
		expect(h.controller.summary().kind).toBe("ready");
	});

	test("a stale refresh result cannot change the new view", async () => {
		const h = setup();
		await showDashboard(h, "a");
		h.controller.refresh();
		const stale = signalOf(callsOf(h, "refresh")[0]);
		h.controller.open("summary");
		expect(stale.aborted).toBe(true);
		h.rpc.resolve("refresh", availableFor("a", 0, 9));
		await flush();
		const state = h.controller.summary();
		if (state.kind !== "ready") throw new Error("expected ready");
		expect(state.view.presentation).toBeUndefined();
		expect(h.controller.dashboard().providers[0]?.presentation).toBeUndefined();
		expect(counts(h).get).toBe(1);
	});

	const mixedList = (): QuotaListResult => {
		const supports = [
			["s", "supported"],
			["u", "unsupported"],
			["n", "not-applicable"],
			["c", "requires-companion"],
		] as const;
		return {
			version: QUOTA_RPC_VERSION,
			providers: supports.map(([id, support]) => {
				const { provider, quota } = viewFor(id);
				return { provider: { ...provider, support }, quota };
			}),
		};
	};
	const refreshedIDs = (h: Harness) =>
		callsOf(h, "refresh").map((call) => {
			const ref = call.args[0];
			return typeof ref === "object" && ref !== null && "providerID" in ref
				? ref.providerID
				: undefined;
		});
	async function showMixed(h: Harness) {
		h.controller.open("dashboard");
		h.session.setVisible(true);
		h.rpc.resolve("list", mixedList());
		h.rpc.resolve("claudeCodeUsage", null);
		await flush();
	}

	test("idle refreshes every listed provider whatever its support", async () => {
		const h = setup();
		await showMixed(h);
		expect(h.controller.dashboard().providers).toHaveLength(4);
		h.clock.advance(300_000);
		h.clock.advance(0);
		expect(refreshedIDs(h)).toEqual(["s", "u", "n", "c"]);
	});

	test("manual refresh covers every listed provider whatever its support", async () => {
		const h = setup();
		await showMixed(h);
		h.controller.refresh();
		expect(refreshedIDs(h)).toEqual(["s", "u", "n", "c"]);
		expect(h.controller.dashboard().providers).toHaveLength(4);
	});

	test("step and input events reach unsupported listed providers", async () => {
		const h = setup();
		await showMixed(h);
		h.clock.advance(15_000);
		h.session.emit({ kind: "step-failed", providerID: "u" });
		h.session.emit({ kind: "step-finished", providerID: "n" });
		h.session.emit({ kind: "step-started", providerID: "c" });
		h.clock.advance(0);
		expect(refreshedIDs(h).sort()).toEqual(["c", "n", "u"]);
		h.session.emit({ kind: "input" });
		h.clock.advance(0);
		expect(refreshedIDs(h).sort()).toEqual(["c", "n", "s", "u"]);
	});

	test("requests carry the inventory authMethod and integrationID", async () => {
		const h = setup();
		h.session.setVisible(true);
		// Inventory unknown yet: the wire only sends providerID, the backend resolves the source.
		expect(callsOf(h, "get")[0]?.args[0]).toStrictEqual({
			providerID: "a",
			authMethod: "",
		});
		const { provider, quota } = viewFor("a");
		h.rpc.resolve("list", {
			version: QUOTA_RPC_VERSION,
			providers: [
				{
					provider: {
						...provider,
						authMethod: "api-key",
						integrationID: "i-1",
					},
					quota,
				},
			],
		});
		h.rpc.resolve("get", viewFor("a"));
		await flush();
		h.controller.refresh();
		expect(callsOf(h, "refresh")[0]?.args[0]).toStrictEqual({
			providerID: "a",
			authMethod: "api-key",
			integrationID: "i-1",
		});
	});

	test("a listed provider without integrationID omits it from the ref", async () => {
		const h = setup();
		await showMixed(h);
		h.controller.refresh();
		expect(callsOf(h, "refresh")[0]?.args[0]).toStrictEqual({
			providerID: "s",
			authMethod: "oauth",
		});
	});

	test("open() reports navigation to onView but the restored view is silent", () => {
		const h = setup({ initialView: "dashboard", hidden: true });
		h.controller.open("summary");
		h.controller.open("summary");
		expect(h.views).toEqual(["summary"]);
	});
});

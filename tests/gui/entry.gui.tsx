import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, MenuItem, Panel } from "@opencode/plugin/gui";
import { batch, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import {
	COMMAND_ID,
	MENU_ID,
	PANEL_ID,
	setupUsage,
	type UsageSetupContext,
} from "../../src/gui";
import type { HostActivity } from "../../src/gui/host";
import {
	bindSessionHost,
	bindUsageRpc,
	type QuotaRpcClient,
	type SessionServer,
} from "../../src/gui/host-binding";
import { QUOTA_RPC_VERSION } from "../../src/rpc";
import { fakeClock } from "./fakes";

const flush = async (): Promise<void> => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

// ---------- fakes ----------

type StepEvent = { type: string; data?: unknown };

const RPC_UPDATED = "rpc.provider-usage.updated";

function fakeServer() {
	const [provider, setProvider] = createSignal<string | undefined>(undefined);
	const [generation, setGeneration] = createSignal(0);
	type Handler = (event: StepEvent) => void;
	// One bus per data controller: a restarted server gets a new one.
	const buses: Map<string, Set<Handler>>[] = [];
	const makeData = (): SessionServer["data"] => {
		const bus = new Map<string, Set<Handler>>();
		buses.push(bus);
		return {
			on(type, handler) {
				const set = bus.get(type) ?? new Set<Handler>();
				bus.set(type, set);
				set.add(handler);
				return () => {
					set.delete(handler);
				};
			},
			session: {
				get: () => {
					const id = provider();
					return id === undefined ? undefined : { model: { providerID: id } };
				},
			},
		};
	};
	const datas = [makeData()];
	const server: SessionServer = {
		get data() {
			return datas[generation()] ?? makeData();
		},
	};
	const count = (index: number, type?: string): number => {
		const bus = buses[index];
		if (bus === undefined) return 0;
		return [...bus.entries()]
			.filter(([key]) => type === undefined || key === type)
			.reduce((sum, [, set]) => sum + set.size, 0);
	};
	return {
		server,
		setProvider,
		/** Delivers to the current data controller only, like the host does. */
		emit(event: StepEvent) {
			for (const handler of [...(buses[generation()]?.get(event.type) ?? [])])
				handler(event);
		},
		/** Server restart: a new data controller under the same ServerRef. */
		restart() {
			datas.push(makeData());
			setGeneration(datas.length - 1);
		},
		listeners: (type?: string) => count(generation(), type),
		listenersOf: (index: number, type?: string) => count(index, type),
	};
}

type RpcCall = { method: string; signal: AbortSignal; providerID?: string };

function fakeQuotaClient() {
	const calls: RpcCall[] = [];
	const outcomes = new Map<string, () => Promise<unknown>>();
	let instantiations = 0;
	const call = (
		method: string,
		signal: AbortSignal,
		providerID?: string,
	): Promise<unknown> => {
		calls.push(
			providerID === undefined
				? { method, signal }
				: { method, signal, providerID },
		);
		const outcome = outcomes.get(method);
		return outcome === undefined ? new Promise(() => {}) : outcome();
	};
	const client: QuotaRpcClient = {
		list: (_input, { signal }) => call("list", signal),
		get: (input, { signal }) => call("get", signal, input.providerID),
		refresh: (input, { signal }) => call("refresh", signal, input.providerID),
		claudeCodeUsage: (_input, { signal }) => call("claudeCodeUsage", signal),
	};
	return {
		client,
		calls,
		rpc: () => {
			instantiations++;
			return client;
		},
		instantiations: () => instantiations,
		respond(method: string, outcome: () => Promise<unknown>) {
			outcomes.set(method, outcome);
		},
	};
}

// ---------- bindUsageRpc ----------

const okGet = {
	version: QUOTA_RPC_VERSION,
	provider: {
		providerID: "p",
		name: "P",
		authMethod: "oauth",
		support: "supported",
		evidence: "unverified",
	},
	quota: { state: "unavailable", reason: "network_error", attemptedAt: 0 },
};
const okClaude = {
	session: { usedPercent: 10, resetsAt: 1_000 },
	week: { usedPercent: 20, resetsAt: 2_000 },
};

function serversOf(fake: ReturnType<typeof fakeServer>) {
	return {
		list: () => ["remote", "sidecar"],
		get: (id: string) =>
			id === "sidecar"
				? {
						builtin: true,
						get data() {
							return fake.server.data;
						},
					}
				: { builtin: false, data: fakeServer().server.data },
	};
}

function bindFor(
	quota: ReturnType<typeof fakeQuotaClient>,
	fake = fakeServer(),
) {
	const abort = new AbortController();
	const rpc = bindUsageRpc({
		signal: abort.signal,
		client: { rpc: quota.rpc },
		servers: serversOf(fake),
	});
	return { rpc, abort, fake };
}

const transportError = (): Error =>
	Object.assign(new Error("Transport: signal is aborted without reason"), {
		name: "ClientError",
		reason: "Transport",
	});

async function outcome(promise: Promise<unknown>): Promise<unknown> {
	try {
		return { ok: await promise };
	} catch (error) {
		return { error };
	}
}

describe("bindUsageRpc", () => {
	test("validates outputs and passes the provider id", async () => {
		const quota = fakeQuotaClient();
		quota.respond("list", async () => ({
			version: QUOTA_RPC_VERSION,
			providers: [],
		}));
		quota.respond("get", async () => okGet);
		quota.respond("refresh", async () => okGet);
		quota.respond("claudeCodeUsage", async () => okClaude);
		const { rpc } = bindFor(quota);
		const signal = new AbortController().signal;
		const ref = { providerID: "p", authMethod: "oauth" };
		expect((await rpc.list(signal)).providers).toEqual([]);
		expect((await rpc.get(ref, signal)).provider.providerID).toBe("p");
		expect((await rpc.refresh(ref, signal)).provider.providerID).toBe("p");
		expect(await rpc.claudeCodeUsage(signal)).toEqual(okClaude);
	});

	test("malformed outputs reject list/get/refresh and null Claude", async () => {
		const quota = fakeQuotaClient();
		for (const method of ["list", "get", "refresh", "claudeCodeUsage"])
			quota.respond(method, async () => ({ nonsense: true }));
		const { rpc } = bindFor(quota);
		const signal = new AbortController().signal;
		const ref = { providerID: "p", authMethod: "oauth" };
		await expect(rpc.list(signal)).rejects.toBeInstanceOf(Error);
		await expect(rpc.get(ref, signal)).rejects.toBeInstanceOf(Error);
		await expect(rpc.refresh(ref, signal)).rejects.toBeInstanceOf(Error);
		expect(await rpc.claudeCodeUsage(signal)).toBeNull();
	});

	test("Claude failures (method_not_found and others) are null, not rejections", async () => {
		const quota = fakeQuotaClient();
		const { rpc } = bindFor(quota);
		const signal = new AbortController().signal;
		quota.respond("claudeCodeUsage", async () => {
			throw Object.assign(new Error("whatever"), {
				type: "rpc.method_not_found",
			});
		});
		expect(await rpc.claudeCodeUsage(signal)).toBeNull();
		quota.respond("claudeCodeUsage", async () => {
			throw transportError();
		});
		expect(await rpc.claudeCodeUsage(signal)).toBeNull();
	});

	test("list/get/refresh failures stay rejections with the original error", async () => {
		const quota = fakeQuotaClient();
		const failure = new Error("boom");
		for (const method of ["list", "get", "refresh"])
			quota.respond(method, async () => {
				throw failure;
			});
		const { rpc } = bindFor(quota);
		const signal = new AbortController().signal;
		const ref = { providerID: "p", authMethod: "oauth" };
		expect(await outcome(rpc.list(signal))).toEqual({ error: failure });
		expect(await outcome(rpc.get(ref, signal))).toEqual({ error: failure });
		expect(await outcome(rpc.refresh(ref, signal))).toEqual({ error: failure });
	});

	test("a transport failure after the caller aborted becomes an AbortError", async () => {
		const quota = fakeQuotaClient();
		const abort = new AbortController();
		for (const method of ["list", "get", "refresh", "claudeCodeUsage"])
			quota.respond(method, async () => {
				abort.abort();
				throw transportError();
			});
		const { rpc } = bindFor(quota);
		const ref = { providerID: "p", authMethod: "oauth" };
		const names: unknown[] = [];
		const nameOf = async (promise: Promise<unknown>) => {
			const result = await outcome(promise);
			const error = isObject(result) ? result.error : undefined;
			names.push(isObject(error) ? error.name : "resolved");
		};
		await nameOf(rpc.list(abort.signal));
		await nameOf(rpc.get(ref, abort.signal));
		await nameOf(rpc.refresh(ref, abort.signal));
		await nameOf(rpc.claudeCodeUsage(abort.signal));
		expect(names).toEqual([
			"AbortError",
			"AbortError",
			"AbortError",
			"AbortError",
		]);
	});

	test("a real AbortError rejects Claude even if the caller did not abort", async () => {
		const quota = fakeQuotaClient();
		quota.respond("claudeCodeUsage", async () => {
			throw new DOMException("aborted", "AbortError");
		});
		const { rpc } = bindFor(quota);
		const result = await outcome(
			rpc.claudeCodeUsage(new AbortController().signal),
		);
		expect(result).toHaveProperty("error");
	});

	const updatedData = {
		version: QUOTA_RPC_VERSION,
		providerID: "p",
		quota: { state: "unavailable", reason: "network_error", attemptedAt: 0 },
	};

	test("update events are guarded and unsubscribed", () => {
		const { rpc, fake } = bindFor(fakeQuotaClient());
		const seen: string[] = [];
		const off = rpc.onUpdated((event) => seen.push(event.providerID));
		fake.emit({ type: RPC_UPDATED, data: { nonsense: true } });
		fake.emit({ type: RPC_UPDATED });
		fake.emit({ type: RPC_UPDATED, data: updatedData });
		expect(seen).toEqual(["p"]);
		off();
		expect(fake.listeners(RPC_UPDATED)).toBe(0);
		fake.emit({ type: RPC_UPDATED, data: updatedData });
		expect(seen).toEqual(["p"]);
	});

	test("update events keep arriving after the server restarts, with no duplicates", async () => {
		const { rpc, fake } = bindFor(fakeQuotaClient());
		const seen: string[] = [];
		const off = rpc.onUpdated((event) => seen.push(event.providerID));
		expect(fake.listeners(RPC_UPDATED)).toBe(1);
		fake.restart();
		await flush();
		// The old controller was released; the new one has exactly one listener.
		expect(fake.listenersOf(0, RPC_UPDATED)).toBe(0);
		expect(fake.listeners(RPC_UPDATED)).toBe(1);
		fake.emit({ type: RPC_UPDATED, data: updatedData });
		expect(seen).toEqual(["p"]);
		fake.restart();
		await flush();
		fake.emit({ type: RPC_UPDATED, data: updatedData });
		expect(seen).toEqual(["p", "p"]);
		off();
		expect(fake.listeners()).toBe(0);
	});

	test("update events ignore non-builtin servers and end with the plugin signal", async () => {
		const { rpc, fake, abort } = bindFor(fakeQuotaClient());
		rpc.onUpdated(() => {});
		abort.abort();
		await flush();
		expect(fake.listeners()).toBe(0);
	});
});

// ---------- bindSessionHost ----------

function hostFor(sessionID = "s1") {
	const abort = new AbortController();
	const server = fakeServer();
	const [visible, setVisible] = createSignal(true);
	const [composer, setComposer] = createSignal<string | undefined>(undefined);
	const host = bindSessionHost({ signal: abort.signal }, sessionID, {
		server: () => server.server,
		composerProviderID: composer,
		visible,
	});
	return { host, server, abort, setVisible, setComposer };
}

const started = (
	sessionID: string,
	messageID: string,
	providerID: string,
): StepEvent => ({
	type: "session.step.started",
	data: {
		sessionID,
		assistantMessageID: messageID,
		model: { providerID, id: "m" },
	},
});
const finished = (
	type: "session.step.ended" | "session.step.failed",
	sessionID: string,
	messageID: string,
): StepEvent => ({
	type,
	data: { sessionID, assistantMessageID: messageID },
});

describe("bindSessionHost", () => {
	test("delivers initial visibility after subscribing, then changes", async () => {
		const { host, setVisible } = hostFor();
		const seen: boolean[] = [];
		const off = host.onVisible((value) => seen.push(value));
		expect(seen).toEqual([]);
		await flush();
		expect(seen).toEqual([true]);
		setVisible(false);
		await flush();
		setVisible(true);
		await flush();
		expect(seen).toEqual([true, false, true]);
		off();
		setVisible(false);
		await flush();
		expect(seen).toEqual([true, false, true]);
	});

	test("hidden at subscribe time is delivered as false", async () => {
		const { host, setVisible } = hostFor();
		setVisible(false);
		const seen: boolean[] = [];
		host.onVisible((value) => seen.push(value));
		await flush();
		expect(seen).toEqual([false]);
		expect(host.visible()).toBe(false);
	});

	test("selected provider follows the owning session's own model", async () => {
		const { host, server } = hostFor();
		expect(host.selectedProviderID()).toBeUndefined();
		let changes = 0;
		const off = host.onSelectedModel(() => {
			changes++;
		});
		server.setProvider("anthropic");
		await flush();
		expect(host.selectedProviderID()).toBe("anthropic");
		expect(changes).toBe(1);
		server.setProvider("anthropic");
		await flush();
		expect(changes).toBe(1);
		off();
		server.setProvider("openai");
		await flush();
		expect(changes).toBe(1);
	});

	test("the effective composer model wins over the durable session model", async () => {
		const { host, server, setComposer } = hostFor();
		server.setProvider("anthropic");
		expect(host.selectedProviderID()).toBe("anthropic");
		setComposer("openai");
		expect(host.selectedProviderID()).toBe("openai");
	});

	test("an absent durable model does not hide the composer default", () => {
		const { host, setComposer } = hostFor();
		expect(host.selectedProviderID()).toBeUndefined();
		setComposer("openai");
		expect(host.selectedProviderID()).toBe("openai");
	});

	test("an unavailable composer model falls back to the durable model", () => {
		const { host, server, setComposer } = hostFor();
		server.setProvider("anthropic");
		setComposer("openai");
		setComposer(undefined);
		expect(host.selectedProviderID()).toBe("anthropic");
	});

	test("a picker change without a prompt notifies onSelectedModel once", async () => {
		const { host, server, setComposer } = hostFor();
		server.setProvider("anthropic");
		let changes = 0;
		const off = host.onSelectedModel(() => {
			changes++;
		});
		setComposer("openai");
		await flush();
		expect(changes).toBe(1);
		setComposer("openai");
		await flush();
		expect(changes).toBe(1);
		// Back to a composer without a model: the durable model is selected again.
		setComposer(undefined);
		await flush();
		expect(changes).toBe(2);
		expect(host.selectedProviderID()).toBe("anthropic");
		off();
		setComposer("google");
		await flush();
		expect(changes).toBe(2);
	});

	test("only steps of the owning session reach onActivity, with the started provider", async () => {
		const { host, server } = hostFor("s1");
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		await flush();
		expect(server.listeners("session.step.started")).toBe(1);
		expect(server.listeners("session.step.ended")).toBe(1);
		expect(server.listeners("session.step.failed")).toBe(1);
		server.emit(started("s1", "m1", "anthropic"));
		server.emit(started("s2", "m1", "openai"));
		server.emit(finished("session.step.ended", "s2", "m1"));
		server.emit(finished("session.step.ended", "s1", "m1"));
		server.emit(started("s1", "m2", "openai"));
		server.emit(finished("session.step.failed", "s1", "m2"));
		// End without an observed start: no provider is guessed.
		server.emit(finished("session.step.ended", "s1", "m9"));
		// Malformed payloads are ignored.
		server.emit({ type: "session.step.started", data: { sessionID: "s1" } });
		server.emit({ type: "session.step.started" });
		await flush();
		expect(seen).toEqual([
			{ kind: "step-started", providerID: "anthropic" },
			{ kind: "step-finished", providerID: "anthropic" },
			{ kind: "step-started", providerID: "openai" },
			{ kind: "step-failed", providerID: "openai" },
		]);
	});

	test("an end is attributed once: a repeated end has no provider", async () => {
		const { host, server } = hostFor("s1");
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		await flush();
		server.emit(started("s1", "m1", "anthropic"));
		server.emit(finished("session.step.ended", "s1", "m1"));
		server.emit(finished("session.step.ended", "s1", "m1"));
		await flush();
		expect(seen.map((e) => e.kind)).toEqual(["step-started", "step-finished"]);
	});

	test("real key presses reset once each; input overlapping a keydown is not doubled", async () => {
		const { host } = hostFor();
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		const key = () =>
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
		key();
		document.dispatchEvent(new Event("input"));
		key();
		key();
		expect(seen).toEqual([
			{ kind: "input" },
			{ kind: "input" },
			{ kind: "input" },
		]);
	});

	test("input without a keydown (paste, IME) and pointer presses count; focus is reported", async () => {
		const { host } = hostFor();
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		document.dispatchEvent(new Event("input"));
		document.dispatchEvent(new Event("pointerdown"));
		window.dispatchEvent(new Event("focus"));
		expect(seen).toEqual([
			{ kind: "input" },
			{ kind: "input" },
			{ kind: "focus" },
		]);
	});

	test("native steps keep arriving after the server restarts, with no duplicates", async () => {
		const { host, server } = hostFor("s1");
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		await flush();
		server.emit(started("s1", "m1", "anthropic"));
		server.restart();
		await flush();
		// Prior controller released, one listener per step type on the new one.
		expect(server.listenersOf(0)).toBe(0);
		expect(server.listeners()).toBe(3);
		server.emit(started("s1", "m2", "openai"));
		server.emit(finished("session.step.ended", "s1", "m2"));
		expect(seen).toEqual([
			{ kind: "step-started", providerID: "anthropic" },
			{ kind: "step-started", providerID: "openai" },
			{ kind: "step-finished", providerID: "openai" },
		]);
		server.restart();
		await flush();
		expect(server.listenersOf(1)).toBe(0);
		expect(server.listeners()).toBe(3);
		server.emit(started("s1", "m3", "openai"));
		expect(seen).toHaveLength(4);
	});

	test("a start that predates a restart is forgotten: its end is not attributed, a new start works", async () => {
		const { host, server } = hostFor("s1");
		const seen: HostActivity[] = [];
		host.onActivity((event) => seen.push(event));
		await flush();
		server.emit(started("s1", "m1", "anthropic"));
		server.restart();
		await flush();
		server.emit(finished("session.step.ended", "s1", "m1"));
		server.emit(finished("session.step.failed", "s1", "m1"));
		expect(seen).toEqual([{ kind: "step-started", providerID: "anthropic" }]);
		server.emit(started("s1", "m2", "openai"));
		server.emit(finished("session.step.ended", "s1", "m2"));
		expect(seen).toEqual([
			{ kind: "step-started", providerID: "anthropic" },
			{ kind: "step-started", providerID: "openai" },
			{ kind: "step-finished", providerID: "openai" },
		]);
	});

	test("the plugin abort listener is released when the last subscription ends", async () => {
		const abort = new AbortController();
		let added = 0;
		let removed = 0;
		const original = {
			add: abort.signal.addEventListener.bind(abort.signal),
			remove: abort.signal.removeEventListener.bind(abort.signal),
		};
		abort.signal.addEventListener = (
			...args: Parameters<AbortSignal["addEventListener"]>
		) => {
			if (args[0] === "abort") added++;
			original.add(...args);
		};
		abort.signal.removeEventListener = (
			...args: Parameters<AbortSignal["removeEventListener"]>
		) => {
			if (args[0] === "abort") removed++;
			original.remove(...args);
		};
		const server = fakeServer();
		const [visible] = createSignal(true);
		const host = bindSessionHost({ signal: abort.signal }, "s1", {
			server: () => server.server,
			composerProviderID: () => undefined,
			visible,
		});
		const offs = [
			host.onActivity(() => {}),
			host.onVisible(() => {}),
			host.onSelectedModel(() => {}),
		];
		await flush();
		for (const off of offs) off();
		expect(added).toBeGreaterThan(0);
		expect(removed).toBe(added);
	});

	test("unsubscribing removes DOM listeners and ends the event stream", async () => {
		const { host, server } = hostFor();
		const seen: HostActivity[] = [];
		const off = host.onActivity((event) => seen.push(event));
		await flush();
		off();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
		window.dispatchEvent(new Event("focus"));
		server.emit(started("s1", "m1", "anthropic"));
		await flush();
		expect(seen).toEqual([]);
		expect(server.listeners()).toBe(0);
	});

	test("the plugin signal ends subscriptions", async () => {
		const { host, server, abort, setVisible } = hostFor();
		const seen: HostActivity[] = [];
		const visibility: boolean[] = [];
		host.onActivity((event) => seen.push(event));
		host.onVisible((value) => visibility.push(value));
		await flush();
		abort.abort();
		await flush();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
		setVisible(false);
		await flush();
		expect(seen).toEqual([]);
		expect(visibility).toEqual([true]);
		expect(server.listeners()).toBe(0);
	});
});

// ---------- entry ----------

type FakeSession = {
	key: string;
	id: string;
	server: SessionServer;
};

type FakeScreen = {
	readonly composer: {
		model(): { providerID: string; modelID: string } | undefined;
	};
};

/** A session screen whose composer model is a signal, like the host's reactive accessor. */
function fakeScreen(initial?: string) {
	const [provider, setProvider] = createSignal<string | undefined>(initial);
	const screen: FakeScreen = {
		composer: {
			model: () => {
				const providerID = provider();
				return providerID === undefined
					? undefined
					: { providerID, modelID: "m" };
			},
		},
	};
	return { screen, setProvider };
}

type PanelLike = {
	id: string;
	list(input: { open: readonly string[] }): readonly { id: string }[];
	render(props: {
		readonly session: FakeSession;
		readonly screen: FakeScreen;
	}): JSX.Element;
};
type CommandLike = {
	id: string;
	slash?: { name: string };
	run(): unknown;
};
type MenuLike = {
	menu: string;
	id: string;
	opened?: boolean;
	run(): void;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;
const isPanelLike = (value: unknown): value is PanelLike =>
	isObject(value) &&
	typeof value.render === "function" &&
	typeof value.list === "function";
const isCommandLike = (value: unknown): value is CommandLike =>
	isObject(value) && typeof value.run === "function" && "title" in value;
const isMenuLike = (value: unknown): value is MenuLike =>
	isObject(value) && value.menu === "session.panel";

const mounted: (() => void)[] = [];
afterEach(() => {
	for (const dispose of mounted.splice(0)) dispose();
	document.body.innerHTML = "";
});

function harness() {
	const quota = fakeQuotaClient();
	const rpcServer = fakeServer();
	const abort = new AbortController();
	const clock = fakeClock();
	const added: { registry: unknown; item: unknown }[] = [];
	const opened: [string, string][] = [];
	let layoutState: "closed" | "open" | "active" | "visible" = "closed";
	let current: FakeSession | undefined;
	const [visible, setVisible] = createSignal(true);

	const ctx: UsageSetupContext<FakeSession> = {
		id: "provider-usage",
		signal: abort.signal,
		client: { rpc: quota.rpc },
		servers: serversOf(rpcServer),
		add(registry, item) {
			added.push({ registry, item });
			return () => {};
		},
		layout: {
			open: (key, session) => {
				opened.push([key, session.key]);
				layoutState = "open";
			},
			state: () => layoutState,
		},
		sessions: { current: () => current },
	};
	const cleanup = setupUsage(ctx, {
		usePanel: () => ({ visible, present: () => true }),
		clock,
	});

	const panelItems = added
		.filter((entry) => entry.registry === Panel)
		.map((entry) => entry.item)
		.filter(isPanelLike);
	const commandItems = added
		.filter((entry) => entry.registry === Command)
		.map((entry) => entry.item)
		.filter(isCommandLike);
	const menuFactories = added
		.filter((entry) => entry.registry === MenuItem)
		.map((entry) => entry.item);

	const servers = new Map<string, ReturnType<typeof fakeServer>>();
	const sessions = (key: string): FakeSession => {
		let server = servers.get(key);
		if (server === undefined) {
			server = fakeServer();
			servers.set(key, server);
		}
		return { key: `srv\n${key}`, id: key, server: server.server };
	};
	const sessionServer = (key: string): ReturnType<typeof fakeServer> => {
		sessions(key);
		const server = servers.get(key);
		if (server === undefined) throw new Error("no session server");
		return server;
	};
	const initialScreen = fakeScreen();
	const [screen, setScreen] = createSignal<FakeScreen>(initialScreen.screen);

	const container = document.createElement("div");
	document.body.append(container);
	const [session, setSession] = createSignal<FakeSession>(sessions("s1"));

	const panel = panelItems[0];
	const mount = (): void => {
		if (panel === undefined) throw new Error("panel not registered");
		mounted.push(
			render(
				() =>
					panel.render({
						get session() {
							return session();
						},
						get screen() {
							return screen();
						},
					}),
				container,
			),
		);
	};

	return {
		quota,
		rpcServer,
		abort,
		clock,
		added,
		opened,
		cleanup,
		panelItems,
		commandItems,
		menuFactories,
		container,
		mount,
		sessions,
		sessionServer,
		setComposer: initialScreen.setProvider,
		setScreen,
		setSession,
		setVisible,
		setCurrent(value: FakeSession | undefined) {
			current = value;
		},
		menu(): MenuLike {
			const factory = menuFactories[0];
			if (typeof factory !== "function") throw new Error("no menu factory");
			const item: unknown = factory();
			if (!isMenuLike(item)) throw new Error("bad menu item");
			return item;
		},
	};
}

describe("entry selection source", () => {
	const gets = (h: ReturnType<typeof harness>) =>
		h.quota.calls.filter((c) => c.method === "get");

	test("a fresh session with no durable model follows the composer default", async () => {
		const h = harness();
		h.setComposer("openai");
		h.mount();
		await flush();
		expect(h.container.textContent).not.toContain("No model selected");
		expect(gets(h).map((c) => c.providerID)).toEqual(["openai"]);
	});

	test("the composer model wins over the durable session model", async () => {
		const h = harness();
		h.sessionServer("s1").setProvider("anthropic");
		h.setComposer("openai");
		h.mount();
		await flush();
		expect(gets(h).map((c) => c.providerID)).toEqual(["openai"]);
	});

	test("an unavailable composer model falls back to the durable model", async () => {
		const h = harness();
		h.sessionServer("s1").setProvider("anthropic");
		h.mount();
		await flush();
		expect(gets(h).map((c) => c.providerID)).toEqual(["anthropic"]);
	});

	test("a picker change without a prompt refetches and cancels the stale request", async () => {
		const h = harness();
		h.sessionServer("s1").setProvider("anthropic");
		h.setComposer("anthropic");
		h.mount();
		await flush();
		const first = gets(h)[0];
		expect(first?.providerID).toBe("anthropic");
		expect(first?.signal.aborted).toBe(false);
		h.setComposer("openai");
		await flush();
		expect(first?.signal.aborted).toBe(true);
		expect(gets(h).map((c) => c.providerID)).toEqual(["anthropic", "openai"]);
	});

	test("after a session switch the new session reads the live screen, and the old one is released", async () => {
		const h = harness();
		h.setComposer("anthropic");
		h.mount();
		await flush();
		const next = fakeScreen("openai");
		// The host routes the session and its screen together.
		batch(() => {
			h.setScreen(next.screen);
			h.setSession(h.sessions("s2"));
		});
		await flush();
		expect(gets(h).map((c) => c.providerID)).toEqual(["anthropic", "openai"]);
		const count = h.quota.calls.length;
		// The replaced screen is no longer read by anything.
		h.setComposer("google");
		await flush();
		expect(h.quota.calls).toHaveLength(count);
		next.setProvider("google");
		await flush();
		expect(gets(h).map((c) => c.providerID)).toEqual([
			"anthropic",
			"openai",
			"google",
		]);
	});
});

describe("entry registrations", () => {
	test("exactly one panel, command and menu item with distinct ids; zero rpc at setup", () => {
		const h = harness();
		expect(h.added).toHaveLength(3);
		expect(h.panelItems).toHaveLength(1);
		expect(h.commandItems).toHaveLength(1);
		expect(h.menuFactories).toHaveLength(1);
		const ids = [PANEL_ID, COMMAND_ID, MENU_ID];
		expect(new Set(ids).size).toBe(3);
		expect(h.panelItems[0]?.id).toBe(PANEL_ID);
		expect(h.commandItems[0]?.id).toBe(COMMAND_ID);
		expect(h.menu().id).toBe(MENU_ID);
		for (const id of ids) expect(id.startsWith("provider-usage")).toBe(true);
		expect(h.commandItems[0]?.slash?.name).toBeDefined();
		expect(h.quota.instantiations()).toBe(0);
		expect(h.quota.calls).toHaveLength(0);
		expect(h.clock.pending()).toBe(0);
	});

	test("the panel lists its single tab only when stored", () => {
		const h = harness();
		const panel = h.panelItems[0];
		expect(panel?.list({ open: [] })).toEqual([]);
		expect(panel?.list({ open: ["other"] })).toEqual([]);
		expect(panel?.list({ open: [PANEL_ID] }).map((tab) => tab.id)).toEqual([
			PANEL_ID,
		]);
	});

	test("the command opens the dashboard; the menu item opens the summary", async () => {
		const h = harness();
		const s1 = h.sessions("s1");
		h.setCurrent(undefined);
		h.commandItems[0]?.run();
		expect(h.opened).toEqual([]);

		h.setCurrent(s1);
		expect(h.menu().opened).toBe(false);
		h.commandItems[0]?.run();
		expect(h.opened).toEqual([[`provider-usage:${PANEL_ID}`, s1.key]]);
		expect(h.menu().opened).toBe(true);

		h.mount();
		await flush();
		expect(h.container.querySelector("[data-dashboard]")).not.toBeNull();
		expect(h.quota.calls.map((c) => c.method)).toContain("list");

		// A live panel is switched in place.
		h.menu().run();
		await flush();
		expect(h.container.querySelector("[data-dashboard]")).toBeNull();
		expect(h.container.querySelector(".ou-summary")).not.toBeNull();
		h.commandItems[0]?.run();
		await flush();
		expect(h.container.querySelector("[data-dashboard]")).not.toBeNull();
	});
});

describe("entry panel lifecycle", () => {
	test("renders the summary without rpc until visible; hidden panels never fetch", async () => {
		const h = harness();
		h.setVisible(false);
		h.mount();
		await flush();
		expect(h.container.querySelector(".ou-summary")).not.toBeNull();
		expect(h.quota.calls).toHaveLength(0);
		expect(h.clock.pending()).toBe(0);
	});

	test("initial visibility reaches the controller: a visible dashboard fetches", async () => {
		const h = harness();
		h.setCurrent(h.sessions("s1"));
		h.commandItems[0]?.run();
		h.mount();
		await flush();
		expect(h.quota.calls.filter((c) => c.method === "list")).toHaveLength(1);
		h.setVisible(false);
		await flush();
		expect(h.clock.pending()).toBe(0);
	});

	test("a session switch disposes the old controller and restores the prior view hidden, without fetch", async () => {
		const h = harness();
		const s1 = h.sessions("s1");
		const s2 = h.sessions("s2");
		h.setCurrent(s1);
		h.commandItems[0]?.run();
		h.mount();
		await flush();
		const listCall = h.quota.calls.find((c) => c.method === "list");
		expect(listCall?.signal.aborted).toBe(false);
		const subscriptionsBefore = h.rpcServer.listeners(RPC_UPDATED);
		expect(subscriptionsBefore).toBe(1);

		h.setSession(s2);
		await flush();
		// Old controller disposed: its request aborted, its subscription gone,
		// and the new (summary) session owns the only remaining subscription.
		expect(listCall?.signal.aborted).toBe(true);
		expect(h.rpcServer.listeners(RPC_UPDATED)).toBe(1);
		expect(h.container.querySelector("[data-dashboard]")).toBeNull();

		h.setVisible(false);
		await flush();
		expect(h.clock.pending()).toBe(0);
		const callsBefore = h.quota.calls.length;
		h.setSession(s1);
		await flush();
		expect(h.container.querySelector("[data-dashboard]")).not.toBeNull();
		expect(h.quota.calls).toHaveLength(callsBefore);
		expect(h.clock.pending()).toBe(0);
	});

	test("disposing the panel render disposes its controller", async () => {
		const h = harness();
		h.setCurrent(h.sessions("s1"));
		h.commandItems[0]?.run();
		h.mount();
		await flush();
		expect(h.rpcServer.listeners(RPC_UPDATED)).toBe(1);
		for (const dispose of mounted.splice(0)) dispose();
		expect(h.rpcServer.listeners(RPC_UPDATED)).toBe(0);
		expect(h.clock.pending()).toBe(0);
	});

	test("plugin dispose disposes every controller; the returned cleanup is idempotent", async () => {
		const h = harness();
		h.setCurrent(h.sessions("s1"));
		h.commandItems[0]?.run();
		h.mount();
		await flush();
		const listCall = h.quota.calls.find((c) => c.method === "list");
		h.abort.abort();
		await flush();
		expect(listCall?.signal.aborted).toBe(true);
		expect(h.rpcServer.listeners(RPC_UPDATED)).toBe(0);
		expect(h.clock.pending()).toBe(0);
		h.cleanup();
		h.cleanup();
	});
});

// ---------- SDK import boundary ----------

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : [path];
	});
}

describe("GUI SDK import boundary", () => {
	test("only the entry and the host binding import the GUI SDK", () => {
		const root = join(import.meta.dir, "../../src");
		const importers = [...sourceFiles(join(root, "gui")), join(root, "gui.tsx")]
			.filter((path) => /\.(ts|tsx)$/.test(path))
			.filter((path) =>
				/@opencode\/plugin\/gui/.test(readFileSync(path, "utf8")),
			)
			.map((path) => path.slice(root.length + 1))
			.sort();
		const allowed = new Set(["gui.tsx", join("gui", "host-binding.ts")]);
		expect(importers.every((path) => allowed.has(path))).toBe(true);
		expect(importers).toContain("gui.tsx");
	});
});

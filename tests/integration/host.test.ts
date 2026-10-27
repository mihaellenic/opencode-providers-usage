import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type {
	AdapterResolveInput,
	ProviderAdapter,
	ProviderCapability,
	QuotaRead,
} from "../../src/core/contracts";
import { createAdapterRegistry } from "../../src/core/registry";
import { QUOTA_ADAPTERS, setupQuotaServer } from "../../src/index";
import {
	createQuotaRpcHandlers,
	isClaudeUsage,
	type QuotaGetResult,
	type QuotaListResult,
	type QuotaProviderRef,
	QuotaRpc,
} from "../../src/rpc";
import {
	currentSelection,
	newestQuotaObservation,
	type QuotaKeymapCommand,
	type QuotaKeymapLayer,
	type QuotaTuiContext,
	setupQuotaTui,
	subscribeQuotaActivity,
} from "../../src/tui";

const NOW = 1_800_000_000_000;

test("newer RPC metadata supersedes old pushes and identity reset cannot be rolled back", () => {
	const view = (revision: number) => ({
		quota: unsupportedRead(),
		presentation: { revision },
	});
	const oldPush = view(5);
	const recovery = view(6);
	const reset = view(7);
	expect(newestQuotaObservation(oldPush, recovery)).toBe(recovery);
	expect(newestQuotaObservation(recovery, oldPush)).toBe(recovery);
	expect(newestQuotaObservation(reset, recovery)).toBe(reset);
	expect(newestQuotaObservation(recovery, { quota: unsupportedRead() })).toBe(
		recovery,
	);
});

test("activity observes keys/focus without contents and attributes/deduplicates completions", () => {
	const handlers = new Map<string, (event: unknown) => void>();
	const keys = new Map<string, () => void>();
	const focus = new Map<string, () => void>();
	const completed: string[] = [];
	const activity: string[] = [];
	const lookedUp: string[] = [];
	let disposals = 0;
	const context = {
		renderer: {
			keyInput: {
				on: (name: string, handler: () => void) => keys.set(name, handler),
				off: (name: string) => keys.delete(name),
			},
			on: (name: string, handler: () => void) => focus.set(name, handler),
			off: (name: string) => focus.delete(name),
		},
		ui: {
			model: { current: () => ({ providerID: "selected", modelID: "m" }) },
		},
		data: {
			on(name: string, handler: (event: unknown) => void) {
				handlers.set(name, handler);
				return () => {
					handlers.delete(name);
					disposals++;
				};
			},
			session: {
				message: {
					get: (_session: string, id: string) => {
						lookedUp.push(id);
						return id === "missed"
							? { type: "assistant", model: { providerID: "fallback" } }
							: undefined;
					},
				},
			},
		},
	} as unknown as QuotaTuiContext;
	const dispose = subscribeQuotaActivity(context, {
		begin: () => () => {},
		activity: (id) => activity.push(id),
		completed: (id) => completed.push(id),
		observe: () => {},
		dispose: () => {},
	});
	keys.get("keypress")?.();
	focus.get("focus")?.();
	expect(activity).toEqual(["selected", "selected"]);
	const emit = (name: string, id: string, providerID = "actual") =>
		handlers.get(name)?.({
			data: { sessionID: "s", assistantMessageID: id, model: { providerID } },
		});
	emit("session.step.started", "one");
	emit("session.step.ended", "one");
	emit("session.step.failed", "one");
	emit("session.step.failed", "missed");
	emit("session.step.ended", "unknown");
	expect(completed).toEqual(["actual", "fallback"]);
	expect(lookedUp).toEqual(["missed", "unknown"]);
	dispose();
	dispose();
	expect(disposals).toBe(3);
	expect(handlers.size + keys.size + focus.size).toBe(0);
	emit("session.step.ended", "late");
	expect(completed).toHaveLength(2);
	// Old/custom hosts without input/event surfaces remain usable.
	subscribeQuotaActivity({ data: {}, ui: context.ui } as QuotaTuiContext, {
		begin: () => () => {},
		activity: () => {},
		completed: () => {},
		observe: () => {},
		dispose: () => {},
	})();
});

function unsupportedRead(): QuotaRead {
	return {
		state: "unsupported",
		reason: "no_validated_quota_source",
		attemptedAt: NOW,
	};
}

function emptyRpcContext(signal: AbortSignal = new AbortController().signal) {
	return {
		signal,
		error: (type: string, message: string, data?: unknown) => ({
			type,
			message,
			data,
		}),
	};
}

function declaringAdapter(capabilities: ProviderCapability[]): ProviderAdapter {
	return {
		id: "test-declarations",
		capabilities,
		async resolve() {
			return null;
		},
	};
}

describe("QuotaRpc credential boundary", () => {
	test("rpc_rejects_credentials_and_unknown_fields", async () => {
		let reads = 0;
		const registry = createAdapterRegistry([declaringAdapter([])]);
		const handlers = createQuotaRpcHandlers({
			source: {
				registry,
				now: () => NOW,
				providers: async () => [{ providerID: "alpha", authMethod: "key" }],
				presentation: () => ({ revision: 0 }),
				read: async () => {
					reads += 1;
					return unsupportedRead();
				},
			},
		});
		const context = emptyRpcContext();
		const rejected = [
			{ providerID: "alpha", accessToken: "secret-bearer" },
			{ providerID: "alpha", credentialPath: "/home/me/.codex/auth.json" },
			{ providerID: "alpha", extra: true },
			{ accessToken: "secret-bearer" },
		];

		for (const input of rejected) {
			const got = await handlers.get(input as never, context as never);
			expect(got).toMatchObject({ type: "invalid_input" });
			const refreshed = await handlers.refresh(
				input as never,
				context as never,
			);
			expect(refreshed).toMatchObject({ type: "invalid_input" });
			const listed = await handlers.list(input as never, context as never);
			expect(listed).toMatchObject({ type: "invalid_input" });
		}

		expect(reads).toBe(0);

		const inputSchema = QuotaRpc.methods.get.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(inputSchema.properties ?? {})).toEqual(["providerID"]);
		const listSchema = QuotaRpc.methods.list.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(listSchema.additionalProperties).toBe(false);
		expect(Object.keys(listSchema.properties ?? {})).toEqual([]);
	});
});

type TuiRpcCall = { method: "get" | "refresh"; providerID: string };

function getResult(providerID: string) {
	return {
		version: 2,
		provider: {
			providerID,
			name: providerID,
			authMethod: "none",
			support: "unsupported",
			evidence: "unverified",
		},
		quota: unsupportedRead(),
	};
}

function fakeTuiContext(options: {
	current: () =>
		| { providerID: string; modelID: string; variant?: string }
		| undefined;
	calls: TuiRpcCall[];
	existingCommands?: QuotaKeymapCommand[];
}) {
	let layer: QuotaKeymapLayer | undefined;
	const toasts: string[] = [];
	const navigations: unknown[] = [];
	const context = {
		location: { directory: "/tmp/provider-usage-test" },
		theme: {
			text: {
				base: "#ffffff",
				muted: "#aaaaaa",
				faint: "#666666",
				action: { primary: { base: "#c3a6ef" } },
				feedback: {
					success: { base: "#a7d5b2" },
					warning: { base: "#ebc588" },
					error: { base: "#ff3355" },
				},
			},
		},
		client: {
			rpc: () => ({
				list: async () => ({ version: 2, providers: [] }),
				get: async (input: { providerID: string }) => {
					options.calls.push({ method: "get", providerID: input.providerID });
					return getResult(input.providerID);
				},
				refresh: async (input: { providerID: string }) => {
					options.calls.push({
						method: "refresh",
						providerID: input.providerID,
					});
					return getResult(input.providerID);
				},
			}),
		},
		data: {
			location: {
				provider: {
					list: () => [
						{ id: "alpha", name: "Alpha provider" },
						{ id: "beta", name: "Beta provider" },
					],
				},
			},
		},
		keymap: {
			layer(factory: () => QuotaKeymapLayer) {
				layer = factory();
			},
			commands: () => options.existingCommands ?? [],
		},
		ui: {
			model: { current: options.current },
			toast: {
				show(input: { message: string }) {
					toasts.push(input.message);
				},
			},
			router: {
				register: () => () => {},
				navigate: (destination: unknown) => {
					navigations.push(destination);
				},
				current: () => ({ type: "home" }),
			},
			slot: () => () => {},
		},
	};

	return {
		context: context as unknown as QuotaTuiContext,
		toasts,
		navigations,
		commands: () => layer?.commands ?? [],
	};
}

describe("TUI selection binding", () => {
	test("idle_detail_page_expires_without_a_push_or_network_request", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--conditions=browser",
				fileURLToPath(
					new URL("../fixtures/detail-page-live.ts", import.meta.url),
				),
			],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		if (result.status !== 0)
			throw new Error(`${result.stdout}\n${result.stderr}`);
		expect(result.stdout).toContain("detail-page-live: PASS");
	});
	test("selection_uses_prompt_provider_not_default", async () => {
		const serverDefault = { providerID: "server-default", modelID: "model-a" };
		const calls: TuiRpcCall[] = [];
		let selected:
			| { providerID: string; modelID: string; variant?: string }
			| undefined = {
			providerID: "alpha",
			modelID: "model-a",
		};
		const fake = fakeTuiContext({ current: () => selected, calls });
		const dispose = setupQuotaTui(fake.context);

		const usage = fake
			.commands()
			.find((command) => command.id === "provider-quota.usage");
		const refresh = fake
			.commands()
			.find((command) => command.id === "provider-quota.refresh");
		expect(usage?.palette).toBe(true);
		expect(usage?.slash?.name).toBe("usage");
		expect(refresh).toBeDefined();

		await refresh?.run?.();
		selected = { providerID: "beta", modelID: "model-a" };
		await refresh?.run?.();

		expect(calls).toEqual([
			{ method: "refresh", providerID: "alpha" },
			{ method: "refresh", providerID: "beta" },
		]);
		expect(serverDefault).toEqual({
			providerID: "server-default",
			modelID: "model-a",
		});
		expect(currentSelection(fake.context)).toEqual({
			providerID: "beta",
			label: "Beta provider",
		});

		selected = undefined;
		await refresh?.run?.();
		expect(fake.toasts.at(-1)).toBe("No provider selected");
		expect(calls).toHaveLength(2);
		expect(currentSelection(fake.context)).toEqual({
			label: "No provider selected",
		});
		expect(usage?.slash?.name).toBe("usage");

		dispose();
	});

	test("usage_slash_yields_to_an_existing_usage_command", () => {
		const fake = fakeTuiContext({
			current: () => undefined,
			calls: [],
			existingCommands: [
				{
					id: "someone-else.usage",
					palette: true,
					slash: { name: "usage" },
					run: () => {},
				},
			],
		});
		const dispose = setupQuotaTui(fake.context);
		const usage = fake
			.commands()
			.find((command) => command.id === "provider-quota.usage");
		expect(usage?.slash?.name).toBe("provider-usage");
		dispose();
	});

	test("registered_sidebar_slot_updates_under_browser_solid_conditions", () => {
		// Bun's default resolution picks solid-js/dist/server.js, where memos do
		// not recompute. Run the live slot probe in an isolated browser
		// conditions process instead of weakening production memo placement.
		// The probe is a plain script under tests/fixtures, so the default suite
		// discovers no skipped test from it.
		const result = spawnSync(
			process.execPath,
			[
				"--conditions=browser",
				fileURLToPath(
					new URL("../fixtures/sidebar-slot-live.ts", import.meta.url),
				),
			],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		if (result.status !== 0 || !stdout.includes("sidebar-slot-live: PASS")) {
			throw new Error(
				[
					`sidebar live slot probe failed (status ${String(result.status)})`,
					`stdout:\n${stdout}`,
					`stderr:\n${stderr}`,
					result.error === undefined ? "" : `error: ${String(result.error)}`,
				].join("\n"),
			);
		}
		expect(result.status).toBe(0);
		expect(stdout).toContain("sidebar-slot-live: PASS");
		expect(stdout).toContain("sidebar-slot-live: static-tree");
		expect(stdout).toContain("sidebar-slot-live: theme-updates");
		expect(stdout).toContain("sidebar-slot-live: navigation+disposal");
	});

	test("claude_usage_page_lifecycle_runs_under_browser_solid_conditions", () => {
		// Bun's default resolution picks solid-js/dist/server.js, where effects
		// and resources do not run. Mount the real QuotaUsagePage in an isolated
		// browser-conditions process, matching the existing live probes.
		const result = spawnSync(
			process.execPath,
			[
				"--conditions=browser",
				fileURLToPath(
					new URL("../fixtures/claude-usage-page-live.ts", import.meta.url),
				),
			],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		if (
			result.status !== 0 ||
			!stdout.includes("claude-usage-page-live: PASS")
		) {
			throw new Error(
				[
					`claude usage page probe failed (status ${String(result.status)})`,
					`stdout:\n${stdout}`,
					`stderr:\n${stderr}`,
					result.error === undefined ? "" : `error: ${String(result.error)}`,
				].join("\n"),
			);
		}
		expect(result.status).toBe(0);
		expect(stdout).toContain("claude-usage-page-live: mount+empty-inventory");
		expect(stdout).toContain(
			"claude-usage-page-live: ctrl+r-hidden+stale-abort",
		);
		expect(stdout).toContain("claude-usage-page-live: countdown+no-collect");
		expect(stdout).toContain("claude-usage-page-live: unmount-abort+cleanup");
	});
});

describe("QuotaRpc registry summaries", () => {
	test("list_summaries_come_from_registry_declarations", async () => {
		const capabilities: ProviderCapability[] = [
			{
				match: { providerID: "ollama", authMethod: "key" },
				name: "Ollama Cloud",
				support: "supported",
				evidence: "live-validated",
			},
			{
				match: { integrationID: "openai-shared", authMethod: "oauth" },
				name: "OpenAI shared plan",
				support: "requires-companion",
				evidence: "documented-only",
			},
		];
		const registry = createAdapterRegistry([declaringAdapter(capabilities)]);
		const providers: QuotaProviderRef[] = [
			{
				providerID: "ollama",
				integrationID: "ollama-cloud",
				authMethod: "key",
			},
			{
				providerID: "openai",
				integrationID: "openai-shared",
				authMethod: "oauth",
			},
			{ providerID: "other", authMethod: "none" },
		];
		const handlers = createQuotaRpcHandlers({
			source: {
				registry,
				now: () => NOW,
				providers: async () => providers,
				presentation: () => ({ revision: 0 }),
				read: async () => unsupportedRead(),
			},
		});

		const result = (await handlers.list(
			{},
			emptyRpcContext() as never,
		)) as QuotaListResult;

		expect(result.version).toBe(2);
		expect(result.providers.map((view) => view.provider)).toEqual([
			{
				providerID: "ollama",
				integrationID: "ollama-cloud",
				name: "Ollama Cloud",
				authMethod: "key",
				support: "supported",
				evidence: "live-validated",
			},
			{
				providerID: "openai",
				integrationID: "openai-shared",
				name: "OpenAI shared plan",
				authMethod: "oauth",
				support: "requires-companion",
				evidence: "documented-only",
			},
			{
				providerID: "other",
				name: "other",
				authMethod: "none",
				support: "unsupported",
				evidence: "unverified",
			},
		]);
		expect(result.providers.map((view) => view.quota)).toEqual([
			unsupportedRead(),
			unsupportedRead(),
			unsupportedRead(),
		]);
	});
});

describe("server provider mapping", () => {
	test("provider_refs_use_host_integration_metadata", async () => {
		const activeCalls: string[] = [];
		let registered:
			| {
					handlers: {
						list: (input: unknown, context: unknown) => Promise<unknown>;
					};
			  }
			| undefined;
		const context = {
			provider: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [
						{
							id: "openai",
							integrationID: "openai-shared",
							name: "OpenAI",
							activation: "enabled",
							package: "@opencode/ai/providers/openai",
						},
					],
				}),
			},
			integration: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [],
				}),
				connection: {
					active: async (integrationID: string) => {
						activeCalls.push(integrationID);
						return {
							type: "credential",
							id: "credential-1",
							label: "Account",
							method: "oauth",
						};
					},
					resolve: async () => undefined,
				},
			},
			rpc: {
				register: async (
					_definition: unknown,
					handlers: {
						list: (input: unknown, context: unknown) => Promise<unknown>;
					},
				) => {
					registered = { handlers };
					return {
						dispose: async () => {},
						events: { emit: async () => {} },
					};
				},
			},
		};

		await setupQuotaServer(context as never);
		expect(registered).toBeDefined();

		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			fetchCalls += 1;
			return originalFetch(...args);
		}) as typeof fetch;
		let result: QuotaListResult;
		try {
			result = (await registered?.handlers.list(
				{},
				emptyRpcContext(),
			)) as QuotaListResult;
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(fetchCalls).toBe(0);
		expect(activeCalls).toEqual(["openai-shared"]);

		expect(result.providers).toHaveLength(1);
		expect(result.providers[0]?.provider).toEqual({
			providerID: "openai",
			integrationID: "openai-shared",
			name: "openai",
			authMethod: "oauth",
			support: "unsupported",
			evidence: "unverified",
		});
		expect(result.providers[0]?.quota).toMatchObject({
			state: "unsupported",
			reason: "no_validated_quota_source",
		});
	});

	test("native_credential_source_bridges_active_host_connection", async () => {
		const activeCalls: string[] = [];
		const resolvedConnections: unknown[] = [];
		const credentialValue = {
			type: "oauth",
			methodID: "chatgpt-token-sharing",
			access: "host-native-access-sentinel",
			refresh: "host-native-refresh-sentinel",
			expires: NOW + 3_600_000,
			metadata: {
				clientID: "host-native-client-id",
				scopes: ["chatgpt.tokens.use.direct"],
			},
		};
		let registered:
			| {
					get: (input: unknown, context: unknown) => Promise<unknown>;
			  }
			| undefined;
		const context = {
			provider: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [
						{
							id: "alpha",
							name: "Alpha",
							activation: "enabled",
							package: "@opencode/ai/providers/openai",
						},
					],
				}),
			},
			integration: {
				connection: {
					active: async (integrationID: string) => {
						activeCalls.push(integrationID);
						if (integrationID === "no-active") {
							return undefined;
						}
						return {
							type: "credential",
							id: "credential-1",
							label: "Account",
							method: "oauth",
						};
					},
					resolve: async (connection: unknown) => {
						resolvedConnections.push(connection);
						return credentialValue;
					},
				},
			},
			rpc: {
				register: async (
					_definition: unknown,
					handlers: {
						get: (input: unknown, context: unknown) => Promise<unknown>;
					},
				) => {
					registered = { get: handlers.get };
					return {
						dispose: async () => {},
						events: { emit: async () => {} },
					};
				},
			},
		};

		const captured: AdapterResolveInput[] = [];
		const probe: ProviderAdapter = {
			id: "native-probe",
			capabilities: [],
			async resolve(input) {
				captured.push(input);
				return null;
			},
		};
		const index = QUOTA_ADAPTERS.push(probe) - 1;
		try {
			await setupQuotaServer(context as never);
			await registered?.get({ providerID: "alpha" }, emptyRpcContext());

			expect(captured).toHaveLength(1);
			const native = captured[0]?.nativeCredential;
			expect(native).toBeDefined();

			// Only the auth.json entry shape the adapters accept crosses the
			// bridge: no refresh token, expiry, or raw host value wrapper.
			expect(await native?.resolve("openai")).toEqual({
				type: "oauth",
				methodID: "chatgpt-token-sharing",
				access: "host-native-access-sentinel",
				metadata: {
					clientID: "host-native-client-id",
					scopes: ["chatgpt.tokens.use.direct"],
				},
			});
			expect(activeCalls).toEqual(["openai"]);
			expect(resolvedConnections).toHaveLength(1);

			// No active connection means "not observed", so the adapter can keep
			// its documented file-store fallback.
			expect(await native?.resolve("no-active")).toBeUndefined();
			expect(resolvedConnections).toHaveLength(1);
		} finally {
			QUOTA_ADAPTERS.splice(index, 1);
		}
	});

	test("rejecting_adapter_maps_to_invalid_response", async () => {
		let registered:
			| {
					get: (input: unknown, context: unknown) => Promise<unknown>;
			  }
			| undefined;
		const context = {
			provider: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [
						{
							id: "alpha",
							name: "Alpha",
							activation: "enabled",
							package: "@opencode/ai/providers/openai",
						},
					],
				}),
			},
			integration: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [],
				}),
				connection: {
					active: async () => undefined,
					resolve: async () => undefined,
				},
			},
			rpc: {
				register: async (
					_definition: unknown,
					handlers: {
						get: (input: unknown, context: unknown) => Promise<unknown>;
					},
				) => {
					registered = { get: handlers.get };
					return {
						dispose: async () => {},
						events: { emit: async () => {} },
					};
				},
			},
		};

		const adaptersBefore = [...QUOTA_ADAPTERS];
		const index =
			QUOTA_ADAPTERS.push({
				id: "rejecting-adapter",
				capabilities: [],
				async resolve() {
					throw new Error("adapter bug");
				},
			}) - 1;
		try {
			await setupQuotaServer(context as never);
			const result = (await registered?.get(
				{ providerID: "alpha" },
				emptyRpcContext(),
			)) as QuotaGetResult;
			expect(result.quota).toMatchObject({
				state: "unavailable",
				reason: "invalid_response",
			});
		} finally {
			QUOTA_ADAPTERS.splice(index, 1);
		}
		expect(QUOTA_ADAPTERS).toEqual(adaptersBefore);
	});
});

describe("Claude Code usage RPC", () => {
	const usage: ClaudeUsage = {
		session: { usedPercent: 37, resetsAt: NOW + 3_600_000 },
		week: { usedPercent: 64, resetsAt: NOW + 86_400_000 },
	};

	function claudeHarness(
		collect: (signal: AbortSignal) => Promise<ClaudeUsage | null>,
	) {
		let reads = 0;
		const signals: AbortSignal[] = [];
		const handlers = createQuotaRpcHandlers({
			source: {
				registry: createAdapterRegistry([]),
				now: () => NOW,
				providers: async () => [{ providerID: "alpha", authMethod: "key" }],
				presentation: () => ({ revision: 0 }),
				read: async () => {
					reads += 1;
					return unsupportedRead();
				},
			},
			claudeUsage: (signal) => {
				signals.push(signal);
				return collect(signal);
			},
		});
		return { handlers, signals, reads: () => reads };
	}

	function serverHarness() {
		let registered:
			| {
					definition: { methods: Record<string, unknown> };
					handlers: Record<
						string,
						(input: unknown, context: unknown) => Promise<unknown>
					>;
			  }
			| undefined;
		const context = {
			provider: {
				list: async () => ({
					location: { directory: "/tmp/provider-usage-test" },
					data: [],
				}),
			},
			integration: {
				connection: {
					active: async () => undefined,
					resolve: async () => undefined,
				},
			},
			rpc: {
				register: async (
					definition: { methods: Record<string, unknown> },
					handlers: Record<
						string,
						(input: unknown, context: unknown) => Promise<unknown>
					>,
				) => {
					registered = { definition, handlers };
					return {
						dispose: async () => {},
						events: { emit: async () => {} },
					};
				},
			},
		};
		return { context: context as never, registered: () => registered };
	}

	/** Fake collector that stays in flight until its signal aborts. */
	function collectUntilAbort(
		signals: AbortSignal[],
		started: () => void,
	): (signal: AbortSignal) => Promise<ClaudeUsage | null> {
		return (signal) => {
			signals.push(signal);
			started();
			return new Promise<ClaudeUsage | null>((resolve) => {
				if (signal.aborted) {
					resolve(null);
					return;
				}
				signal.addEventListener("abort", () => resolve(null), { once: true });
			});
		};
	}

	test("claude_usage_returns_only_validated_windows_and_leaves_inventory_unchanged", async () => {
		const harness = claudeHarness(async () => usage);
		const context = emptyRpcContext();
		const before = (await harness.handlers.list(
			{},
			context as never,
		)) as QuotaListResult;
		const readsAfterList = harness.reads();

		const got = await harness.handlers.claudeCodeUsage({}, context as never);

		expect(got).toEqual(usage);
		expect(harness.signals).toEqual([context.signal]);
		expect(isClaudeUsage(got)).toBe(true);
		expect(JSON.stringify(got)).not.toContain("terminal");

		const after = (await harness.handlers.list(
			{},
			context as never,
		)) as QuotaListResult;
		expect(after).toEqual(before);
		expect(after.providers.map((view) => view.provider.providerID)).toEqual([
			"alpha",
		]);
		expect(harness.reads()).toBe(readsAfterList + 1);

		const inputSchema = QuotaRpc.methods.claudeCodeUsage.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(inputSchema.properties ?? {})).toEqual([]);
		const outputSchema = QuotaRpc.methods.claudeCodeUsage.output as {
			oneOf?: readonly unknown[];
		};
		expect(outputSchema.oneOf).toHaveLength(2);
		expect(outputSchema.oneOf?.[1]).toEqual({ type: "null" });
		const usageSchema = outputSchema.oneOf?.[0] as {
			additionalProperties?: boolean;
			properties?: {
				session?: { properties?: Record<string, unknown> };
				week?: { properties?: Record<string, unknown> };
			};
		};
		expect(usageSchema.additionalProperties).toBe(false);
		const resetsAtSchema = {
			session: usageSchema.properties?.session?.properties?.resetsAt,
			week: usageSchema.properties?.week?.properties?.resetsAt,
		};
		expect(resetsAtSchema).toEqual({
			session: {
				type: "integer",
				minimum: 1,
				maximum: Number.MAX_SAFE_INTEGER,
			},
			week: {
				type: "integer",
				minimum: 1,
				maximum: Number.MAX_SAFE_INTEGER,
			},
		});
		expect(Object.keys(QuotaRpc.methods)).toEqual([
			"list",
			"get",
			"refresh",
			"claudeCodeUsage",
		]);
	});

	test("claude_usage_failures_and_malformed_output_yield_null", async () => {
		const invalid: unknown[] = [
			null,
			{ ...usage, session: { ...usage.session, usedPercent: 101 } },
			{ ...usage, week: { ...usage.week, usedPercent: Number.NaN } },
			{ ...usage, week: { ...usage.week, resetsAt: "tomorrow" } },
			{ ...usage, session: { ...usage.session, resetsAt: 0 } },
			{ ...usage, week: { ...usage.week, resetsAt: -1 } },
			{ ...usage, session: { ...usage.session, resetsAt: 1.5 } },
			{
				...usage,
				week: { ...usage.week, resetsAt: Number.MAX_SAFE_INTEGER + 1 },
			},
			{
				...usage,
				session: { ...usage.session, accessToken: "raw-terminal-sentinel" },
			},
			{ ...usage, extra: "raw-terminal-sentinel" },
			"raw-terminal-sentinel",
		];
		for (const value of invalid) {
			const harness = claudeHarness(async () => value as ClaudeUsage | null);
			expect(
				await harness.handlers.claudeCodeUsage({}, emptyRpcContext() as never),
			).toBeNull();
		}

		const throwing = claudeHarness(async () => {
			throw new Error("raw-terminal-sentinel");
		});
		expect(
			await throwing.handlers.claudeCodeUsage({}, emptyRpcContext() as never),
		).toBeNull();

		const withoutCollector = createQuotaRpcHandlers({
			source: {
				registry: createAdapterRegistry([]),
				now: () => NOW,
				providers: async () => [],
				presentation: () => ({ revision: 0 }),
				read: async () => unsupportedRead(),
			},
		});
		expect(
			await withoutCollector.claudeCodeUsage({}, emptyRpcContext() as never),
		).toBeNull();
	});

	test("claude_usage_propagates_transport_abort_and_discards_late_results", async () => {
		let captured: AbortSignal | undefined;
		let settle: ((value: ClaudeUsage) => void) | undefined;
		const harness = claudeHarness((signal) => {
			captured = signal;
			return new Promise<ClaudeUsage>((resolve) => {
				settle = resolve;
			});
		});
		const controller = new AbortController();
		const pending = harness.handlers.claudeCodeUsage(
			{},
			emptyRpcContext(controller.signal) as never,
		);
		expect(captured).toBe(controller.signal);

		controller.abort();
		settle?.(usage);

		expect(await pending).toBeNull();
	});

	test("claude_usage_does_not_call_collector_for_a_preaborted_transport", async () => {
		const harness = claudeHarness(async () => usage);
		const controller = new AbortController();
		controller.abort();

		expect(
			await harness.handlers.claudeCodeUsage(
				{},
				emptyRpcContext(controller.signal) as never,
			),
		).toBeNull();
		expect(harness.signals).toHaveLength(0);
	});

	test("claude_usage_rejects_input_fields_before_collecting", async () => {
		const harness = claudeHarness(async () => usage);
		for (const input of [
			{ providerID: "alpha" },
			{ prompt: "/usage" },
			"usage",
			1,
		]) {
			const got = await harness.handlers.claudeCodeUsage(
				input as never,
				emptyRpcContext() as never,
			);
			expect(got).toMatchObject({ type: "invalid_input" });
			expect(JSON.stringify(got)).not.toContain("usage");
		}
		expect(harness.signals).toHaveLength(0);
	});

	test("server_registers_page_only_claude_usage_and_aborts_without_spawning", async () => {
		const harness = serverHarness();
		const dispose = await setupQuotaServer(harness.context);
		try {
			const registered = harness.registered();
			expect(registered).toBeDefined();
			expect(Object.keys(registered?.definition.methods ?? {})).toEqual([
				"list",
				"get",
				"refresh",
				"claudeCodeUsage",
			]);

			const controller = new AbortController();
			controller.abort();
			const got = await registered?.handlers.claudeCodeUsage?.(
				{},
				emptyRpcContext(controller.signal),
			);
			// An already-aborted transport never reaches the CLI, so the real
			// collector returns null without spawning a subprocess.
			expect(got).toBeNull();

			const list = (await registered?.handlers.list?.(
				{},
				emptyRpcContext(),
			)) as QuotaListResult;
			expect(list).toEqual({ version: 2, providers: [] });
		} finally {
			await dispose();
		}
	});

	test("server_disposal_aborts_in_flight_claude_collection", async () => {
		const harness = serverHarness();
		const signals: AbortSignal[] = [];
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const dispose = await setupQuotaServer(harness.context, {
			claudeUsage: collectUntilAbort(signals, () => markStarted?.()),
		});
		const registered = harness.registered();
		const pending = registered?.handlers.claudeCodeUsage?.(
			{},
			emptyRpcContext(),
		);
		await started;
		const collected = signals[0];
		expect(collected?.aborted).toBe(false);

		await dispose();

		expect(collected?.aborted).toBe(true);
		expect(await pending).toBeNull();
	});

	test("server_combines_rpc_cancellation_with_its_lifecycle_signal", async () => {
		const harness = serverHarness();
		const signals: AbortSignal[] = [];
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const dispose = await setupQuotaServer(harness.context, {
			claudeUsage: collectUntilAbort(signals, () => markStarted?.()),
		});
		try {
			const controller = new AbortController();
			const pending = harness
				.registered()
				?.handlers.claudeCodeUsage?.({}, emptyRpcContext(controller.signal));
			await started;
			const collected = signals[0];
			expect(collected?.aborted).toBe(false);

			controller.abort();

			expect(collected?.aborted).toBe(true);
			expect(await pending).toBeNull();
		} finally {
			await dispose();
		}
	});
});

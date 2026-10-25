import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
	type QuotaGetResult,
	type QuotaListResult,
	type QuotaProviderRef,
	QuotaRpc,
} from "../../src/rpc";
import {
	currentSelection,
	type QuotaKeymapCommand,
	type QuotaKeymapLayer,
	type QuotaTuiContext,
	setupQuotaTui,
} from "../../src/tui";

const NOW = 1_800_000_000_000;

function unsupportedRead(): QuotaRead {
	return {
		state: "unsupported",
		reason: "no_validated_quota_source",
		attemptedAt: NOW,
	};
}

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

		QUOTA_ADAPTERS.push({
			id: "rejecting-adapter",
			capabilities: [],
			async resolve() {
				throw new Error("adapter bug");
			},
		});
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
			QUOTA_ADAPTERS.splice(0, QUOTA_ADAPTERS.length);
		}
	});
});

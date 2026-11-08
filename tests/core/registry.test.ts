import { describe, expect, test } from "bun:test";
import {
	type AdapterResolveInput,
	type CompanionOptions,
	type CredentialReadDeps,
	isQuotaRead,
	type NativeCredentialSource,
	type ProviderAdapter,
	type ProviderCapability,
	type ProviderDeps,
	type QuotaRead,
	type ResolvedQuotaSource,
} from "../../src/core/contracts";
import { createAdapterRegistry } from "../../src/core/registry";

const companion: CompanionOptions = { enabled: true, home: "/fake/home" };

function availableRead(): QuotaRead {
	return {
		state: "available",
		authSource: "opencode",
		sections: [
			{
				scope: "provider-balance",
				result: {
					state: "available",
					metrics: [
						{
							kind: "money",
							id: "balance",
							scope: "provider-balance",
							label: "Balance",
							currency: "USD",
							remaining: 12.5,
						},
					],
					fetchedAt: 1_800_000_000_000,
					expiresAt: 1_800_000_060_000,
				},
			},
		],
	};
}

function createFakeDeps() {
	const getJsonCalls: {
		url: string;
		headers: Record<string, string>;
		signal: AbortSignal;
	}[] = [];
	let nowCalls = 0;
	const deps: ProviderDeps = {
		now() {
			nowCalls += 1;
			return 1_800_000_000_000;
		},
		async getJson(url, headers, signal) {
			getJsonCalls.push({ url, headers, signal });
			return availableRead();
		},
	};
	const credentialDeps: CredentialReadDeps = {
		now: () => 1_800_000_000_000,
		env: {},
		homeDirectory: "/fake/home",
		async readUtf8() {
			throw new Error("registry tests never read credentials");
		},
	};
	return {
		deps,
		credentialDeps,
		getJsonCalls,
		nowCalls: () => nowCalls,
	};
}

function resolveInput(
	overrides: Partial<AdapterResolveInput> = {},
): AdapterResolveInput {
	const fake = createFakeDeps();
	return {
		providerID: "x",
		authMethod: "api-key",
		companion,
		deps: fake.deps,
		credentialDeps: fake.credentialDeps,
		signal: new AbortController().signal,
		...overrides,
	};
}

function source(
	identityKey: string,
	read: () => Promise<QuotaRead> = async () => availableRead(),
): ResolvedQuotaSource {
	return {
		identityKey,
		read: () => read(),
		isCurrent: async () => true,
	};
}

function adapter(
	id: string,
	capabilities: ProviderCapability[],
	resolve: ProviderAdapter["resolve"],
): ProviderAdapter {
	return { id, capabilities, resolve };
}

describe("adapter registry", () => {
	test("resolves_in_registration_order_first_match_wins", async () => {
		const calls: string[] = [];
		const first = adapter("first", [], async () => {
			calls.push("first");
			return source("first-key");
		});
		const second = adapter("second", [], async () => {
			calls.push("second");
			return source("second-key");
		});

		const registry = createAdapterRegistry([first, second]);
		const resolved = await registry.resolve(resolveInput());

		expect(resolved?.identityKey).toBe("first-key");
		expect(calls).toEqual(["first"]);
	});

	test.each([
		["declining adapter falls through to next", true, "second-key"],
		["no match returns null", false, undefined],
	])("%s", async (_name, secondMatches, expectedKey) => {
		const calls: string[] = [];
		const first = adapter("first", [], async () => {
			calls.push("first");
			return null;
		});
		const second = adapter("second", [], async () => {
			calls.push("second");
			return secondMatches ? source("second-key") : null;
		});

		const registry = createAdapterRegistry([first, second]);
		const resolved = await registry.resolve(resolveInput());

		expect(resolved?.identityKey).toBe(expectedKey);
		if (!secondMatches) expect(resolved).toBeNull();
		expect(calls).toEqual(["first", "second"]);
	});

	test("forwards_native_credential_source_to_adapters", async () => {
		let received: AdapterResolveInput | undefined;
		const native: NativeCredentialSource = {
			async resolve() {
				return undefined;
			},
		};
		const registry = createAdapterRegistry([
			adapter("probe", [], async (input) => {
				received = input;
				return null;
			}),
		]);

		expect(
			await registry.resolve(resolveInput({ nativeCredential: native })),
		).toBeNull();
		expect(received?.nativeCredential).toBe(native);
	});

	test.each([
		[
			"declared capability by provider id",
			{
				match: { providerID: "x", authMethod: "api-key" },
				name: "X Cloud",
				support: "supported",
				evidence: "live-validated",
			} as ProviderCapability,
			{ providerID: "x", authMethod: "api-key" },
			{
				providerID: "x",
				name: "X Cloud",
				authMethod: "api-key",
				support: "supported",
				evidence: "live-validated",
			},
		],
		[
			"declared capability by integration id",
			{
				match: { integrationID: "integration-7", authMethod: "any" },
				name: "Integration Cloud",
				support: "requires-companion",
				evidence: "documented-only",
			} as ProviderCapability,
			{
				providerID: "different-provider-id",
				integrationID: "integration-7",
				authMethod: "oauth",
			},
			{
				providerID: "different-provider-id",
				integrationID: "integration-7",
				name: "Integration Cloud",
				authMethod: "oauth",
				support: "requires-companion",
				evidence: "documented-only",
			},
		],
	])("summarize matches %s", (_name, declared, query, expected) => {
		const registry = createAdapterRegistry([
			adapter("a", [declared], async () => null),
		]);

		expect(registry.summarize(query)).toEqual(
			expected as ReturnType<typeof registry.summarize>,
		);
	});

	test("summarize_synthesizes_unsupported_when_undeclared", () => {
		const declared: ProviderCapability = {
			match: { providerID: "x", authMethod: "api-key" },
			name: "X Cloud",
			support: "supported",
			evidence: "live-validated",
		};
		const registry = createAdapterRegistry([
			adapter("x", [declared], async () => null),
		]);

		expect(
			registry.summarize({ providerID: "unknown", authMethod: "oauth" }),
		).toEqual({
			providerID: "unknown",
			name: "unknown",
			authMethod: "oauth",
			support: "unsupported",
			evidence: "unverified",
		});
	});

	test("third_adapter_needs_no_core_changes", async () => {
		const fake = createFakeDeps();
		const signal = new AbortController().signal;
		let received: AdapterResolveInput | undefined;

		const firstCapability: ProviderCapability = {
			match: { providerID: "x", authMethod: "api-key" },
			name: "X Cloud",
			support: "supported",
			evidence: "live-validated",
		};
		const secondCapability: ProviderCapability = {
			match: { providerID: "y", authMethod: "any" },
			name: "Y Cloud",
			support: "not-applicable",
			evidence: "documented-only",
		};
		const thirdCapability: ProviderCapability = {
			match: { providerID: "third", authMethod: "any" },
			name: "Third Cloud",
			support: "supported",
			evidence: "documented-only",
		};

		// Written only against ProviderAdapter: no knowledge of core siblings.
		const third: ProviderAdapter = {
			id: "third-synthetic",
			capabilities: [thirdCapability],
			async resolve(input) {
				received = input;
				if (input.providerID !== "third") {
					return null;
				}
				return {
					identityKey: `third:${input.providerID}`,
					async read(readSignal) {
						const body = await input.deps.getJson(
							"https://third.example/quota",
							{ authorization: "Bearer fake" },
							readSignal,
						);
						return body as QuotaRead;
					},
					async isCurrent() {
						return true;
					},
				};
			},
		};

		const registry = createAdapterRegistry([
			adapter("first", [firstCapability], async () => null),
			adapter("second", [secondCapability], async () => null),
			third,
		]);

		expect(registry.capabilities()).toEqual([
			firstCapability,
			secondCapability,
			thirdCapability,
		]);

		const resolved = await registry.resolve(
			resolveInput({
				providerID: "third",
				authMethod: "oauth",
				companion,
				deps: fake.deps,
				credentialDeps: fake.credentialDeps,
				signal,
			}),
		);

		expect(resolved?.identityKey).toBe("third:third");
		expect(received?.companion).toEqual(companion);
		expect(received?.credentialDeps).toBe(fake.credentialDeps);
		expect(received?.signal).toBe(signal);

		const read = await resolved?.read(signal);
		expect(read).toEqual(availableRead());
		expect(isQuotaRead(read)).toBe(true);
		expect(fake.getJsonCalls).toEqual([
			{
				url: "https://third.example/quota",
				headers: { authorization: "Bearer fake" },
				signal,
			},
		]);
	});
});

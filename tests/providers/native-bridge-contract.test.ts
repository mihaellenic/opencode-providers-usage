import { describe, expect, test } from "bun:test";
import {
	type AdapterResolveInput,
	type CredentialReadDeps,
	isQuotaRead,
	type NativeCredentialSource,
	type ProviderAdapter,
	type ProviderDeps,
	type ResolvedQuotaSource,
} from "../../src/core/contracts";
import { createOllamaAdapter } from "../../src/providers/ollama";
import { createOpenAICompanionAdapter } from "../../src/providers/openai-companion";

const NOW = 1_790_000_000_000;
const DATA_HOME = "/synthetic/data";

type BridgeCase = {
	/** What the host bridge returns; "throw" simulates a bridge failure. */
	host: "valid" | "undefined" | "throw";
	/** "distinct" stores a credential that could only be read by mistake. */
	fileStore: "distinct" | "valid";
	hostError?: string;
};

type Run = {
	source: ResolvedQuotaSource;
	requests: { url: string; headers: Record<string, string> }[];
	fileReads: number;
	nativeReads: string[];
};

type Fixture = {
	name: string;
	integrationID: string;
	hostSecret: string;
	/** Bearer sent upstream when the host credential is the active one. */
	hostBearer: string;
	/** Bearer sent upstream when the file store credential is the active one. */
	fileBearer: string;
	run(testCase: BridgeCase): Promise<Run>;
};

const OPENAI_CLIENT_ID = "synthetic-openai-client-id";
const OPENAI_OTHER_CLIENT_ID = "synthetic-other-openai-client-id";
const OPENAI_COMPANION_TOKEN = "companion-bearer-sentinel-do-not-leak";
const OPENAI_APPS_URL =
	"https://chatgpt.com/backend-api/wham/usage/chatpass/apps";
const OPENAI_PLAN_URL = "https://chatgpt.com/backend-api/wham/usage";
const OLLAMA_KEY = "ollama-sentinel-key-do-not-leak";
const OLLAMA_HOST_KEY = "host-native-ollama-key";

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function openaiEntry(clientID: string): Record<string, unknown> {
	const claims = {
		iss: "https://auth.openai.com",
		aud: "https://api.openai.com/v1",
		client_id: clientID,
		scope:
			"openid profile email offline_access chatgpt.tokens.use.direct resource.invoke",
		exp: NOW / 1000 + 3600,
		sub: "synthetic-native-subject",
	};
	return {
		type: "oauth",
		methodID: "chatgpt-token-sharing",
		access: `${b64(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64(JSON.stringify(claims))}.native-token-sharing-bearer-sentinel`,
		refresh: "native-refresh-sentinel-do-not-leak",
		expires: NOW + 3_600_000,
		metadata: {
			clientID,
			scopes: ["openid", "chatgpt.tokens.use.direct"],
		},
	};
}

function nativeSource(
	testCase: BridgeCase,
	hostValue: unknown,
	reads: string[],
): NativeCredentialSource {
	return {
		async resolve(integrationID) {
			reads.push(integrationID);
			if (testCase.host === "throw") {
				throw new Error(`host bridge failed for ${testCase.hostError}`);
			}
			return testCase.host === "valid" ? hostValue : undefined;
		},
	};
}

async function resolveSource(
	adapter: ProviderAdapter,
	input: AdapterResolveInput,
): Promise<ResolvedQuotaSource> {
	const source = await adapter.resolve(input);
	if (source === null) {
		throw new Error("adapter declined the provider");
	}
	return source;
}

const openai: Fixture = {
	name: "openai-companion",
	integrationID: "openai",
	hostSecret: "native-token-sharing-bearer-sentinel",
	hostBearer: OPENAI_COMPANION_TOKEN,
	fileBearer: OPENAI_COMPANION_TOKEN,
	async run(testCase) {
		const requests: Run["requests"] = [];
		const nativeReads: string[] = [];
		let fileReads = 0;
		const store = {
			openai: openaiEntry(
				testCase.fileStore === "distinct"
					? OPENAI_OTHER_CLIENT_ID
					: OPENAI_CLIENT_ID,
			),
		};
		const deps: ProviderDeps = {
			now: () => NOW,
			async getJson(url, headers) {
				requests.push({ url, headers });
				if (url === OPENAI_APPS_URL) {
					return {
						items: [
							{
								id: OPENAI_CLIENT_ID,
								allowed_usage_percent: 100,
								windows: [
									{
										used_percent: 10,
										remaining_percent: 90,
										limit_window_seconds: 604_800,
										reset_at: 1_790_500_000,
									},
								],
							},
						],
					};
				}
				if (url === OPENAI_PLAN_URL) {
					return {
						rate_limit: {
							primary_window: {
								used_percent: 20,
								remaining_percent: 80,
								limit_window_seconds: 604_800,
								reset_at: 1_791_000_000,
							},
							secondary_window: null,
						},
					};
				}
				throw new Error(`unexpected quota URL: ${url}`);
			},
		};
		const credentialDeps: CredentialReadDeps = {
			now: () => NOW,
			env: { XDG_DATA_HOME: DATA_HOME },
			homeDirectory: "/synthetic/home",
			async readUtf8() {
				fileReads += 1;
				return JSON.stringify(store);
			},
		};
		const adapter = createOpenAICompanionAdapter({
			async readCompanion() {
				return {
					state: "available",
					credential: {
						accessToken: OPENAI_COMPANION_TOKEN,
						accountID: "synthetic-companion-account-id",
						expiresAt: NOW + 3_600_000,
						identityKey: "synthetic-companion-identity-a",
					},
				};
			},
		});
		const source = await resolveSource(adapter, {
			providerID: "openai",
			integrationID: "openai",
			authMethod: "oauth",
			companion: { enabled: true },
			deps,
			credentialDeps,
			signal: new AbortController().signal,
			nativeCredential: nativeSource(
				testCase,
				openaiEntry(OPENAI_CLIENT_ID),
				nativeReads,
			),
		});
		return {
			source,
			requests,
			nativeReads,
			get fileReads() {
				return fileReads;
			},
		};
	},
};

const ollama: Fixture = {
	name: "ollama",
	integrationID: "ollama-cloud",
	hostSecret: OLLAMA_HOST_KEY,
	hostBearer: OLLAMA_HOST_KEY,
	fileBearer: OLLAMA_KEY,
	async run(testCase) {
		const requests: Run["requests"] = [];
		const nativeReads: string[] = [];
		let fileReads = 0;
		const deps: ProviderDeps = {
			now: () => NOW,
			async getJson(url, headers) {
				requests.push({ url, headers });
				return {
					included: {
						balance_usd: 40,
						allowance_usd: 60,
						period: {
							from: "2026-09-15T09:30:00Z",
							until: "2026-10-15T09:30:00Z",
						},
					},
					purchased: { balance_usd: 5 },
				};
			},
		};
		const credentialDeps: CredentialReadDeps = {
			now: () => NOW,
			env: { XDG_DATA_HOME: DATA_HOME },
			homeDirectory: "/synthetic/home",
			async readUtf8() {
				fileReads += 1;
				return JSON.stringify({
					"ollama-cloud": { type: "api", key: OLLAMA_KEY },
				});
			},
		};
		const source = await resolveSource(createOllamaAdapter(), {
			providerID: "ollama",
			integrationID: "ollama-cloud",
			authMethod: "key",
			companion: { enabled: false },
			deps,
			credentialDeps,
			signal: new AbortController().signal,
			nativeCredential: nativeSource(
				testCase,
				{ type: "key", key: OLLAMA_HOST_KEY },
				nativeReads,
			),
		});
		return {
			source,
			requests,
			nativeReads,
			get fileReads() {
				return fileReads;
			},
		};
	},
};

describe.each([openai, ollama])(
	"native host credential bridge: $name",
	(fx) => {
		const signal = () => new AbortController().signal;

		test("prefers the host credential over the file store", async () => {
			const run = await fx.run({ host: "valid", fileStore: "distinct" });

			expect(await run.source.isCurrent()).toBe(true);
			const read = await run.source.read(signal());

			expect(isQuotaRead(read)).toBe(true);
			expect(read.state).toBe("available");
			// The file store is never read, not even for currentness.
			expect(run.fileReads).toBe(0);
			expect(run.nativeReads.length).toBeGreaterThan(0);
			expect(new Set(run.nativeReads)).toEqual(new Set([fx.integrationID]));
			expect(run.requests.length).toBeGreaterThan(0);
			for (const request of run.requests) {
				expect(request.headers.Authorization).toBe(`Bearer ${fx.hostBearer}`);
			}
			expect(JSON.stringify(read)).not.toContain(fx.hostSecret);
			expect(JSON.stringify(run.source)).not.toContain(fx.hostSecret);
		});

		test("falls back to the file store when the host returns undefined", async () => {
			const run = await fx.run({ host: "undefined", fileStore: "valid" });

			expect(run.nativeReads).toEqual([fx.integrationID]);
			expect(await run.source.isCurrent()).toBe(true);
			const read = await run.source.read(signal());

			expect(isQuotaRead(read)).toBe(true);
			expect(read.state).toBe("available");
			expect(run.fileReads).toBeGreaterThan(0);
			expect(run.requests.length).toBeGreaterThan(0);
			for (const request of run.requests) {
				expect(request.headers.Authorization).toBe(`Bearer ${fx.fileBearer}`);
			}
		});

		test("host credential error maps to sanitized unavailable without requests", async () => {
			const secret = `host-bridge-error-sentinel-${fx.name}`;
			const run = await fx.run({
				host: "throw",
				fileStore: "valid",
				hostError: secret,
			});

			const read = await run.source.read(signal());

			expect(isQuotaRead(read)).toBe(true);
			expect(read).toEqual({
				state: "unavailable",
				reason: "invalid_response",
				attemptedAt: NOW,
			});
			expect(JSON.stringify(read)).not.toContain(secret);
			expect(await run.source.isCurrent()).toBe(false);
			expect(run.requests).toHaveLength(0);
			expect(run.fileReads).toBe(0);
		});
	},
);

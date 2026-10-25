import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type CompanionRead,
	type CredentialReadDeps,
	type NativeCredentialSource,
	type ProviderCapability,
	type ProviderDeps,
	QUOTA_REASON_CODES,
	type QuotaRead,
	QuotaRequestError,
} from "../../src/core/contracts";
import { createAdapterRegistry } from "../../src/core/registry";
import { getQuotaJson } from "../../src/providers/http";
import { createOllamaAdapter } from "../../src/providers/ollama";
import { createOpenAICompanionAdapter } from "../../src/providers/openai-companion";
import {
	createQuotaRpcHandlers,
	type QuotaProviderRef,
	type QuotaReadRequest,
	QuotaRpc,
	type QuotaRpcSource,
} from "../../src/rpc";

const NOW = 1_800_000_000_000;

const ACCESS_SENTINEL = "security-access-token-sentinel";
const REFRESH_SENTINEL = "security-refresh-token-sentinel";
const ACCOUNT_SENTINEL = "security-account-id-sentinel";
const CLIENT_SENTINEL = "security-client-id-sentinel";
const COMPANION_SENTINEL = "security-companion-token-sentinel";
const FILE_SENTINEL = "security-credential-file-sentinel";

const SENTINELS = [
	ACCESS_SENTINEL,
	REFRESH_SENTINEL,
	ACCOUNT_SENTINEL,
	CLIENT_SENTINEL,
	COMPANION_SENTINEL,
	FILE_SENTINEL,
];

function emptyContext(signal: AbortSignal = new AbortController().signal) {
	return {
		signal,
		error: (type: string, message: string, data?: unknown) => ({
			type,
			message,
			data,
		}),
	};
}

function credentialDeps(
	overrides: Partial<CredentialReadDeps> = {},
): CredentialReadDeps {
	return {
		now: () => NOW,
		env: {},
		homeDirectory: `/fixture/${FILE_SENTINEL}/home`,
		readUtf8: async () => {
			throw new Error(`unreadable credential file: ${FILE_SENTINEL}`);
		},
		...overrides,
	};
}

function providerDeps(getJson: ProviderDeps["getJson"]): ProviderDeps {
	return { now: () => NOW, getJson };
}

function jwt(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function nativeKeyCredential(key: string): NativeCredentialSource {
	return { resolve: async () => ({ type: "key", key }) };
}

function nativeOpenAICredential(): NativeCredentialSource {
	return {
		resolve: async () => ({
			type: "oauth",
			methodID: "chatgpt-token-sharing",
			access: jwt({
				iss: "https://auth.openai.com",
				aud: "https://api.openai.com/v1",
				scope: "chatgpt.tokens.use.direct",
				client_id: CLIENT_SENTINEL,
				chatgpt_account_id: ACCOUNT_SENTINEL,
				exp: Math.floor((NOW + 3_600_000) / 1000),
			}),
			refresh: REFRESH_SENTINEL,
			expires: NOW + 3_600_000,
			metadata: {
				clientID: CLIENT_SENTINEL,
				scopes: ["chatgpt.tokens.use.direct"],
			},
		}),
	};
}

const COMPANION_AVAILABLE: CompanionRead = {
	state: "available",
	credential: {
		accessToken: COMPANION_SENTINEL,
		accountID: ACCOUNT_SENTINEL,
		expiresAt: NOW + 3_600_000,
		identityKey: "synthetic-companion-fingerprint",
	},
};

function buildStack(options: {
	providers: QuotaProviderRef[];
	deps: ProviderDeps;
	credentialDeps: CredentialReadDeps;
	nativeCredential?: NativeCredentialSource;
	readCompanion?: () => Promise<CompanionRead>;
	onRead?: () => void;
}) {
	const registry = createAdapterRegistry([
		createOllamaAdapter(),
		createOpenAICompanionAdapter({
			readCompanion:
				options.readCompanion ??
				(async () => ({ state: "unavailable", reason: "companion_disabled" })),
		}),
	]);

	const source: QuotaRpcSource = {
		registry,
		now: () => NOW,
		providers: async () => options.providers,
		read: async (input: QuotaReadRequest) => {
			options.onRead?.();
			const resolved = await registry.resolve({
				providerID: input.providerID,
				...(input.integrationID === undefined
					? {}
					: { integrationID: input.integrationID }),
				authMethod: input.authMethod,
				companion: { enabled: false },
				deps: options.deps,
				credentialDeps: options.credentialDeps,
				...(options.nativeCredential === undefined
					? {}
					: { nativeCredential: options.nativeCredential }),
				signal: input.signal,
			});
			if (resolved === null) {
				return {
					state: "unsupported",
					reason: "no_validated_quota_source",
					attemptedAt: NOW,
				};
			}
			return resolved.read(input.signal);
		},
	};

	return { registry, handlers: createQuotaRpcHandlers({ source }) };
}

function captureLogs(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const methods = ["log", "error", "warn", "info", "debug"] as const;
	const originals = new Map<string, (...args: unknown[]) => void>();
	for (const method of methods) {
		originals.set(method, console[method] as (...args: unknown[]) => void);
		console[method] = (...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		};
	}
	return {
		lines,
		restore: () => {
			for (const method of methods) {
				const original = originals.get(method);
				if (original !== undefined) {
					console[method] = original as never;
				}
			}
		},
	};
}

function expectNoSentinels(
	label: string,
	value: unknown,
	logs: string[],
): void {
	const serialized = JSON.stringify(value);
	for (const sentinel of SENTINELS) {
		expect({ label, serialized }).not.toMatchObject({
			serialized: expect.stringContaining(sentinel),
		});
		expect(logs.join("\n")).not.toContain(sentinel);
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RPC credential boundary", () => {
	test("rpc_and_errors_never_disclose_credential_sentinels", async () => {
		const captured = captureLogs();
		try {
			// Success: the synthetic key really reaches the allowlisted request,
			// while unvalidated payload fields (including sentinels) never cross
			// the RPC boundary.
			const sentRequests: {
				url: string;
				headers: Record<string, string>;
			}[] = [];
			const success = buildStack({
				providers: [
					{
						providerID: "ollama",
						integrationID: "ollama-cloud",
						authMethod: "key",
					},
				],
				deps: providerDeps(async (url, headers) => {
					sentRequests.push({ url, headers });
					return {
						included: {
							balance_usd: 40,
							allowance_usd: 60,
							period: { until: "2030-01-01T00:00:00Z" },
						},
						purchased: { balance_usd: 5 },
						accessToken: ACCESS_SENTINEL,
						refresh_token: REFRESH_SENTINEL,
					};
				}),
				credentialDeps: credentialDeps(),
				nativeCredential: nativeKeyCredential(ACCESS_SENTINEL),
			});
			const got = await success.handlers.get(
				{ providerID: "ollama" },
				emptyContext() as never,
			);
			expect(sentRequests).toHaveLength(1);
			expect(sentRequests[0]?.url).toBe("https://ollama.com/api/balance");
			expect(sentRequests[0]?.headers.Authorization).toBe(
				`Bearer ${ACCESS_SENTINEL}`,
			);
			const successResult = got as {
				version: number;
				provider: { providerID: string };
				quota: QuotaRead;
			};
			expect(successResult.provider.providerID).toBe("ollama");
			expect(successResult.quota).toMatchObject({
				state: "available",
				authSource: "opencode",
			});
			expectNoSentinels("success", got, captured.lines);

			// Malformed provider payload: sentinel-laden error shapes collapse to
			// the frozen invalid_response reason.
			const malformed = buildStack({
				providers: [
					{
						providerID: "ollama",
						integrationID: "ollama-cloud",
						authMethod: "key",
					},
				],
				deps: providerDeps(async () => ({
					included: {
						balance_usd: ACCESS_SENTINEL,
						allowance_usd: ACCOUNT_SENTINEL,
					},
					error: FILE_SENTINEL,
					credential: { accessToken: ACCESS_SENTINEL },
				})),
				credentialDeps: credentialDeps(),
				nativeCredential: nativeKeyCredential(ACCESS_SENTINEL),
			});
			const malformedResult = await malformed.handlers.refresh(
				{ providerID: "ollama" },
				emptyContext() as never,
			);
			expect(malformedResult).toMatchObject({
				quota: { state: "unavailable", reason: "invalid_response" },
			});
			expectNoSentinels("malformed", malformedResult, captured.lines);

			// Credential read error from the host bridge: the exception text
			// (which carries a sentinel) is never surfaced.
			const hostError = buildStack({
				providers: [
					{
						providerID: "ollama",
						integrationID: "ollama-cloud",
						authMethod: "key",
					},
				],
				deps: providerDeps(async () => {
					throw new Error("must not be called");
				}),
				credentialDeps: credentialDeps(),
				nativeCredential: {
					resolve: async () => {
						throw new Error(`host credential read failed: ${ACCESS_SENTINEL}`);
					},
				},
			});
			const hostErrorResult = await hostError.handlers.get(
				{ providerID: "ollama" },
				emptyContext() as never,
			);
			expect(hostErrorResult).toMatchObject({
				quota: { state: "unavailable", reason: "invalid_response" },
			});
			expectNoSentinels(
				"host credential error",
				hostErrorResult,
				captured.lines,
			);

			// File credential read error: the fallback path is sanitized and the
			// provider is reported as having no validated source.
			const fileError = buildStack({
				providers: [
					{
						providerID: "ollama",
						integrationID: "ollama-cloud",
						authMethod: "key",
					},
				],
				deps: providerDeps(async () => {
					throw new Error("must not be called");
				}),
				credentialDeps: credentialDeps(),
			});
			const fileErrorResult = await fileError.handlers.get(
				{ providerID: "ollama" },
				emptyContext() as never,
			);
			expect(fileErrorResult).toMatchObject({
				quota: {
					state: "unsupported",
					reason: "no_validated_quota_source",
				},
			});
			expectNoSentinels(
				"file credential error",
				fileErrorResult,
				captured.lines,
			);

			// Companion credentials flow to the allowlisted app route and are
			// never echoed; a non-matching app list is a sanitized mismatch.
			const companionRequests: {
				url: string;
				headers: Record<string, string>;
			}[] = [];
			const companion = buildStack({
				providers: [
					{
						providerID: "openai",
						integrationID: "openai",
						authMethod: "oauth",
					},
				],
				deps: providerDeps(async (url, headers) => {
					companionRequests.push({ url, headers });
					return { items: [{ id: `${CLIENT_SENTINEL}-different-app` }] };
				}),
				credentialDeps: credentialDeps(),
				nativeCredential: nativeOpenAICredential(),
				readCompanion: async () => COMPANION_AVAILABLE,
			});
			const companionResult = await companion.handlers.get(
				{ providerID: "openai" },
				emptyContext() as never,
			);
			expect(companionRequests).toHaveLength(1);
			expect(companionRequests[0]?.url).toBe(
				"https://chatgpt.com/backend-api/wham/usage/chatpass/apps",
			);
			expect(companionRequests[0]?.headers.Authorization).toBe(
				`Bearer ${COMPANION_SENTINEL}`,
			);
			expect(companionRequests[0]?.headers["ChatGPT-Account-Id"]).toBe(
				ACCOUNT_SENTINEL,
			);
			expect(companionResult).toMatchObject({
				quota: {
					state: "unavailable",
					reason: "app_registration_mismatch",
				},
			});
			expectNoSentinels("companion", companionResult, captured.lines);

			// RPC error output never echoes attacker-supplied sentinel fields.
			const errorResult = await success.handlers.get(
				{
					providerID: "ollama",
					credentialPath: `/home/${FILE_SENTINEL}/auth.json`,
					accessToken: ACCESS_SENTINEL,
				} as never,
				emptyContext() as never,
			);
			expect(errorResult).toMatchObject({ type: "invalid_input" });
			expectNoSentinels("rpc error", errorResult, captured.lines);
		} finally {
			captured.restore();
		}
	});

	test("late_and_cancelled_requests_never_disclose_credential_sentinels", async () => {
		const captured = captureLogs();
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			markFetchStarted?.();
			await wait(25);
			return new Response(
				JSON.stringify({
					included: {
						balance_usd: 40,
						allowance_usd: 60,
						period: { until: "2030-01-01T00:00:00Z" },
					},
					accessToken: ACCESS_SENTINEL,
					accountID: ACCOUNT_SENTINEL,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const stack = buildStack({
				providers: [
					{
						providerID: "ollama",
						integrationID: "ollama-cloud",
						authMethod: "key",
					},
				],
				deps: providerDeps(getQuotaJson),
				credentialDeps: credentialDeps(),
				nativeCredential: nativeKeyCredential(ACCESS_SENTINEL),
			});
			const controller = new AbortController();
			const pending = stack.handlers.get(
				{ providerID: "ollama" },
				emptyContext(controller.signal) as never,
			);
			await fetchStarted;
			controller.abort();
			const late = await pending;
			expect(fetchCalls).toBe(1);
			expect(late).toMatchObject({
				quota: { state: "unavailable", reason: "network_error" },
			});
			expectNoSentinels("late/cancelled", late, captured.lines);
		} finally {
			globalThis.fetch = originalFetch;
			captured.restore();
		}
	});

	test("rpc_cannot_select_credential_files", async () => {
		let reads = 0;
		let fileReads = 0;
		const registry = createAdapterRegistry([
			createOllamaAdapter(),
			createOpenAICompanionAdapter({
				readCompanion: async () => ({
					state: "unavailable",
					reason: "companion_disabled",
				}),
			}),
		]);
		const source: QuotaRpcSource = {
			registry,
			now: () => NOW,
			providers: async () => [
				{
					providerID: "ollama",
					integrationID: "ollama-cloud",
					authMethod: "key",
				},
			],
			read: async (input) => {
				reads += 1;
				const resolved = await registry.resolve({
					providerID: input.providerID,
					...(input.integrationID === undefined
						? {}
						: { integrationID: input.integrationID }),
					authMethod: input.authMethod,
					companion: { enabled: false },
					deps: providerDeps(async () => {
						throw new QuotaRequestError("network_error");
					}),
					credentialDeps: credentialDeps({
						readUtf8: async () => {
							fileReads += 1;
							throw new Error(`ENOENT ${FILE_SENTINEL}`);
						},
					}),
					signal: input.signal,
				});
				if (resolved === null) {
					return {
						state: "unsupported",
						reason: "no_validated_quota_source",
						attemptedAt: NOW,
					};
				}
				return resolved.read(input.signal);
			},
		};
		const handlers = createQuotaRpcHandlers({ source });
		const context = emptyContext();
		const rejected = [
			{
				providerID: "ollama",
				credentialPath: `/home/${FILE_SENTINEL}/.codex/auth.json`,
			},
			{ providerID: "ollama", path: `/home/${FILE_SENTINEL}/.codex` },
			{ providerID: "ollama", token: ACCESS_SENTINEL },
			{ providerID: "ollama", accessToken: ACCESS_SENTINEL },
			{ providerID: "ollama", home: `/home/${FILE_SENTINEL}` },
			{ providerID: "ollama", authFile: `/home/${FILE_SENTINEL}/auth.json` },
			{
				providerID: "ollama",
				credential: { path: `/home/${FILE_SENTINEL}/auth.json` },
			},
		];

		for (const input of rejected) {
			for (const method of ["get", "refresh", "list"] as const) {
				const got = await handlers[method](input as never, context as never);
				expect(got).toMatchObject({ type: "invalid_input" });
				expect(JSON.stringify(got)).not.toContain(FILE_SENTINEL);
				expect(JSON.stringify(got)).not.toContain(ACCESS_SENTINEL);
			}
		}
		expect(reads).toBe(0);
		expect(fileReads).toBe(0);

		// A path-like provider ID is not a selector either: it resolves no
		// adapter and causes zero credential-file reads.
		const pathLike = await handlers.get(
			{ providerID: `/home/${FILE_SENTINEL}/.codex/auth.json` },
			context as never,
		);
		expect(pathLike).toMatchObject({
			quota: { state: "unsupported", reason: "no_validated_quota_source" },
		});
		expect(fileReads).toBe(0);

		const getInput = QuotaRpc.methods.get.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(getInput.additionalProperties).toBe(false);
		expect(Object.keys(getInput.properties ?? {})).toEqual(["providerID"]);
		const refreshInput = QuotaRpc.methods.refresh.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(refreshInput.additionalProperties).toBe(false);
		expect(Object.keys(refreshInput.properties ?? {})).toEqual(["providerID"]);
		const listInput = QuotaRpc.methods.list.input as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(listInput.additionalProperties).toBe(false);
		expect(Object.keys(listInput.properties ?? {})).toEqual([]);
	});
});

type DocRow = Record<string, string>;

function cleanCell(value: string | undefined): string {
	const trimmed = (value ?? "").trim();
	const quoted = /^`([^`]*)`$/.exec(trimmed);
	return (quoted?.[1] ?? trimmed).trim();
}

function splitRow(line: string): string[] {
	const trimmed = line.trim();
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return inner.split("|").map((cell) => cleanCell(cell));
}

function parseDeclarationRows(markdown: string): DocRow[] {
	const lines = markdown.split(/\r?\n/);
	const headerIndex = lines.findIndex((line) =>
		line.trim().startsWith("| Adapter | Capability | Match |"),
	);
	if (headerIndex < 0) {
		throw new Error(
			"docs/support.md is missing the adapter declarations table",
		);
	}
	const header = splitRow(lines[headerIndex] ?? "");
	const rows: DocRow[] = [];
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim().startsWith("|")) {
			break;
		}
		const cells = splitRow(line);
		if (cells.length !== header.length) {
			throw new Error(
				`docs/support.md declarations row has ${cells.length} cells, expected ${header.length}`,
			);
		}
		const row: DocRow = {};
		for (const [index, column] of header.entries()) {
			row[column] = cells[index] ?? "";
		}
		rows.push(row);
	}
	return rows;
}

function matchLabel(match: ProviderCapability["match"]): string {
	const parts: string[] = [];
	if (match.providerID !== undefined) {
		parts.push(`providerID:${match.providerID}`);
	}
	if (match.integrationID !== undefined) {
		parts.push(`integrationID:${match.integrationID}`);
	}
	return parts.join("+");
}

function capabilityKey(
	adapterID: string,
	capability: ProviderCapability,
): string {
	return `${adapterID}\u0000${capability.name}`;
}

async function observedUnavailableReason(
	registry: ReturnType<typeof createAdapterRegistry>,
	capability: ProviderCapability,
): Promise<string> {
	const source = await registry.resolve({
		providerID:
			capability.match.providerID ??
			capability.match.integrationID ??
			"unmatched-provider",
		...(capability.match.integrationID === undefined
			? {}
			: { integrationID: capability.match.integrationID }),
		authMethod: capability.match.authMethod,
		companion: { enabled: false },
		deps: providerDeps(async () => {
			throw new QuotaRequestError("invalid_response");
		}),
		credentialDeps: credentialDeps(),
		signal: new AbortController().signal,
	});
	if (source === null) {
		return "no_validated_quota_source";
	}
	const read = await source.read(new AbortController().signal);
	return "reason" in read ? read.reason : "available";
}

describe("support matrix contract", () => {
	test("support_matrix_covers_every_registered_capability", async () => {
		const support = readFileSync(
			new URL("../../docs/support.md", import.meta.url),
			"utf8",
		);

		const adapters = [
			createOllamaAdapter(),
			createOpenAICompanionAdapter({
				readCompanion: async () => ({
					state: "unavailable",
					reason: "companion_disabled",
				}),
			}),
		];
		const registry = createAdapterRegistry(adapters);
		const rows = parseDeclarationRows(support);
		expect(rows.length).toBeGreaterThan(0);

		// The test builds the registry directly (never importing src/index.ts),
		// but it still reads the single registration point so a newly registered
		// adapter cannot silently escape the matrix check.
		const indexSource = readFileSync(
			new URL("../../src/index.ts", import.meta.url),
			"utf8",
		);
		const registrations = [
			...indexSource.matchAll(/^\s*(create\w*Adapter)\(/gm),
		].map((match) => match[1]);
		expect(registrations).toEqual([
			"createOllamaAdapter",
			"createOpenAICompanionAdapter",
		]);

		const rowsByKey = new Map<string, DocRow[]>();
		for (const row of rows) {
			const key = `${row.Adapter ?? ""}\u0000${row.Capability ?? ""}`;
			rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
		}

		const declared = new Set<string>();
		for (const adapter of adapters) {
			for (const capability of adapter.capabilities) {
				const key = capabilityKey(adapter.id, capability);
				declared.add(key);
				const matching = rowsByKey.get(key) ?? [];
				expect({ key, rows: matching.length }).toEqual({ key, rows: 1 });
				const row = matching[0];
				if (row === undefined) {
					continue;
				}

				expect(row.Match).toBe(matchLabel(capability.match));
				expect(row["Auth method"]).toBe(capability.match.authMethod);
				expect(row.Support).toBe(capability.support);
				expect(row.Evidence).toBe(capability.evidence);

				const reasons = (row["Reason codes"] ?? "")
					.split(",")
					.map((code) => cleanCell(code))
					.filter((code) => code.length > 0);
				expect({ key, reasons: reasons.length > 0 }).toEqual({
					key,
					reasons: true,
				});
				for (const reason of reasons) {
					expect(QUOTA_REASON_CODES as readonly string[]).toContain(reason);
				}

				const observed = await observedUnavailableReason(registry, capability);
				expect({ key, observed, reasons }).toEqual({
					key,
					observed,
					reasons: expect.arrayContaining([observed]),
				});
			}
		}

		// Bidirectional: a documentation row without a matching registered
		// capability is stale and must fail too.
		for (const row of rows) {
			const key = `${row.Adapter ?? ""}\u0000${row.Capability ?? ""}`;
			expect({ key, declared: declared.has(key) }).toEqual({
				key,
				declared: true,
			});
		}

		// Every frozen reason code is documented exactly, so the copy contract
		// in src/ui/format.ts has a complete public explanation set.
		for (const reason of QUOTA_REASON_CODES) {
			expect(support).toContain(`\`${reason}\``);
		}

		// The full specification matrix remains present (row labels verbatim).
		const matrixRows = [
			"Ollama Cloud saved API key",
			"Ollama Cloud legacy session/weekly plan with API key",
			"Signed-in local Ollama cloud proxy",
			"Purely local Ollama inference",
			"OpenAI current ChatGPT token-sharing OAuth, companion explicitly opted out",
			"Current token-sharing OAuth plus valid, file-backed, matching Codex companion login",
			"Same combination, but missing/expired/mismatched companion login",
			"Keychain/encrypted Codex cache",
			"OpenAI inference API key",
			"Legacy Codex OAuth saved directly in OpenCode",
			"OpenCode Console device OAuth",
			"Zen/Go inference API keys",
			"Other providers / custom compatible endpoints",
		];
		for (const label of matrixRows) {
			expect(support).toContain(label);
		}

		// Ledger rulings that must stay visible in the compatibility contract.
		const rulings = [
			"Legacy windows render ONLY when the provider reports a duration",
			"valid legacy response shows `partial` plus an unavailable section",
			"`no_validated_quota_source` has two meanings",
			"on by default",
			"`auth-required` with reason `unsupported_auth_method`",
			"On OpenCode 2.1.4 the active OpenAI OAuth credential is stored in\n  `opencode.db`",
			"integration.connection.active",
			"connection.resolve",
			"Cross-process deduplication",
			"Not promised",
			"remains active until the plugin unloads",
			"Keychain, encrypted, ephemeral, and other non-file Codex stores are explicitly\nunsupported",
		];
		for (const ruling of rulings) {
			expect(support).toContain(ruling);
		}
	});
});

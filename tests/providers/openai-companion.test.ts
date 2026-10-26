import { describe, expect, test } from "bun:test";
import {
	type AdapterResolveInput,
	type CodexCompanion,
	type CompanionOptions,
	type CompanionRead,
	type CredentialReadDeps,
	isQuotaRead,
	type ProviderDeps,
	type QuotaMetric,
	type QuotaRead,
	QuotaRequestError,
	type QuotaScope,
	type ResolvedQuotaSource,
	type SectionResult,
} from "../../src/core/contracts";
import { createQuotaCoordinator } from "../../src/core/refresh";
import {
	createOpenAICompanionAdapter,
	fetchOpenAICompanionQuota,
	readNativeRegistration,
} from "../../src/providers/openai-companion";

const NOW = 1_790_000_000_000;
const NOW_SECONDS = NOW / 1000;
const APPS_URL = "https://chatgpt.com/backend-api/wham/usage/chatpass/apps";
const PLAN_URL = "https://chatgpt.com/backend-api/wham/usage";
const DATA_HOME = "/synthetic/data";
const AUTH_PATH = `${DATA_HOME}/opencode/auth.json`;

const CLIENT_ID = "synthetic-openai-client-id";
const OTHER_CLIENT_ID = "synthetic-other-openai-client-id";
const ACCOUNT_ID = "synthetic-companion-account-id";
const COMPANION_TOKEN = "companion-bearer-sentinel-do-not-leak";
const NATIVE_SIGNATURE = "native-token-sharing-bearer-sentinel";
const NATIVE_REFRESH = "native-refresh-sentinel-do-not-leak";
const EXPIRED_COMPANION_TOKEN = "expired-companion-bearer-sentinel";

const RESET_A = 1_790_500_000;
const RESET_B = 1_791_000_000;

type RequestCall = {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal;
};

type Payload = unknown | (() => unknown);

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function nativeJwt(overrides: Record<string, unknown> = {}): string {
	const claims = {
		iss: "https://auth.openai.com",
		aud: "https://api.openai.com/v1",
		client_id: CLIENT_ID,
		scope:
			"openid profile email offline_access chatgpt.tokens.use.direct resource.invoke",
		exp: NOW_SECONDS + 3600,
		sub: "synthetic-native-subject",
		...overrides,
	};
	return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.${NATIVE_SIGNATURE}`;
}

function nativeEntry(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "oauth",
		methodID: "chatgpt-token-sharing",
		access: nativeJwt(),
		refresh: NATIVE_REFRESH,
		expires: NOW + 3_600_000,
		metadata: {
			clientID: CLIENT_ID,
			scopes: ["openid", "chatgpt.tokens.use.direct"],
		},
		...overrides,
	};
}

function authStore(entry: Record<string, unknown> = nativeEntry()): unknown {
	return { openai: entry };
}

function companionCredential(
	overrides: Partial<CodexCompanion> = {},
): CodexCompanion {
	return {
		accessToken: COMPANION_TOKEN,
		accountID: ACCOUNT_ID,
		expiresAt: NOW + 3_600_000,
		identityKey: "synthetic-companion-identity-a",
		...overrides,
	};
}

function companionRead(
	credential: CodexCompanion = companionCredential(),
): CompanionRead {
	return { state: "available", credential };
}

function appWindow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		used_percent: 10,
		remaining_percent: 90,
		limit_window_seconds: 604_800,
		reset_at: RESET_A,
		...overrides,
	};
}

function appItem(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: CLIENT_ID,
		allowed_usage_percent: 100,
		windows: [appWindow()],
		...overrides,
	};
}

function appsPayload(
	items: unknown[] = [appItem()],
	overrides: Record<string, unknown> = {},
): unknown {
	return { items, ...overrides };
}

function planWindow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		used_percent: 20,
		remaining_percent: 80,
		limit_window_seconds: 604_800,
		reset_at: RESET_B,
		...overrides,
	};
}

function planPayload(
	rateLimit: unknown = { primary_window: planWindow(), secondary_window: null },
): unknown {
	return { rate_limit: rateLimit };
}

function resolvePayload(value: Payload): unknown {
	return typeof value === "function" ? (value as () => unknown)() : value;
}

type HarnessOptions = {
	apps?: Payload;
	plan?: Payload;
	companion?: CompanionRead;
	store?: unknown;
	/** Synthetic host credential value; a function is reread on every resolve. */
	native?: Payload;
	providerID?: string;
	integrationID?: string;
	authMethod?: string;
	env?: Record<string, string | undefined>;
};

function harness(options: HarnessOptions = {}) {
	const requests: RequestCall[] = [];
	const companionReads: {
		options: CompanionOptions;
		deps: CredentialReadDeps;
	}[] = [];
	const credentialReads: { path: string; maxBytes: number }[] = [];
	const nativeReads: string[] = [];
	let storedEntry = options.store ?? authStore();
	let nativeValue: Payload = options.native;
	let readResult: CompanionRead = options.companion ?? companionRead();

	const deps: ProviderDeps = {
		now: () => NOW,
		async getJson(url, headers, signal) {
			requests.push({ url, headers, signal });
			if (url === APPS_URL) {
				return resolvePayload(options.apps ?? appsPayload());
			}
			if (url === PLAN_URL) {
				return resolvePayload(options.plan ?? planPayload());
			}
			throw new Error(`unexpected quota URL: ${url}`);
		},
	};

	const credentialDeps: CredentialReadDeps = {
		now: () => NOW,
		env: options.env ?? { XDG_DATA_HOME: DATA_HOME },
		homeDirectory: "/synthetic/home",
		async readUtf8(path, maxBytes) {
			credentialReads.push({ path, maxBytes });
			return typeof storedEntry === "string"
				? storedEntry
				: JSON.stringify(storedEntry);
		},
	};

	const input: AdapterResolveInput = {
		providerID: options.providerID ?? "openai",
		integrationID: options.integrationID ?? "openai",
		authMethod: options.authMethod ?? "oauth",
		companion: { enabled: true },
		deps,
		credentialDeps,
		signal: new AbortController().signal,
		...(options.native === undefined
			? {}
			: {
					nativeCredential: {
						async resolve(integrationID: string) {
							nativeReads.push(integrationID);
							return resolvePayload(nativeValue);
						},
					},
				}),
	};

	const adapter = createOpenAICompanionAdapter({
		async readCompanion(readOptions, readDeps) {
			companionReads.push({ options: readOptions, deps: readDeps });
			return readResult;
		},
	});

	return {
		adapter,
		input,
		requests,
		companionReads,
		credentialReads,
		nativeReads,
		setCompanion(next: CompanionRead) {
			readResult = next;
		},
		setStore(next: unknown) {
			storedEntry = next;
		},
		setNative(next: Payload) {
			nativeValue = next;
		},
		async source(): Promise<ResolvedQuotaSource> {
			const source = await adapter.resolve(input);
			if (source === null) {
				throw new Error("adapter declined the provider");
			}
			return source;
		},
		async read(): Promise<QuotaRead> {
			const source = await adapter.resolve(input);
			if (source === null) {
				throw new Error("adapter declined the provider");
			}
			return source.read(input.signal);
		},
	};
}

function planRequests(requests: RequestCall[]): number {
	return requests.filter((call) => call.url === PLAN_URL).length;
}

function sections(
	read: QuotaRead,
): { scope: QuotaScope; result: SectionResult }[] {
	if (read.state !== "available" && read.state !== "partial") {
		throw new Error(`expected a sectioned read, got ${read.state}`);
	}
	return read.sections;
}

function section(read: QuotaRead, scope: QuotaScope, index = 0): SectionResult {
	const found = sections(read).filter((entry) => entry.scope === scope)[index];
	if (found === undefined) {
		throw new Error(`missing ${scope} section at index ${index}`);
	}
	return found.result;
}

function windows(
	result: SectionResult,
): Extract<QuotaMetric, { kind: "window" }>[] {
	if (result.state !== "available") {
		throw new Error(`expected an available section, got ${result.state}`);
	}
	return result.metrics.filter(
		(metric): metric is Extract<QuotaMetric, { kind: "window" }> =>
			metric.kind === "window",
	);
}

function expectUnavailable(read: QuotaRead, reason: string): void {
	expect(isQuotaRead(read)).toBe(true);
	expect(read).toMatchObject({ state: "unavailable", reason });
}

function expectReason(read: QuotaRead, reason: string): void {
	expect(isQuotaRead(read)).toBe(true);
	expect(read).toMatchObject({ reason });
}

describe("app registration matching", () => {
	test("matches_current_app_before_fetching_plan", async () => {
		const h = harness();
		const read = await h.read();

		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		expect(h.requests.map((call) => call.url)).toEqual([APPS_URL, PLAN_URL]);
		expect(section(read, "app").state).toBe("available");
		expect(section(read, "shared-plan").state).toBe("available");

		// Companion options and credential deps are passed through unchanged.
		expect(h.companionReads.length).toBe(2);
		expect(h.companionReads[0]?.options).toEqual({ enabled: true });
		expect(h.companionReads[0]?.deps).toBe(h.input.credentialDeps);
		expect(h.credentialReads.map((call) => call.path)).toEqual([
			AUTH_PATH,
			AUTH_PATH,
		]);
	});

	test("zero_or_duplicate_registration_matches_never_fetch_plan", async () => {
		const zero = harness({
			apps: appsPayload([appItem({ id: OTHER_CLIENT_ID })]),
		});
		const zeroRead = await zero.read();
		expectUnavailable(zeroRead, "app_registration_mismatch");
		expect(zero.requests).toHaveLength(1);
		expect(planRequests(zero.requests)).toBe(0);

		const duplicate = harness({ apps: appsPayload([appItem(), appItem()]) });
		const duplicateRead = await duplicate.read();
		expectUnavailable(duplicateRead, "app_registration_mismatch");
		expect(duplicate.requests).toHaveLength(1);
		expect(planRequests(duplicate.requests)).toBe(0);
	});

	test("matches_by_id_only_never_by_name_or_first_entry", async () => {
		const decoy = appItem({
			id: OTHER_CLIENT_ID,
			name: CLIENT_ID,
			windows: [appWindow({ used_percent: 99, remaining_percent: 1 })],
		});
		const h = harness({ apps: appsPayload([decoy, appItem()]) });
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		const appWindows = windows(section(read, "app"));
		expect(appWindows[0]?.remainingPercent).toBe(90);

		const nameOnly = harness({
			apps: appsPayload([appItem({ id: OTHER_CLIENT_ID, name: CLIENT_ID })]),
		});
		expectUnavailable(await nameOnly.read(), "app_registration_mismatch");
		expect(planRequests(nameOnly.requests)).toBe(0);
	});
});

describe("distinct app and shared-plan scopes", () => {
	test("retains_different_app_and_plan_weeks", async () => {
		const h = harness();
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);

		const appResult = section(read, "app");
		const planResult = section(read, "shared-plan");
		expect(windows(appResult)).toHaveLength(1);
		expect(windows(planResult)).toHaveLength(1);

		const appWindowMetric = windows(appResult)[0];
		const planWindowMetric = windows(planResult)[0];
		expect(appWindowMetric).toMatchObject({
			kind: "window",
			scope: "app",
			windowSeconds: 604_800,
			remainingPercent: 90,
			usedPercent: 10,
			resetsAt: RESET_A * 1000,
		});
		expect(planWindowMetric).toMatchObject({
			kind: "window",
			scope: "shared-plan",
			windowSeconds: 604_800,
			remainingPercent: 80,
			usedPercent: 20,
			resetsAt: RESET_B * 1000,
		});
		expect(appWindowMetric?.id).not.toBe(planWindowMetric?.id);
		expect(sections(read)).toHaveLength(2);
		expect(
			appResult.state === "available" && appResult.configuredAppCapPercent,
		).toBe(100);

		// The configured cap is a separate declaration, never a remaining value.
		for (const metric of windows(appResult)) {
			expect(metric.remainingPercent).not.toBe(100);
		}
		for (const metric of windows(planResult)) {
			expect(metric.remainingPercent).not.toBe(100);
		}
	});

	test("never_merges_identical_app_and_plan_windows", async () => {
		const shared = {
			used_percent: 10,
			remaining_percent: 90,
			limit_window_seconds: 604_800,
			reset_at: RESET_A,
		};
		const h = harness({
			apps: appsPayload([appItem({ windows: [shared] })]),
			plan: planPayload({ primary_window: shared, secondary_window: null }),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		const scopes = sections(read).map((entry) => entry.scope);
		expect(scopes).toEqual(["app", "shared-plan"]);
		expect(windows(section(read, "app"))[0]).toMatchObject({
			scope: "app",
			resetsAt: RESET_A * 1000,
		});
		expect(windows(section(read, "shared-plan"))[0]).toMatchObject({
			scope: "shared-plan",
			resetsAt: RESET_A * 1000,
		});
	});
});

describe("native registration", () => {
	test("accepts_only_token_sharing_selectors", () => {
		const registration = readNativeRegistration(nativeEntry());
		expect("clientID" in registration).toBe(true);
		expect(registration).toMatchObject({ clientID: CLIENT_ID });
		expect(JSON.stringify(registration)).not.toContain(NATIVE_SIGNATURE);
		expect(JSON.stringify(registration)).not.toContain(NATIVE_REFRESH);
	});

	test("rejects_method_and_client_mismatches", () => {
		const failures: unknown[] = [
			nativeEntry({ type: "api", key: "synthetic-key" }),
			nativeEntry({ methodID: "chatgpt-browser" }),
			nativeEntry({ method: "chatgpt-headless" }),
			nativeEntry({
				methodID: "chatgpt-token-sharing",
				method: "chatgpt-browser",
			}),
			nativeEntry({ metadata: { clientID: OTHER_CLIENT_ID } }),
			nativeEntry({ metadata: {} }),
			nativeEntry({ metadata: { clientID: CLIENT_ID, scopes: ["openid"] } }),
			nativeEntry({ access: "not-a-jwt" }),
			nativeEntry({ access: 42 }),
			nativeEntry({ metadata: undefined }),
		];
		for (const value of failures) {
			expect(readNativeRegistration(value)).toMatchObject({
				state: "unavailable",
				reason: "invalid_native_registration",
			});
		}
	});

	test("rejects_unexpected_issuer_audience_and_scope", () => {
		const failures = [
			nativeEntry({ access: nativeJwt({ iss: "https://evil.example" }) }),
			nativeEntry({ access: nativeJwt({ aud: "https://api.openai.com/v2" }) }),
			nativeEntry({
				access: nativeJwt({ aud: ["https://api.openai.com/v2"] }),
			}),
			nativeEntry({
				access: nativeJwt({ scope: "openid profile email offline_access" }),
			}),
			nativeEntry({ access: nativeJwt({ scope: "" }) }),
		];
		for (const value of failures) {
			expect(readNativeRegistration(value)).toMatchObject({
				state: "unavailable",
				reason: "invalid_native_registration",
			});
		}

		expect(
			readNativeRegistration(
				nativeEntry({
					access: nativeJwt({ aud: ["https://api.openai.com/v1"] }),
				}),
			),
		).toMatchObject({ clientID: CLIENT_ID });
	});

	test("adapter_reports_invalid_native_registration_without_requests", async () => {
		const h = harness({
			store: authStore(nativeEntry({ methodID: "chatgpt-browser" })),
		});
		expectUnavailable(await h.read(), "invalid_native_registration");
		expect(h.requests).toHaveLength(0);
	});

	test("missing_auth_store_or_openai_entry_is_invalid_registration", async () => {
		const missing = harness({
			store: "{}",
		});
		expectUnavailable(await missing.read(), "invalid_native_registration");
		expect(missing.requests).toHaveLength(0);

		const malformed = harness({ store: "not-json" });
		expectUnavailable(await malformed.read(), "invalid_native_registration");
		expect(malformed.requests).toHaveLength(0);
	});
});

describe("app envelope validation", () => {
	const invalidEnvelopes: {
		name: string;
		payload: unknown;
		reason: string;
	}[] = [
		{ name: "non-object", payload: [], reason: "invalid_response" },
		{
			name: "missing items",
			payload: { data: [appItem()] },
			reason: "invalid_response",
		},
		{
			name: "items not a list",
			payload: { items: appItem() },
			reason: "invalid_response",
		},
		{
			name: "has_more true",
			payload: appsPayload([appItem()], { has_more: true }),
			reason: "invalid_response",
		},
		{
			name: "has_more string",
			payload: appsPayload([appItem()], { has_more: "false" }),
			reason: "invalid_response",
		},
		{
			name: "nonempty cursor",
			payload: appsPayload([appItem()], { next_cursor: "cursor-2" }),
			reason: "invalid_response",
		},
		{
			name: "changed envelope key",
			payload: appsPayload([appItem()], { total: 1 }),
			reason: "invalid_response",
		},
		{
			name: "unreadable item identity",
			payload: appsPayload([{ windows: [] }]),
			reason: "invalid_response",
		},
		{
			name: "empty registration list",
			payload: appsPayload([]),
			reason: "app_registration_mismatch",
		},
	];

	for (const entry of invalidEnvelopes) {
		test(`rejects_${entry.name.replaceAll(" ", "_")}`, async () => {
			const h = harness({ apps: entry.payload });
			const read = await h.read();
			expectUnavailable(read, entry.reason);
			expect(planRequests(h.requests)).toBe(0);
		});
	}

	test("accepts_explicitly_complete_pagination", async () => {
		const h = harness({
			apps: appsPayload([appItem()], { has_more: false, next_cursor: null }),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		expect(h.requests.map((call) => call.url)).toEqual([APPS_URL, PLAN_URL]);
	});
});

describe("window validation", () => {
	const invalidApps: { name: string; apps: unknown; reason: string }[] = [
		{
			name: "empty windows",
			apps: appsPayload([appItem({ windows: [] })]),
			reason: "invalid_response",
		},
		{
			name: "missing windows",
			apps: appsPayload([appItem({ windows: undefined })]),
			reason: "invalid_response",
		},
		{
			name: "missing duration",
			apps: appsPayload([
				appItem({ windows: [appWindow({ limit_window_seconds: undefined })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "zero duration",
			apps: appsPayload([
				appItem({ windows: [appWindow({ limit_window_seconds: 0 })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "fractional duration",
			apps: appsPayload([
				appItem({ windows: [appWindow({ limit_window_seconds: 1.5 })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "zero reset",
			apps: appsPayload([appItem({ windows: [appWindow({ reset_at: 0 })] })]),
			reason: "invalid_response",
		},
		{
			name: "millisecond reset",
			apps: appsPayload([
				appItem({ windows: [appWindow({ reset_at: RESET_A * 1000 })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "string reset",
			apps: appsPayload([
				appItem({ windows: [appWindow({ reset_at: `${RESET_A}` })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "out of range used",
			apps: appsPayload([
				appItem({ windows: [appWindow({ used_percent: 101 })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "negative remaining",
			apps: appsPayload([
				appItem({ windows: [appWindow({ remaining_percent: -1 })] }),
			]),
			reason: "invalid_response",
		},
		{
			name: "non-finite used",
			apps: appsPayload([
				appItem({
					windows: [appWindow({ used_percent: Number.POSITIVE_INFINITY })],
				}),
			]),
			reason: "invalid_response",
		},
		{
			name: "missing both percentages",
			apps: appsPayload([
				appItem({
					windows: [
						appWindow({
							used_percent: undefined,
							remaining_percent: undefined,
						}),
					],
				}),
			]),
			reason: "invalid_response",
		},
		{
			name: "inconsistent complement",
			apps: appsPayload([
				appItem({
					windows: [appWindow({ used_percent: 10, remaining_percent: 80 })],
				}),
			]),
			reason: "invalid_response",
		},
		{
			name: "invalid configured cap",
			apps: appsPayload([appItem({ allowed_usage_percent: 150 })]),
			reason: "invalid_response",
		},
	];

	for (const entry of invalidApps) {
		test(`rejects_${entry.name.replaceAll(" ", "_")}`, async () => {
			const h = harness({ apps: entry.apps });
			const read = await h.read();
			expectUnavailable(read, entry.reason);
			expect(planRequests(h.requests)).toBe(0);
		});
	}

	test("accepts_complement_within_one_point_without_clamping", async () => {
		const h = harness({
			apps: appsPayload([
				appItem({
					windows: [appWindow({ used_percent: 10.5, remaining_percent: 89 })],
				}),
			]),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(windows(section(read, "app"))[0]).toMatchObject({
			usedPercent: 10.5,
			remainingPercent: 89,
		});
	});

	test("keeps_a_missing_percentage_unknown", async () => {
		const remainingOnly = harness({
			apps: appsPayload([
				appItem({ windows: [appWindow({ used_percent: undefined })] }),
			]),
		});
		const remainingMetric = windows(
			section(await remainingOnly.read(), "app"),
		)[0];
		expect(remainingMetric?.remainingPercent).toBe(90);
		expect(remainingMetric?.usedPercent).toBeUndefined();

		const usedOnly = harness({
			apps: appsPayload([
				appItem({ windows: [appWindow({ remaining_percent: undefined })] }),
			]),
		});
		const usedMetric = windows(section(await usedOnly.read(), "app"))[0];
		expect(usedMetric?.usedPercent).toBe(10);
		expect(usedMetric?.remainingPercent).toBeUndefined();
	});

	test("missing_optional_reset_is_unknown_not_predicted", async () => {
		const h = harness({
			apps: appsPayload([
				appItem({ windows: [appWindow({ reset_at: undefined })] }),
			]),
			plan: planPayload({
				primary_window: planWindow({ reset_at: undefined }),
				secondary_window: null,
			}),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		const [appWindowMetric] = windows(section(read, "app"));
		const [planWindowMetric] = windows(section(read, "shared-plan"));
		expect(
			appWindowMetric === undefined ? true : "resetsAt" in appWindowMetric,
		).toBe(false);
		expect(
			planWindowMetric === undefined ? true : "resetsAt" in planWindowMetric,
		).toBe(false);
	});

	test("uses_reported_durations_and_converts_reset_seconds_once", async () => {
		const h = harness({
			apps: appsPayload([
				appItem({
					windows: [
						appWindow({
							limit_window_seconds: 3600,
							reset_at: NOW_SECONDS + 123,
						}),
					],
				}),
			]),
			plan: planPayload({
				primary_window: planWindow({
					limit_window_seconds: 18_000,
					reset_at: NOW_SECONDS + 456,
				}),
				secondary_window: null,
			}),
		});
		const read = await h.read();
		const appMetric = windows(section(read, "app"))[0];
		const planMetric = windows(section(read, "shared-plan"))[0];
		expect(appMetric).toMatchObject({
			windowSeconds: 3600,
			resetsAt: (NOW_SECONDS + 123) * 1000,
		});
		expect(planMetric).toMatchObject({
			windowSeconds: 18_000,
			resetsAt: (NOW_SECONDS + 456) * 1000,
		});
		// Independent freshness: each section expires at its own boundary/poll.
		const appResult = section(read, "app");
		const planResult = section(read, "shared-plan");
		if (appResult.state === "available" && planResult.state === "available") {
			expect(appResult.fetchedAt).toBe(NOW);
			expect(planResult.fetchedAt).toBe(NOW);
			expect(appResult.expiresAt).toBeLessThanOrEqual(
				Math.min(NOW + 60_000, (NOW_SECONDS + 123) * 1000),
			);
			expect(planResult.expiresAt).toBeLessThanOrEqual(
				Math.min(NOW + 60_000, (NOW_SECONDS + 456) * 1000),
			);
		}
	});
});

describe("shared-plan windows", () => {
	test("parses_primary_and_secondary_with_reported_durations", async () => {
		const h = harness({
			plan: planPayload({
				primary_window: planWindow({
					limit_window_seconds: 18_000,
					used_percent: 5,
					remaining_percent: 95,
				}),
				secondary_window: planWindow({
					limit_window_seconds: 2_592_000,
					reset_at: RESET_B,
				}),
			}),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		const planMetrics = windows(section(read, "shared-plan"));
		expect(planMetrics).toHaveLength(2);
		expect(planMetrics.map((metric) => metric.windowSeconds)).toEqual([
			18_000, 2_592_000,
		]);
		expect(planMetrics[0]?.remainingPercent).toBe(95);
	});

	test("skips_a_single_null_plan_window", async () => {
		const h = harness({
			plan: planPayload({
				primary_window: null,
				secondary_window: planWindow(),
			}),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(windows(section(read, "shared-plan"))).toHaveLength(1);
		expect(windows(section(read, "shared-plan"))[0]?.remainingPercent).toBe(80);
	});

	test("null_plan_windows_are_unavailable_not_substituted", async () => {
		const h = harness({
			plan: planPayload({ primary_window: null, secondary_window: null }),
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("partial");
		expect(section(read, "app").state).toBe("available");
		expect(section(read, "shared-plan")).toMatchObject({
			state: "unavailable",
			reason: "invalid_response",
		});
	});

	test("never_reinterprets_model_specific_additional_limits", async () => {
		const h = harness({
			plan: {
				rate_limit: null,
				additional_rate_limits: {
					gpt: { primary_window: planWindow(), secondary_window: null },
				},
			},
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("partial");
		expect(section(read, "shared-plan")).toMatchObject({
			state: "unavailable",
			reason: "invalid_response",
		});
	});
});

describe("partial and transport failures", () => {
	test("app success followed by shared-plan 401 clears previously successful history", async () => {
		let rejectPlan = false;
		let now = NOW;
		const fake = harness({
			plan: () => {
				if (rejectPlan)
					throw new QuotaRequestError("invalid_response", { status: 401 });
				return planPayload();
			},
		});
		const coordinator = createQuotaCoordinator({
			now: () => now,
			resolve: async () => {
				const resolved = await fake.adapter.resolve(fake.input);
				if (resolved === null) throw new Error("expected claimed adapter");
				return resolved;
			},
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
		try {
			await coordinator.refresh("openai");
			expect(coordinator.presentation("openai").lastKnown).toBeDefined();
			now += 15_000;
			rejectPlan = true;
			const current = await coordinator.refresh("openai");
			expect(current.state).toBe("partial");
			if (!("sections" in current)) throw new Error("expected partial scopes");
			expect(
				current.sections.find((section) => section.scope === "app")?.result
					.state,
			).toBe("available");
			expect(
				current.sections.find((section) => section.scope === "shared-plan")
					?.result.state,
			).toBe("auth-required");
			expect(coordinator.presentation("openai").lastKnown).toBeUndefined();
			expect(coordinator.isRecovering("openai")).toBe(false);
		} finally {
			coordinator.dispose();
		}
	});
	test("keeps_verified_app_section_when_plan_fails", async () => {
		const h = harness({
			plan: () => {
				throw new QuotaRequestError("rate_limited", {
					status: 429,
					retryAfterMs: 30_000,
				});
			},
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("partial");
		expect(section(read, "app").state).toBe("available");
		expect(windows(section(read, "app"))[0]?.remainingPercent).toBe(90);
		expect(section(read, "shared-plan")).toMatchObject({
			state: "unavailable",
			reason: "rate_limited",
			attemptedAt: NOW,
			retryAfterMs: 30_000,
		});
	});

	test("maps_app_401_without_refresh_attempts", async () => {
		const h = harness({
			apps: () => {
				throw new QuotaRequestError("invalid_response", { status: 401 });
			},
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read).toMatchObject({
			state: "auth-required",
			reason: "invalid_response",
		});
		// One companion read for resolve, one for the fetch: no retry, no refresh.
		expect(h.companionReads).toHaveLength(2);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.url).toBe(APPS_URL);
		expect(planRequests(h.requests)).toBe(0);
	});

	test("maps_401_to_companion_expired_only_when_near_expiry", async () => {
		const nearExpiry = harness({
			companion: companionRead(
				companionCredential({ expiresAt: NOW + 30_000 }),
			),
			apps: () => {
				throw new QuotaRequestError("invalid_response", { status: 401 });
			},
		});
		expectReason(await nearExpiry.read(), "companion_expired");
		expect(nearExpiry.requests).toHaveLength(1);
		expect(planRequests(nearExpiry.requests)).toBe(0);

		const forbidden = harness({
			apps: () => {
				throw new QuotaRequestError("invalid_response", { status: 403 });
			},
		});
		const forbiddenRead = await forbidden.read();
		expect(forbiddenRead).toMatchObject({
			state: "auth-required",
			reason: "invalid_response",
		});
	});

	test("plan_401_labels_the_shared_section_auth_required", async () => {
		const h = harness({
			plan: () => {
				throw new QuotaRequestError("invalid_response", { status: 401 });
			},
		});
		const read = await h.read();
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("partial");
		expect(section(read, "shared-plan")).toMatchObject({
			state: "auth-required",
			reason: "invalid_response",
		});
		expect(section(read, "app").state).toBe("available");
	});

	test("expired_companion_credential_makes_zero_requests", async () => {
		const h = harness({
			companion: companionRead(
				companionCredential({
					accessToken: EXPIRED_COMPANION_TOKEN,
					expiresAt: NOW - 1000,
				}),
			),
		});
		const read = await h.read();
		expectReason(read, "companion_expired");
		expect(read.state).toBe("auth-required");
		expect(h.requests).toHaveLength(0);
		expect(h.credentialReads).toHaveLength(0);
		expect(JSON.stringify(read)).not.toContain(EXPIRED_COMPANION_TOKEN);
	});

	test("companion_reader_failures_are_reported_without_requests", async () => {
		for (const reason of [
			"companion_missing",
			"unsupported_companion_storage",
			"invalid_companion",
		]) {
			const h = harness({ companion: { state: "unavailable", reason } });
			expectUnavailable(await h.read(), reason);
			expect(h.requests).toHaveLength(0);
			expect(h.credentialReads).toHaveLength(0);
		}
	});

	test("disabled_companion_makes_zero_requests", async () => {
		const h = harness({
			companion: { state: "unavailable", reason: "companion_disabled" },
		});
		const read = await h.read();
		expectUnavailable(read, "companion_disabled");
		expect(h.requests).toHaveLength(0);
		expect(h.credentialReads).toHaveLength(0);
	});

	test("fetch_openai_companion_quota_exposes_both_scopes", async () => {
		const h = harness();
		const read = await fetchOpenAICompanionQuota(
			{ clientID: CLIENT_ID, connectionKey: "synthetic-connection-key" },
			companionCredential(),
			h.input.signal,
			h.input.deps,
		);
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		expect(sections(read).map((entry) => entry.scope)).toEqual([
			"app",
			"shared-plan",
		]);
	});
});

describe("credential boundary", () => {
	test("only_the_companion_bearer_reaches_chatgpt", async () => {
		const h = harness();
		const read = await h.read();
		for (const call of h.requests) {
			expect(call.headers.Authorization).toBe(`Bearer ${COMPANION_TOKEN}`);
			expect(call.headers["ChatGPT-Account-Id"]).toBe(ACCOUNT_ID);
			expect(call.headers["User-Agent"]).toContain("opencode-providers-usage");
			const serialized = JSON.stringify(call.headers);
			expect(serialized).not.toContain(NATIVE_SIGNATURE);
			expect(serialized).not.toContain(NATIVE_REFRESH);
			expect(serialized).not.toContain(CLIENT_ID);
		}
		const output = JSON.stringify(read);
		for (const sentinel of [
			COMPANION_TOKEN,
			NATIVE_SIGNATURE,
			NATIVE_REFRESH,
			CLIENT_ID,
			ACCOUNT_ID,
			EXPIRED_COMPANION_TOKEN,
		]) {
			expect(output).not.toContain(sentinel);
		}
		expect(isQuotaRead(read)).toBe(true);
	});

	test("declines_unsupported_auth_without_any_request", async () => {
		const apiKey = harness({ authMethod: "key" });
		expect(await apiKey.adapter.resolve(apiKey.input)).toBeNull();
		expect(apiKey.requests).toHaveLength(0);
		expect(apiKey.companionReads).toHaveLength(0);

		const otherProvider = harness({
			providerID: "opencode",
			integrationID: "opencode",
		});
		expect(await otherProvider.adapter.resolve(otherProvider.input)).toBeNull();
		expect(otherProvider.requests).toHaveLength(0);
	});

	test("identity_key_and_is_current_track_reread_identity", async () => {
		const h = harness();
		const source = await h.source();
		expect(source.identityKey).not.toContain(CLIENT_ID);
		expect(source.identityKey).not.toContain(COMPANION_TOKEN);
		expect(source.identityKey).not.toContain(NATIVE_SIGNATURE);
		expect(await source.isCurrent()).toBe(true);

		h.setCompanion(
			companionRead(
				companionCredential({ identityKey: "synthetic-companion-identity-b" }),
			),
		);
		expect(await source.isCurrent()).toBe(false);

		const moved = harness();
		const first = await moved.source();
		moved.setStore(
			authStore(
				nativeEntry({
					access: nativeJwt({ client_id: OTHER_CLIENT_ID }),
					metadata: { clientID: OTHER_CLIENT_ID },
				}),
			),
		);
		const second = await moved.source();
		expect(second.identityKey).not.toBe(first.identityKey);
		expect(await first.isCurrent()).toBe(false);
	});
});

describe("adapter declarations", () => {
	test("declares_the_support_matrix_without_requests", () => {
		const h = harness();
		expect(h.adapter.id).toBe("openai-companion");
		const byName = new Map(
			h.adapter.capabilities.map((capability) => [capability.name, capability]),
		);
		expect(byName.get("OpenAI ChatGPT with Codex companion")).toMatchObject({
			match: { integrationID: "openai", authMethod: "oauth" },
			support: "requires-companion",
			evidence: "live-validated",
		});
		expect(
			byName.get("OpenAI ChatGPT token-sharing without companion consent"),
		).toMatchObject({
			support: "unsupported",
		});
		expect(byName.get("OpenCode Console")).toMatchObject({
			match: { integrationID: "opencode", authMethod: "oauth" },
			support: "unsupported",
			evidence: "unverified",
		});
		expect(byName.get("OpenCode Zen and Go API keys")).toMatchObject({
			match: { integrationID: "opencode", authMethod: "key" },
			support: "unsupported",
			evidence: "unverified",
		});
		expect(byName.get("OpenAI inference API key")).toMatchObject({
			match: { integrationID: "openai", authMethod: "key" },
			support: "unsupported",
			evidence: "documented-only",
		});
		expect(h.requests).toHaveLength(0);
	});
});

function hostEntry(clientID: string): Record<string, unknown> {
	return nativeEntry({
		access: nativeJwt({ client_id: clientID }),
		metadata: { clientID, scopes: ["openid", "chatgpt.tokens.use.direct"] },
	});
}

describe("native host credential bridge", () => {
	test("prefers_host_native_credential_over_file_store", async () => {
		// The file entry points at a different registration; only the host value
		// can match the app, so a file read would surface as a mismatch.
		const h = harness({
			native: hostEntry(CLIENT_ID),
			store: authStore(hostEntry(OTHER_CLIENT_ID)),
		});
		const read = await h.read();

		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		expect(section(read, "app").state).toBe("available");
		expect(h.requests.map((call) => call.url)).toEqual([APPS_URL, PLAN_URL]);
		expect(h.credentialReads).toHaveLength(0);
		expect(h.nativeReads).toEqual(["openai", "openai"]);
	});

	test("falls_back_to_file_store_when_host_returns_undefined", async () => {
		const h = harness({ native: () => undefined });
		const read = await h.read();

		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		expect(h.nativeReads).toEqual(["openai", "openai"]);
		expect(h.credentialReads.map((call) => call.path)).toEqual([
			AUTH_PATH,
			AUTH_PATH,
		]);
	});

	test("host_credential_error_maps_to_sanitized_unavailable", async () => {
		const secret = "host-bridge-error-sentinel";
		const h = harness({
			native: () => {
				throw new Error(`host bridge failed for ${secret}`);
			},
		});
		const source = await h.source();
		const read = await source.read(new AbortController().signal);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "invalid_response",
			attemptedAt: NOW,
		});
		expect(JSON.stringify(read)).not.toContain(secret);
		expect(await source.isCurrent()).toBe(false);
		expect(h.requests).toHaveLength(0);
		expect(h.credentialReads).toHaveLength(0);
	});

	test("active_only_host_value_gives_fresh_identity", async () => {
		const h = harness({ native: hostEntry(CLIENT_ID) });
		const first = await h.source();
		expect(await first.isCurrent()).toBe(true);

		// Switching the active credential changes the observed registration.
		h.setNative(hostEntry(OTHER_CLIENT_ID));
		const second = await h.source();
		expect(second.identityKey).not.toBe(first.identityKey);
		expect(await first.isCurrent()).toBe(false);
		expect(await second.isCurrent()).toBe(true);

		// An active-account change on the companion side is equally observable.
		h.setCompanion(
			companionRead(
				companionCredential({
					accountID: "synthetic-other-companion-account",
					identityKey: "synthetic-companion-identity-b",
				}),
			),
		);
		expect(await second.isCurrent()).toBe(false);
		expect(h.credentialReads).toHaveLength(0);
	});

	test("unresolved_identity_keeps_companion_fingerprint", async () => {
		const h = harness({
			native: { type: "oauth", access: "not-a-jwt" },
			companion: companionRead(
				companionCredential({ identityKey: "companion-unresolved-a" }),
			),
		});
		const first = await h.source();
		expectUnavailable(await h.read(), "invalid_native_registration");

		h.setCompanion(
			companionRead(
				companionCredential({ identityKey: "companion-unresolved-b" }),
			),
		);
		const second = await h.source();
		expect(second.identityKey).not.toBe(first.identityKey);
		expect(await first.isCurrent()).toBe(false);
		expect(h.credentialReads).toHaveLength(0);
	});
});

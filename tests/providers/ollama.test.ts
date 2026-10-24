import { describe, expect, test } from "bun:test";
import {
	type AdapterResolveInput,
	type CredentialReadDeps,
	isQuotaRead,
	type ProviderDeps,
	type QuotaMetric,
	type QuotaRead,
	type ResolvedQuotaSource,
} from "../../src/core/contracts";
import {
	createQuotaTransport,
	QUOTA_MAX_RESPONSE_BYTES,
	type QuotaFetch,
	type QuotaFetchResponse,
} from "../../src/providers/http";
import {
	createOllamaAdapter,
	fetchOllamaQuota,
} from "../../src/providers/ollama";

const NOW = 1_790_000_000_000;
const SENTINEL = "ollama-sentinel-key-do-not-leak";
const BALANCE_URL = "https://ollama.com/api/balance";
const DATA_HOME = "/synthetic/data";
const AUTH_PATH = `${DATA_HOME}/opencode/auth.json`;
const REFILL_ISO = "2026-10-15T09:30:00Z";
const REFILL_MS = Date.parse(REFILL_ISO);

const SAVED_KEY_STORE = {
	"ollama-cloud": { type: "api", key: SENTINEL },
};

type RequestCall = {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal;
};

type CredentialObservation = {
	paths: string[];
	limits: number[];
	calls: number;
};

function observation(): CredentialObservation {
	return { paths: [], limits: [], calls: 0 };
}

function credentials(
	store: unknown,
	observed: CredentialObservation = observation(),
	env: Record<string, string | undefined> = { XDG_DATA_HOME: DATA_HOME },
): CredentialReadDeps {
	return {
		now: () => NOW,
		env,
		homeDirectory: "/synthetic/home",
		async readUtf8(path, maxBytes) {
			observed.calls += 1;
			observed.paths.push(path);
			observed.limits.push(maxBytes);
			return JSON.stringify(store);
		},
	};
}

function rawCredentials(
	text: string,
	observed: CredentialObservation = observation(),
): CredentialReadDeps {
	return {
		now: () => NOW,
		env: { XDG_DATA_HOME: DATA_HOME },
		homeDirectory: "/synthetic/home",
		async readUtf8(path, maxBytes) {
			observed.calls += 1;
			observed.paths.push(path);
			observed.limits.push(maxBytes);
			return text;
		},
	};
}

function throwingCredentials(
	observed: CredentialObservation = observation(),
): CredentialReadDeps {
	return {
		now: () => NOW,
		env: { XDG_DATA_HOME: DATA_HOME },
		homeDirectory: "/synthetic/home",
		async readUtf8(path, maxBytes) {
			observed.calls += 1;
			observed.paths.push(path);
			observed.limits.push(maxBytes);
			throw new Error(`cannot read ${path} within ${maxBytes} bytes`);
		},
	};
}

function payloadDeps(
	payload: unknown,
	calls: RequestCall[] = [],
): ProviderDeps {
	return {
		now: () => NOW,
		async getJson(url, headers, signal) {
			calls.push({ url, headers, signal });
			return payload;
		},
	};
}

function transportDeps(
	fetchImpl: QuotaFetch,
	timeoutMs?: number,
): ProviderDeps {
	const request = createQuotaTransport(
		fetchImpl,
		timeoutMs === undefined ? {} : { timeoutMs },
	);
	return {
		now: () => NOW,
		getJson: (url, headers, signal) => request(url, headers, signal),
	};
}

async function resolveOllama(
	deps: ProviderDeps,
	credentialDeps: CredentialReadDeps,
	overrides: Partial<
		Pick<AdapterResolveInput, "providerID" | "integrationID" | "authMethod">
	> = {},
): Promise<ResolvedQuotaSource | null> {
	return createOllamaAdapter().resolve({
		providerID: "ollama",
		integrationID: "ollama-cloud",
		authMethod: "key",
		companion: { enabled: false },
		deps,
		credentialDeps,
		signal: new AbortController().signal,
		...overrides,
	});
}

async function resolveOrFail(
	deps: ProviderDeps,
	credentialDeps: CredentialReadDeps,
): Promise<ResolvedQuotaSource> {
	const source = await resolveOllama(deps, credentialDeps);
	if (source === null) {
		throw new Error("expected the Ollama adapter to resolve the connection");
	}
	return source;
}

async function readPayload(
	payload: unknown,
	apiKey = SENTINEL,
): Promise<{ read: QuotaRead; calls: RequestCall[] }> {
	const calls: RequestCall[] = [];
	const read = await fetchOllamaQuota(
		apiKey,
		new AbortController().signal,
		payloadDeps(payload, calls),
	);
	expect(isQuotaRead(read)).toBe(true);
	return { read, calls };
}

function officialBalance(overrides: Record<string, unknown> = {}) {
	return {
		included: {
			balance_usd: 40,
			allowance_usd: 60,
			period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			...overrides,
		},
		purchased: { balance_usd: 5 },
	};
}

function metricsOf(read: QuotaRead): QuotaMetric[] {
	if (read.state !== "available" && read.state !== "partial") {
		return [];
	}
	return read.sections.flatMap((section) =>
		section.result.state === "available" ? section.result.metrics : [],
	);
}

function metricById(read: QuotaRead, id: string): QuotaMetric | undefined {
	return metricsOf(read).find((metric) => metric.id === id);
}

function moneyRemaining(read: QuotaRead, id: string): number | undefined {
	const metric = metricById(read, id);
	return metric?.kind === "money" ? metric.remaining : undefined;
}

function unavailableSections(read: QuotaRead) {
	if (read.state !== "available" && read.state !== "partial") {
		return [];
	}
	return read.sections.filter(
		(section) => section.result.state !== "available",
	);
}

function syntheticFetch(
	respond: (
		url: string,
		init: Parameters<QuotaFetch>[1],
	) => QuotaFetchResponse | Promise<QuotaFetchResponse>,
): { fetchImpl: QuotaFetch; calls: RequestCall[] } {
	const calls: RequestCall[] = [];
	const fetchImpl: QuotaFetch = async (url, init) => {
		calls.push({ url, headers: init.headers, signal: init.signal });
		return await respond(url, init);
	};
	return { fetchImpl, calls };
}

function hangUntilAborted(
	signalValue: AbortSignal,
): Promise<QuotaFetchResponse> {
	return new Promise<QuotaFetchResponse>((_resolve, reject) => {
		const abort = () => {
			reject(new DOMException(`aborted ${SENTINEL}`, "AbortError"));
		};
		if (signalValue.aborted) {
			abort();
			return;
		}
		signalValue.addEventListener("abort", abort, { once: true });
	});
}

function jsonOfExactSize(size: number): string {
	const prefix = '{"p":"';
	const suffix = '"}';
	return `${prefix}${"a".repeat(size - prefix.length - suffix.length)}${suffix}`;
}

describe("Ollama existing-key quota", () => {
	test("uses_existing_key_and_keeps_credit_pools_separate", async () => {
		const calls: RequestCall[] = [];
		const observed = observation();
		const source = await resolveOrFail(
			payloadDeps(officialBalance(), calls),
			credentials(SAVED_KEY_STORE, observed),
		);

		expect(await source.isCurrent()).toBe(true);

		const readSignal = new AbortController().signal;
		const read = await source.read(readSignal);
		expect(isQuotaRead(read)).toBe(true);
		expect(read.state).toBe("available");
		if (read.state !== "available" && read.state !== "partial") {
			throw new Error("expected an available Ollama read");
		}
		expect(read.authSource).toBe("opencode");

		const included = metricById(read, "ollama-included");
		const purchased = metricById(read, "ollama-purchased");
		const total = metricById(read, "ollama-total");
		expect(included).toEqual({
			kind: "money",
			id: "ollama-included",
			scope: "provider-balance",
			label: "Included credits",
			currency: "USD",
			remaining: 40,
			allowance: 60,
			used: 20,
			resetsAt: REFILL_MS,
		});
		expect(purchased).toEqual({
			kind: "money",
			id: "ollama-purchased",
			scope: "provider-balance",
			label: "Purchased credits",
			currency: "USD",
			remaining: 5,
		});
		expect(total).toEqual({
			kind: "money",
			id: "ollama-total",
			scope: "provider-balance",
			label: "Total credits",
			currency: "USD",
			remaining: 45,
		});
		expect(purchased).not.toHaveProperty("allowance");
		expect(purchased).not.toHaveProperty("used");
		expect(observed.paths).toEqual([AUTH_PATH, AUTH_PATH]);
		expect(observed.limits.every((limit) => limit > 0)).toBeTrue();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(BALANCE_URL);
		expect(calls[0]?.headers).toEqual({
			Authorization: `Bearer ${SENTINEL}`,
			Accept: "application/json",
		});
		expect(calls[0]?.signal).toBe(readSignal);

		const section = read.sections[0];
		if (section?.result.state !== "available") {
			throw new Error("expected an available balance section");
		}
		expect(section.scope).toBe("provider-balance");
		expect(section.result.fetchedAt).toBe(NOW);
		expect(section.result.expiresAt).toBeLessThanOrEqual(REFILL_MS);
		expect(section.result.expiresAt).toBeLessThanOrEqual(NOW + 60_000);

		for (const value of [read, source]) {
			expect(JSON.stringify(value)).not.toContain(SENTINEL);
		}
	});

	test("converts_reset_seconds_to_epoch_ms_once", async () => {
		const resetSeconds = 1_792_000_000;
		const { read } = await readPayload({
			included: {
				balance_usd: 40,
				allowance_usd: 60,
				period: { from: "2026-09-15T09:30:00Z", until: resetSeconds },
			},
			purchased: { balance_usd: 5 },
		});

		expect(metricById(read, "ollama-included")?.resetsAt).toBe(
			resetSeconds * 1000,
		);
	});

	test("keeps_money_arithmetic_decimal_exact", async () => {
		const { read } = await readPayload({
			included: {
				balance_usd: 0.1,
				allowance_usd: 0.3,
				period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			},
			purchased: { balance_usd: 0.2 },
		});

		const included = metricById(read, "ollama-included");
		if (included?.kind !== "money") {
			throw new Error("expected the included money metric");
		}
		expect(included.used).toBe(0.2);
		expect(moneyRemaining(read, "ollama-total")).toBe(0.3);
	});

	test("reports_zero_balance_as_real_exhaustion", async () => {
		const { read } = await readPayload({
			included: {
				balance_usd: 0,
				allowance_usd: 60,
				period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			},
			purchased: { balance_usd: 0 },
		});

		expect(read.state).toBe("available");
		expect(metricById(read, "ollama-included")).toEqual({
			kind: "money",
			id: "ollama-included",
			scope: "provider-balance",
			label: "Included credits",
			currency: "USD",
			remaining: 0,
			allowance: 60,
			used: 60,
			resetsAt: REFILL_MS,
		});
		expect(moneyRemaining(read, "ollama-purchased")).toBe(0);
		expect(moneyRemaining(read, "ollama-total")).toBe(0);
	});

	test("keeps_missing_purchased_balance_unknown", async () => {
		const { read } = await readPayload({
			included: {
				balance_usd: 40,
				allowance_usd: 60,
				period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			},
		});

		expect(read.state).toBe("available");
		expect(moneyRemaining(read, "ollama-included")).toBe(40);
		expect(metricById(read, "ollama-purchased")).toBeUndefined();
		expect(metricById(read, "ollama-total")).toBeUndefined();
		expect(
			metricsOf(read).some(
				(metric) => metric.kind === "money" && metric.remaining === 0,
			),
		).toBeFalse();
	});

	test("keeps_missing_included_remaining_unknown", async () => {
		const { read } = await readPayload({
			included: {
				allowance_usd: 60,
				period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			},
			purchased: { balance_usd: 5 },
		});

		expect(read.state).toBe("partial");
		expect(metricById(read, "ollama-included")).toBeUndefined();
		expect(metricById(read, "ollama-total")).toBeUndefined();
		expect(moneyRemaining(read, "ollama-purchased")).toBe(5);
		expect(
			metricsOf(read).some(
				(metric) => metric.kind === "money" && metric.remaining === 0,
			),
		).toBeFalse();
		expect(unavailableSections(read)).toHaveLength(1);
		expect(unavailableSections(read)[0]?.result).toMatchObject({
			state: "unavailable",
			reason: "invalid_response",
		});
	});

	test("rejects_malformed_and_negative_money", async () => {
		const cases = [
			{
				included: {
					balance_usd: -40,
					allowance_usd: 60,
					period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
				},
				purchased: { balance_usd: "5" },
			},
			{
				included: {
					balance_usd: 40,
					allowance_usd: -60,
					period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
				},
				purchased: { balance_usd: -5 },
			},
		];

		for (const payload of cases) {
			const { read } = await readPayload(payload);
			expect(read).toEqual({
				state: "unavailable",
				reason: "invalid_response",
				attemptedAt: NOW,
			});
			expect(JSON.stringify(read)).not.toContain(SENTINEL);
		}
	});

	test("omits_invalid_pools_without_fabricating_values", async () => {
		const { read } = await readPayload({
			included: {
				balance_usd: -40,
				allowance_usd: 60,
				period: { from: "2026-09-15T09:30:00Z", until: REFILL_ISO },
			},
			purchased: { balance_usd: 5 },
		});

		expect(read.state).toBe("partial");
		expect(metricById(read, "ollama-included")).toBeUndefined();
		expect(metricById(read, "ollama-total")).toBeUndefined();
		expect(moneyRemaining(read, "ollama-purchased")).toBe(5);
		for (const metric of metricsOf(read)) {
			if (metric.kind === "money") {
				expect(Number.isFinite(metric.remaining)).toBeTrue();
				expect(metric.remaining).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

describe("Ollama legacy plan windows", () => {
	test("parses_legacy_windows_with_reported_durations", async () => {
		const weeklyResetSeconds = 1_792_000_000;
		const { read } = await readPayload({
			included: {
				session: {
					remaining_percent: 75,
					resets_at: "2026-10-01T07:00:00Z",
					window_seconds: 18_000,
				},
				weekly: {
					remaining_percent: 40,
					resets_at: weeklyResetSeconds,
					duration_seconds: 604_800,
				},
			},
			purchased: { balance_usd: 25 },
		});

		expect(read.state).toBe("available");
		expect(metricById(read, "ollama-session")).toEqual({
			kind: "window",
			id: "ollama-session",
			scope: "provider-balance",
			label: "Session limit",
			windowSeconds: 18_000,
			remainingPercent: 75,
			usedPercent: 25,
			resetsAt: Date.parse("2026-10-01T07:00:00Z"),
		});
		expect(metricById(read, "ollama-weekly")).toEqual({
			kind: "window",
			id: "ollama-weekly",
			scope: "provider-balance",
			label: "Weekly limit",
			windowSeconds: 604_800,
			remainingPercent: 40,
			usedPercent: 60,
			resetsAt: weeklyResetSeconds * 1000,
		});
		expect(moneyRemaining(read, "ollama-purchased")).toBe(25);
		expect(metricById(read, "ollama-included")).toBeUndefined();
		expect(metricById(read, "ollama-total")).toBeUndefined();
	});

	test("does_not_guess_legacy_window_durations", async () => {
		const { read } = await readPayload({
			included: {
				session: {
					remaining_percent: 75,
					resets_at: "2026-10-01T07:00:00Z",
				},
				weekly: {
					remaining_percent: 40,
					resets_at: "2026-10-05T00:00:00Z",
				},
			},
			purchased: { balance_usd: 25 },
		});

		expect(read.state).toBe("partial");
		expect(metricById(read, "ollama-session")).toBeUndefined();
		expect(metricById(read, "ollama-weekly")).toBeUndefined();
		expect(moneyRemaining(read, "ollama-purchased")).toBe(25);
		expect(unavailableSections(read)).toHaveLength(1);
		for (const metric of metricsOf(read)) {
			if (metric.kind === "window") {
				expect([18_000, 604_800]).not.toContain(metric.windowSeconds);
			}
		}
	});
});

describe("Ollama adapter transport semantics", () => {
	test("propagates_429_and_retry_after", async () => {
		const { fetchImpl } = syntheticFetch(
			() =>
				new Response(JSON.stringify({ error: "slow down" }), {
					status: 429,
					headers: { "retry-after": "2" },
				}),
		);
		const read = await fetchOllamaQuota(
			SENTINEL,
			new AbortController().signal,
			transportDeps(fetchImpl),
		);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "rate_limited",
			attemptedAt: NOW,
			retryAfterMs: 2_000,
		});
	});

	test("propagates_timeout", async () => {
		const { fetchImpl } = syntheticFetch((_url, init) =>
			hangUntilAborted(init.signal),
		);
		const read = await fetchOllamaQuota(
			SENTINEL,
			new AbortController().signal,
			transportDeps(fetchImpl, 20),
		);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "timeout",
			attemptedAt: NOW,
		});
	});

	test("propagates_cancellation_as_network_error", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetchImpl, calls } = syntheticFetch(
			() => new Response(JSON.stringify(officialBalance())),
		);
		const read = await fetchOllamaQuota(
			SENTINEL,
			controller.signal,
			transportDeps(fetchImpl),
		);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "network_error",
			attemptedAt: NOW,
		});
		expect(calls).toHaveLength(0);
	});

	test("rejects_redirects", async () => {
		const { fetchImpl } = syntheticFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/steal" },
				}),
		);
		const read = await fetchOllamaQuota(
			SENTINEL,
			new AbortController().signal,
			transportDeps(fetchImpl),
		);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "invalid_response",
			attemptedAt: NOW,
		});
		expect(JSON.stringify(read)).not.toContain("evil.example");
		expect(JSON.stringify(read)).not.toContain(SENTINEL);
	});

	test("rejects_oversized_responses", async () => {
		const body = jsonOfExactSize(QUOTA_MAX_RESPONSE_BYTES + 1);
		const { fetchImpl } = syntheticFetch(() => new Response(body));
		const read = await fetchOllamaQuota(
			SENTINEL,
			new AbortController().signal,
			transportDeps(fetchImpl),
		);

		expect(isQuotaRead(read)).toBe(true);
		expect(read).toEqual({
			state: "unavailable",
			reason: "invalid_response",
			attemptedAt: NOW,
		});
	});

	test("maps_rejected_credentials_to_auth_required", async () => {
		for (const status of [401, 403]) {
			const { fetchImpl } = syntheticFetch(
				() =>
					new Response(JSON.stringify({ error: "invalid credentials" }), {
						status,
					}),
			);
			const read = await fetchOllamaQuota(
				SENTINEL,
				new AbortController().signal,
				transportDeps(fetchImpl),
			);

			expect(isQuotaRead(read)).toBe(true);
			expect(read).toEqual({
				state: "auth-required",
				reason: "unsupported_auth_method",
				attemptedAt: NOW,
			});
			expect(JSON.stringify(read)).not.toContain(SENTINEL);
		}
	});
});

describe("Ollama adapter connection matching", () => {
	test("declines_purely_local_ollama_models", async () => {
		const observed = observation();
		const calls: RequestCall[] = [];
		const deps = payloadDeps(officialBalance(), calls);
		const credentialDeps = credentials(SAVED_KEY_STORE, observed);

		expect(
			await resolveOllama(deps, credentialDeps, {
				providerID: "ollama",
				integrationID: undefined,
				authMethod: "none",
			}),
		).toBeNull();
		expect(
			await resolveOllama(deps, credentialDeps, {
				providerID: "ollama",
				integrationID: "ollama",
				authMethod: "key",
			}),
		).toBeNull();
		expect(observed.calls).toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("declines_custom_hosts_without_reading_the_key", async () => {
		const observed = observation();
		const calls: RequestCall[] = [];
		const source = await resolveOllama(
			payloadDeps(officialBalance(), calls),
			credentials(SAVED_KEY_STORE, observed),
			{
				providerID: "custom-ollama",
				integrationID: "custom-ollama-host",
				authMethod: "key",
			},
		);

		expect(source).toBeNull();
		expect(observed.calls).toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("declines_when_the_saved_key_is_missing_or_unusable", async () => {
		const deps = payloadDeps(officialBalance());
		const cases: CredentialReadDeps[] = [
			credentials({}),
			credentials({ "ollama-cloud": { type: "api", key: "   " } }),
			credentials({ "ollama-cloud": { type: "oauth", key: SENTINEL } }),
			credentials({ "ollama-cloud": { type: "api", key: "line\nbreak" } }),
			rawCredentials("{not json"),
			throwingCredentials(),
		];

		for (const credentialDeps of cases) {
			expect(await resolveOllama(deps, credentialDeps)).toBeNull();
		}
	});

	test("falls_back_to_home_data_directory", async () => {
		const observed = observation();
		const source = await resolveOllama(
			payloadDeps(officialBalance()),
			credentials(SAVED_KEY_STORE, observed, {}),
		);

		expect(source).not.toBeNull();
		expect(observed.paths).toEqual([
			"/synthetic/home/.local/share/opencode/auth.json",
		]);
	});

	test("tracks_saved_key_rotation_for_currentness", async () => {
		let savedKey = SENTINEL;
		const calls: RequestCall[] = [];
		const credentialDeps: CredentialReadDeps = {
			now: () => NOW,
			env: { XDG_DATA_HOME: DATA_HOME },
			homeDirectory: "/synthetic/home",
			async readUtf8() {
				return JSON.stringify({
					"ollama-cloud": { type: "api", key: savedKey },
				});
			},
		};
		const source = await resolveOrFail(
			payloadDeps(officialBalance(), calls),
			credentialDeps,
		);

		expect(await source.isCurrent()).toBe(true);
		savedKey = `${SENTINEL}-rotated`;
		expect(await source.isCurrent()).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("declares_both_supported_capability_rows", () => {
		const adapter = createOllamaAdapter();
		expect(adapter.id).toBe("ollama-balance");
		expect(adapter.capabilities).toEqual([
			{
				match: { integrationID: "ollama-cloud", authMethod: "key" },
				name: "Ollama Cloud",
				support: "supported",
				evidence: "live-validated",
			},
			{
				match: { integrationID: "ollama-cloud", authMethod: "key" },
				name: "Ollama Cloud legacy session/weekly plan",
				support: "supported",
				evidence: "documented-only",
			},
		]);
	});
});

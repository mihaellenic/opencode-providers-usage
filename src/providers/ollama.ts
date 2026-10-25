import { createHash } from "node:crypto";
import {
	type AdapterResolveInput,
	type CredentialReadDeps,
	type ProviderAdapter,
	type ProviderCapability,
	type ProviderDeps,
	type QuotaMetric,
	type QuotaRead,
	QuotaRequestError,
	type ResolvedQuotaSource,
	type SectionResult,
} from "../core/contracts";

export const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";

const OLLAMA_CLOUD_INTEGRATION_ID = "ollama-cloud";
const AUTH_STORE_MAX_BYTES = 256 * 1024;
const SECTION_POLL_MS = 60_000;

const CAPABILITIES: readonly ProviderCapability[] = [
	{
		match: { integrationID: OLLAMA_CLOUD_INTEGRATION_ID, authMethod: "key" },
		name: "Ollama Cloud",
		support: "supported",
		evidence: "live-validated",
	},
	{
		match: { integrationID: OLLAMA_CLOUD_INTEGRATION_ID, authMethod: "key" },
		name: "Ollama Cloud legacy session/weekly plan",
		support: "supported",
		evidence: "documented-only",
	},
];

const TRANSPORT_REASONS: ReadonlySet<string> = new Set([
	"rate_limited",
	"timeout",
	"network_error",
	"invalid_response",
]);

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;
const BEARER_PATTERN = /^[\x21-\x7e]+$/;
const IDENTITY_DOMAIN = "opencode-provider-usage:ollama-balance:v1";

/**
 * A server-private credential fingerprint. The coordinator uses the identity
 * key to detect credential rotation and to isolate cached figures; the value
 * is never included in a QuotaRead, RPC envelope, or log line.
 */
function credentialFingerprint(apiKey: string): string {
	return createHash("sha256")
		.update(IDENTITY_DOMAIN)
		.update("\0")
		.update(apiKey)
		.digest("hex");
}

type Decimal = { units: bigint; scale: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts a JSON number to an exact decimal. `String` yields the shortest
 * round-trippable form of the double, so arithmetic never starts from binary
 * floating-point fractions.
 */
function decimalFromString(text: string): Decimal | null {
	const match = DECIMAL_PATTERN.exec(text);
	if (match === null) {
		return null;
	}
	const whole = match[1] ?? "0";
	const fraction = match[2] ?? "";
	const exponent = Number(match[3] ?? "0");
	if (!Number.isSafeInteger(exponent)) {
		return null;
	}
	let units = BigInt(`${whole}${fraction}`);
	let scale = fraction.length - exponent;
	if (scale < 0) {
		units *= 10n ** BigInt(-scale);
		scale = 0;
	}
	return { units, scale };
}

function decimalFromNumber(value: unknown): Decimal | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return decimalFromString(String(value));
}

function aligned(
	left: Decimal,
	right: Decimal,
): { left: bigint; right: bigint; scale: number } {
	const scale = Math.max(left.scale, right.scale);
	return {
		left: left.units * 10n ** BigInt(scale - left.scale),
		right: right.units * 10n ** BigInt(scale - right.scale),
		scale,
	};
}

function addDecimals(left: Decimal, right: Decimal): Decimal {
	const value = aligned(left, right);
	return { units: value.left + value.right, scale: value.scale };
}

function subtractDecimals(left: Decimal, right: Decimal): Decimal | null {
	const value = aligned(left, right);
	if (value.left < value.right) {
		return null;
	}
	return { units: value.left - value.right, scale: value.scale };
}

function decimalToNumber(value: Decimal): number {
	if (value.scale === 0) {
		return Number(value.units);
	}
	const digits = value.units.toString().padStart(value.scale + 1, "0");
	const split = digits.length - value.scale;
	const whole = digits.slice(0, split);
	const fraction = digits.slice(split).replace(/0+$/, "");
	return Number(fraction === "" ? whole : `${whole}.${fraction}`);
}

/**
 * Provider reset epochs are seconds; ISO date-times are accepted for the
 * documented balance shape. Milliseconds leave this function once.
 */
function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) {
			return undefined;
		}
		const milliseconds = value * 1000;
		return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") {
			return undefined;
		}
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function percentage(value: unknown): number | undefined {
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
	) {
		return value;
	}
	return undefined;
}

/**
 * Legacy plans report their own duration when they report one at all. Without
 * a reported duration the window length is unknown; a session/weekly label is
 * never turned into an assumed five-hour or seven-day span.
 */
function reportedWindowSeconds(
	value: Record<string, unknown>,
): number | undefined {
	for (const candidate of [value.window_seconds, value.duration_seconds]) {
		if (
			typeof candidate === "number" &&
			Number.isFinite(candidate) &&
			candidate > 0
		) {
			return candidate;
		}
	}
	return undefined;
}

type IncludedParse = {
	metric?: QuotaMetric;
	remaining?: Decimal;
	invalid: boolean;
};

function parseOfficialIncluded(
	included: Record<string, unknown>,
): IncludedParse {
	const balance = decimalFromNumber(included.balance_usd);
	const allowance = decimalFromNumber(included.allowance_usd);
	if (balance === null || allowance === null) {
		return { invalid: true };
	}
	const used = subtractDecimals(allowance, balance);
	if (used === null) {
		return { invalid: true };
	}
	const period = isRecord(included.period) ? included.period : undefined;
	const reset = period === undefined ? undefined : timestampMs(period.until);
	const metric: QuotaMetric = {
		kind: "money",
		id: "ollama-included",
		scope: "provider-balance",
		label: "Included credits",
		currency: "USD",
		remaining: decimalToNumber(balance),
		allowance: decimalToNumber(allowance),
		used: decimalToNumber(used),
		...(reset === undefined ? {} : { resetsAt: reset }),
	};
	return {
		metric,
		remaining: balance,
		invalid: false,
	};
}

function parseLegacyLimit(
	limit: unknown,
	id: string,
	label: string,
): IncludedParse {
	if (!isRecord(limit)) {
		return { invalid: true };
	}
	const remaining = percentage(limit.remaining_percent);
	const windowSeconds = reportedWindowSeconds(limit);
	if (remaining === undefined || windowSeconds === undefined) {
		return { invalid: true };
	}
	const reset = timestampMs(limit.resets_at);
	const metric: QuotaMetric = {
		kind: "window",
		id,
		scope: "provider-balance",
		label,
		windowSeconds,
		remainingPercent: remaining,
		usedPercent: 100 - remaining,
		...(reset === undefined ? {} : { resetsAt: reset }),
	};
	return {
		metric,
		invalid: false,
	};
}

type PurchasedParse = {
	metric?: QuotaMetric;
	remaining?: Decimal;
	invalid: boolean;
};

function parsePurchased(purchased: unknown): PurchasedParse {
	if (purchased === undefined) {
		return { invalid: false };
	}
	if (!isRecord(purchased)) {
		return { invalid: true };
	}
	const balance = decimalFromNumber(purchased.balance_usd);
	if (balance === null) {
		return { invalid: true };
	}
	return {
		metric: {
			kind: "money",
			id: "ollama-purchased",
			scope: "provider-balance",
			label: "Purchased credits",
			currency: "USD",
			remaining: decimalToNumber(balance),
		},
		remaining: balance,
		invalid: false,
	};
}

function invalidRead(attemptedAt: number): QuotaRead {
	return {
		state: "unavailable",
		reason: "invalid_response",
		attemptedAt,
	};
}

function parseBalance(payload: unknown, fetchedAt: number): QuotaRead {
	if (!isRecord(payload) || !isRecord(payload.included)) {
		return invalidRead(fetchedAt);
	}

	const included = payload.included;
	const metrics: QuotaMetric[] = [];
	let invalid = false;
	let includedMoney: Decimal | undefined;

	const isLegacy =
		included.balance_usd === undefined &&
		included.allowance_usd === undefined &&
		(isRecord(included.session) || isRecord(included.weekly));

	if (isLegacy) {
		const session = parseLegacyLimit(
			included.session,
			"ollama-session",
			"Session limit",
		);
		const weekly = parseLegacyLimit(
			included.weekly,
			"ollama-weekly",
			"Weekly limit",
		);
		for (const parsed of [session, weekly]) {
			if (parsed.metric !== undefined) {
				metrics.push(parsed.metric);
			}
			invalid = invalid || parsed.invalid;
		}
	} else {
		const parsedIncluded = parseOfficialIncluded(included);
		if (parsedIncluded.metric !== undefined) {
			metrics.push(parsedIncluded.metric);
		}
		invalid = invalid || parsedIncluded.invalid;
		includedMoney = parsedIncluded.remaining;
	}

	const parsedPurchased = parsePurchased(payload.purchased);
	if (parsedPurchased.metric !== undefined) {
		metrics.push(parsedPurchased.metric);
	}
	invalid = invalid || parsedPurchased.invalid;

	// The same-currency total exists only when both independent pools are
	// reported. A missing pool stays unknown rather than becoming zero.
	if (includedMoney !== undefined && parsedPurchased.remaining !== undefined) {
		metrics.push({
			kind: "money",
			id: "ollama-total",
			scope: "provider-balance",
			label: "Total credits",
			currency: "USD",
			remaining: decimalToNumber(
				addDecimals(includedMoney, parsedPurchased.remaining),
			),
		});
	}

	if (metrics.length === 0) {
		return invalidRead(fetchedAt);
	}

	const resets = metrics.flatMap((metric) =>
		metric.resetsAt === undefined ? [] : [metric.resetsAt],
	);
	const boundary =
		resets.length === 0 ? fetchedAt + SECTION_POLL_MS : Math.min(...resets);
	const expiresAt = Math.min(fetchedAt + SECTION_POLL_MS, boundary);
	const sections: { scope: "provider-balance"; result: SectionResult }[] = [
		{
			scope: "provider-balance",
			result: {
				state: "available",
				metrics,
				fetchedAt,
				expiresAt,
			},
		},
	];

	if (invalid) {
		sections.push({
			scope: "provider-balance",
			result: {
				state: "unavailable",
				reason: "invalid_response",
				attemptedAt: fetchedAt,
			},
		});
	}

	return {
		state: invalid ? "partial" : "available",
		authSource: "opencode",
		sections,
	};
}

function unavailableFromError(error: unknown, attemptedAt: number): QuotaRead {
	if (error instanceof QuotaRequestError) {
		if (error.status === 401 || error.status === 403) {
			return {
				state: "auth-required",
				reason: "unsupported_auth_method",
				attemptedAt,
			};
		}
		const reason = TRANSPORT_REASONS.has(error.reason)
			? error.reason
			: "invalid_response";
		return {
			state: "unavailable",
			reason,
			attemptedAt,
			...(error.retryAfterMs === undefined
				? {}
				: { retryAfterMs: error.retryAfterMs }),
		};
	}
	return invalidRead(attemptedAt);
}

export async function fetchOllamaQuota(
	apiKey: string,
	signal: AbortSignal,
	deps: ProviderDeps,
): Promise<QuotaRead> {
	const fetchedAt = deps.now();
	try {
		const payload = await deps.getJson(
			OLLAMA_BALANCE_URL,
			{
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal,
		);
		return parseBalance(payload, fetchedAt);
	} catch (error) {
		return unavailableFromError(error, fetchedAt);
	}
}

function authStorePath(deps: CredentialReadDeps): string {
	const dataHome = deps.env.XDG_DATA_HOME;
	const home = deps.homeDirectory.replace(/\/+$/, "");
	const base =
		dataHome !== undefined && dataHome.trim() !== ""
			? dataHome
			: `${home}/.local/share`;
	return `${base.replace(/\/+$/, "")}/opencode/auth.json`;
}

/**
 * The host serializes its active credential into the same entry shape the file
 * store uses, so one parser serves both sources.
 */
function parseOllamaKeyEntry(entry: unknown): string | null {
	if (!isRecord(entry)) {
		return null;
	}
	// OpenCode's file-backed store uses "api"; the V2 credential value uses
	// "key". Both carry the same saved API key.
	if (entry.type !== "api" && entry.type !== "key") {
		return null;
	}
	if (typeof entry.key !== "string") {
		return null;
	}
	const key = entry.key.trim();
	if (key === "" || !BEARER_PATTERN.test(key)) {
		return null;
	}
	return key;
}

async function readSavedOllamaKey(
	integrationID: string,
	deps: CredentialReadDeps,
): Promise<string | null> {
	let text: string;
	try {
		text = await deps.readUtf8(authStorePath(deps), AUTH_STORE_MAX_BYTES);
	} catch {
		return null;
	}

	let store: unknown;
	try {
		store = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(store)) {
		return null;
	}
	return parseOllamaKeyEntry(store[integrationID]);
}

type KeyResolution =
	| { state: "key"; key: string }
	| { state: "missing" }
	| { state: "error" };

/**
 * Preference order: the ACTIVE host credential, then the documented file-store
 * fallback (v1 hosts where auth.json is the store). A host bridge failure is an
 * observed failure, not a reason to trust a stale file entry; it becomes a
 * sanitized unavailable read at the caller.
 */
async function resolveOllamaKey(
	input: AdapterResolveInput,
	integrationID: string,
): Promise<KeyResolution> {
	const native = input.nativeCredential;
	if (native !== undefined) {
		let value: unknown;
		try {
			value = await native.resolve(integrationID);
		} catch {
			return { state: "error" };
		}
		if (value !== undefined) {
			const key = parseOllamaKeyEntry(value);
			return key === null ? { state: "missing" } : { state: "key", key };
		}
	}

	const key = await readSavedOllamaKey(integrationID, input.credentialDeps);
	return key === null ? { state: "missing" } : { state: "key", key };
}

function hostFailureSource(
	identityKey: string,
	input: AdapterResolveInput,
): ResolvedQuotaSource {
	return {
		identityKey,
		read: async () => ({
			state: "unavailable",
			reason: "invalid_response",
			attemptedAt: input.deps.now(),
		}),
		isCurrent: async () => false,
	};
}

export function createOllamaAdapter(): ProviderAdapter {
	return {
		id: "ollama-balance",
		capabilities: [...CAPABILITIES],
		async resolve(
			input: AdapterResolveInput,
		): Promise<ResolvedQuotaSource | null> {
			if (input.integrationID !== OLLAMA_CLOUD_INTEGRATION_ID) {
				return null;
			}
			if (input.authMethod !== "key") {
				return null;
			}

			const integrationID = input.integrationID;
			const resolution = await resolveOllamaKey(input, integrationID);
			if (resolution.state === "error") {
				return hostFailureSource(`ollama-balance:${integrationID}`, input);
			}
			if (resolution.state === "missing") {
				return null;
			}
			const apiKey = resolution.key;
			const fingerprint = credentialFingerprint(apiKey);

			return {
				identityKey: `ollama-balance:${integrationID}:${fingerprint}`,
				read: (signal) => fetchOllamaQuota(apiKey, signal, input.deps),
				isCurrent: async () => {
					const current = await resolveOllamaKey(input, integrationID);
					return current.state === "key" && current.key === apiKey;
				},
			};
		},
	};
}

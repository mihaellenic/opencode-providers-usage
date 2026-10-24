import { createHash } from "node:crypto";
import {
	type AdapterResolveInput,
	type CodexCompanion,
	type CompanionOptions,
	type CompanionRead,
	type CredentialReadDeps,
	type NativeRegistration,
	type ProviderAdapter,
	type ProviderCapability,
	type ProviderDeps,
	type QuotaMetric,
	type QuotaRead,
	type QuotaReason,
	QuotaRequestError,
	type RegistrationFailure,
	type ResolvedQuotaSource,
	type SectionResult,
	type UnavailableState,
} from "../core/contracts";

export const OPENAI_COMPANION_APPS_URL =
	"https://chatgpt.com/backend-api/wham/usage/chatpass/apps";
export const OPENAI_COMPANION_PLAN_URL =
	"https://chatgpt.com/backend-api/wham/usage";

const OPENAI_INTEGRATION_ID = "openai";
const TOKEN_SHARING_METHOD = "chatgpt-token-sharing";
const EXPECTED_ISSUER = "https://auth.openai.com";
const EXPECTED_AUDIENCE = "https://api.openai.com/v1";
const TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";
const USER_AGENT = "opencode-providers-usage/0.0.0";

const AUTH_STORE_MAX_BYTES = 256 * 1024;
const MAX_APPS = 128;
const MAX_WINDOWS = 32;
/** Upper bound in SECONDS; a millisecond epoch is rejected, never rescaled twice. */
const MAX_RESET_SECONDS = 8_640_000_000;
const SECTION_POLL_MS = 60_000;
/** A rejected request is attributed to expiry only this close to the cached exp. */
const NEAR_EXPIRY_MS = 60_000;

const APP_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
	"items",
	"has_more",
	"next_cursor",
]);

const TRANSPORT_REASONS: ReadonlySet<string> = new Set([
	"rate_limited",
	"timeout",
	"network_error",
	"invalid_response",
]);

const COMPANION_REASONS: ReadonlySet<string> = new Set([
	"companion_disabled",
	"companion_missing",
	"companion_expired",
	"unsupported_companion_storage",
	"invalid_companion",
]);

const NATIVE_REASONS: ReadonlySet<string> = new Set([
	"invalid_native_registration",
	"invalid_response",
]);

/**
 * Capability declarations only; the registry matches on provider/integration
 * and auth method. The first OpenAI OAuth entry describes the only supported
 * combination, so `summarize` prefers it. The remaining entries keep the
 * unsupported modes explicit without exploratory requests.
 */
const CAPABILITIES: readonly ProviderCapability[] = [
	{
		match: { integrationID: OPENAI_INTEGRATION_ID, authMethod: "oauth" },
		name: "OpenAI ChatGPT with Codex companion",
		support: "requires-companion",
		evidence: "live-validated",
	},
	{
		match: { integrationID: OPENAI_INTEGRATION_ID, authMethod: "oauth" },
		name: "OpenAI ChatGPT token-sharing without companion consent",
		support: "unsupported",
		evidence: "live-validated",
	},
	{
		match: { integrationID: "opencode", authMethod: "oauth" },
		name: "OpenCode Console",
		support: "unsupported",
		evidence: "unverified",
	},
	{
		match: { integrationID: "opencode", authMethod: "key" },
		name: "OpenCode Zen and Go API keys",
		support: "unsupported",
		evidence: "unverified",
	},
	{
		match: { integrationID: OPENAI_INTEGRATION_ID, authMethod: "key" },
		name: "OpenAI inference API key",
		support: "unsupported",
		evidence: "documented-only",
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percent(value: unknown): number | undefined {
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
 * JWT decoding supplies registration selectors only. Signatures are not
 * verified locally, and no decoded value is treated as proof of identity.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}
	const segment = parts[1];
	if (segment === undefined || segment === "") {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
	return isRecord(value) ? value : undefined;
}

function audienceMatches(value: unknown): boolean {
	if (typeof value === "string") {
		return value === EXPECTED_AUDIENCE;
	}
	if (Array.isArray(value)) {
		return value.includes(EXPECTED_AUDIENCE);
	}
	return false;
}

function scopeMatches(value: unknown): boolean {
	return (
		typeof value === "string" &&
		value.split(/\s+/).includes(TOKEN_SHARING_SCOPE)
	);
}

function registrationFailure(): RegistrationFailure {
	return { state: "unavailable", reason: "invalid_native_registration" };
}

/**
 * A stable, nonsecret connection fingerprint. The raw client identifier never
 * leaves this module through a diagnostic or identity key.
 */
function connectionKeyFor(clientID: string): string {
	return createHash("sha256")
		.update(`openai-companion\u0000${clientID}`)
		.digest("hex");
}

/**
 * Validates the current OpenCode ChatGPT token-sharing credential selectors:
 * the declared method, the public API issuer/audience/direct scope, and
 * metadata/`client_id` consistency. Opaque encrypted auth metadata is never
 * interpreted. A failure means the registration cannot be matched, not that
 * the native sign-in is broken.
 */
export function readNativeRegistration(
	value: unknown,
): NativeRegistration | RegistrationFailure {
	if (!isRecord(value) || value.type !== "oauth") {
		return registrationFailure();
	}

	const declared = [value.methodID, value.method].filter(
		(entry) => entry !== undefined,
	);
	if (declared.length === 0) {
		return registrationFailure();
	}
	for (const entry of declared) {
		if (entry !== TOKEN_SHARING_METHOD) {
			return registrationFailure();
		}
	}

	const access = value.access;
	if (typeof access !== "string" || access.trim() === "") {
		return registrationFailure();
	}
	const payload = decodeJwtPayload(access);
	if (payload === undefined) {
		return registrationFailure();
	}
	if (payload.iss !== EXPECTED_ISSUER) {
		return registrationFailure();
	}
	if (!audienceMatches(payload.aud)) {
		return registrationFailure();
	}
	if (!scopeMatches(payload.scope)) {
		return registrationFailure();
	}

	const clientID = payload.client_id;
	if (typeof clientID !== "string" || clientID.trim() === "") {
		return registrationFailure();
	}

	const metadata = value.metadata;
	if (!isRecord(metadata)) {
		return registrationFailure();
	}
	if (metadata.clientID !== clientID) {
		return registrationFailure();
	}
	const metadataScopes = metadata.scopes;
	if (metadataScopes !== undefined) {
		if (
			!Array.isArray(metadataScopes) ||
			!metadataScopes.every((entry) => typeof entry === "string") ||
			!metadataScopes.includes(TOKEN_SHARING_SCOPE)
		) {
			return registrationFailure();
		}
	}

	return { clientID, connectionKey: connectionKeyFor(clientID) };
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

async function loadNativeRegistration(
	input: AdapterResolveInput,
): Promise<NativeRegistration | RegistrationFailure> {
	const native = input.nativeCredential;
	if (native !== undefined) {
		let value: unknown;
		try {
			value = await native.resolve(OPENAI_INTEGRATION_ID);
		} catch {
			// The host bridge failed while observing the active credential; no
			// exception text or credential material reaches the result.
			return { state: "unavailable", reason: "invalid_response" };
		}
		if (value !== undefined) {
			return readNativeRegistration(value);
		}
	}

	return readFileNativeRegistration(input.credentialDeps);
}

async function readFileNativeRegistration(
	deps: CredentialReadDeps,
): Promise<NativeRegistration | RegistrationFailure> {
	let text: string;
	try {
		text = await deps.readUtf8(authStorePath(deps), AUTH_STORE_MAX_BYTES);
	} catch {
		return registrationFailure();
	}
	if (Buffer.byteLength(text, "utf8") > AUTH_STORE_MAX_BYTES) {
		return registrationFailure();
	}

	let store: unknown;
	try {
		store = JSON.parse(text);
	} catch {
		return registrationFailure();
	}
	if (!isRecord(store)) {
		return registrationFailure();
	}
	return readNativeRegistration(store[OPENAI_INTEGRATION_ID]);
}

type WindowParse = { metric: QuotaMetric } | { invalid: true };

/**
 * Durations and reset epochs arrive in SECONDS. The reset is multiplied once;
 * a value that looks like milliseconds is rejected instead of rescaled.
 */
function parseWindow(
	raw: unknown,
	id: string,
	scope: "app" | "shared-plan",
	label: string,
): WindowParse {
	if (!isRecord(raw)) {
		return { invalid: true };
	}

	const used =
		raw.used_percent === undefined ? undefined : percent(raw.used_percent);
	const remaining =
		raw.remaining_percent === undefined
			? undefined
			: percent(raw.remaining_percent);
	if (
		(raw.used_percent !== undefined && used === undefined) ||
		(raw.remaining_percent !== undefined && remaining === undefined)
	) {
		return { invalid: true };
	}
	if (used === undefined && remaining === undefined) {
		return { invalid: true };
	}
	// Both values are reported together; a contradictory pair is rejected
	// rather than clamped to a plausible total.
	if (
		used !== undefined &&
		remaining !== undefined &&
		Math.abs(used + remaining - 100) > 1
	) {
		return { invalid: true };
	}

	const windowSeconds = raw.limit_window_seconds;
	if (
		typeof windowSeconds !== "number" ||
		!Number.isSafeInteger(windowSeconds) ||
		windowSeconds <= 0
	) {
		return { invalid: true };
	}

	let resetsAt: number | undefined;
	if (raw.reset_at !== undefined && raw.reset_at !== null) {
		const reset = raw.reset_at;
		if (
			typeof reset !== "number" ||
			!Number.isSafeInteger(reset) ||
			reset <= 0 ||
			reset > MAX_RESET_SECONDS
		) {
			return { invalid: true };
		}
		resetsAt = reset * 1000;
	}

	return {
		metric: {
			kind: "window",
			id,
			scope,
			label,
			windowSeconds,
			...(used === undefined ? {} : { usedPercent: used }),
			...(remaining === undefined ? {} : { remainingPercent: remaining }),
			...(resetsAt === undefined ? {} : { resetsAt }),
		},
	};
}

function sectionExpiry(
	fetchedAt: number,
	metrics: QuotaMetric[],
	companion: CodexCompanion,
): number {
	const resets = metrics.flatMap((metric) =>
		metric.resetsAt === undefined ? [] : [metric.resetsAt],
	);
	const poll = fetchedAt + SECTION_POLL_MS;
	const boundary = resets.length === 0 ? poll : Math.min(...resets);
	return Math.min(poll, boundary, companion.expiresAt);
}

type SectionParse =
	| {
			ok: true;
			section: { scope: "app" | "shared-plan"; result: SectionResult };
	  }
	| {
			ok: false;
			reason: "app_registration_mismatch" | "invalid_response";
	  };

function invalidSection(): SectionParse {
	return { ok: false, reason: "invalid_response" };
}

function parseAppSection(
	payload: unknown,
	registrationID: string,
	fetchedAt: number,
	companion: CodexCompanion,
): SectionParse {
	if (!isRecord(payload) || !Array.isArray(payload.items)) {
		return invalidSection();
	}
	if (payload.items.length > MAX_APPS) {
		return invalidSection();
	}
	// A changed envelope or any pagination hint means the list is not known to
	// be complete; the first page is never assumed complete.
	if (Object.keys(payload).some((key) => !APP_ENVELOPE_KEYS.has(key))) {
		return invalidSection();
	}
	if (payload.has_more !== undefined && payload.has_more !== false) {
		return invalidSection();
	}
	if (
		payload.next_cursor !== undefined &&
		payload.next_cursor !== null &&
		payload.next_cursor !== ""
	) {
		return invalidSection();
	}

	const items = payload.items;
	for (const item of items) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id === "") {
			return invalidSection();
		}
	}

	// Matching is by registration ID only: never by app name and never by
	// taking the first entry.
	const matches = items.filter(
		(item) => isRecord(item) && item.id === registrationID,
	);
	if (matches.length !== 1) {
		return { ok: false, reason: "app_registration_mismatch" };
	}
	const app = matches[0];
	if (app === undefined || !isRecord(app)) {
		return invalidSection();
	}

	const rawWindows = app.windows;
	if (
		!Array.isArray(rawWindows) ||
		rawWindows.length === 0 ||
		rawWindows.length > MAX_WINDOWS
	) {
		return invalidSection();
	}
	const metrics: QuotaMetric[] = [];
	for (const [index, rawWindow] of rawWindows.entries()) {
		const parsed = parseWindow(
			rawWindow,
			`openai-app-window-${index}`,
			"app",
			"Current app limit",
		);
		if ("invalid" in parsed) {
			return invalidSection();
		}
		metrics.push(parsed.metric);
	}

	// The configured app cap is a separate declaration, never remaining quota.
	let configuredAppCapPercent: number | undefined;
	if (app.allowed_usage_percent !== undefined) {
		configuredAppCapPercent = percent(app.allowed_usage_percent);
		if (configuredAppCapPercent === undefined) {
			return invalidSection();
		}
	}

	return {
		ok: true,
		section: {
			scope: "app",
			result: {
				state: "available",
				metrics,
				fetchedAt,
				expiresAt: sectionExpiry(fetchedAt, metrics, companion),
				...(configuredAppCapPercent === undefined
					? {}
					: { configuredAppCapPercent }),
			},
		},
	};
}

function parsePlanSection(
	payload: unknown,
	fetchedAt: number,
	companion: CodexCompanion,
): SectionParse {
	if (!isRecord(payload) || !isRecord(payload.rate_limit)) {
		return invalidSection();
	}
	const rateLimit = payload.rate_limit;
	const candidates = [
		["primary", "Shared plan primary limit", rateLimit.primary_window],
		["secondary", "Shared plan secondary limit", rateLimit.secondary_window],
	] as const;

	const metrics: QuotaMetric[] = [];
	for (const [position, label, rawWindow] of candidates) {
		// A null window is absent. Model-specific additional limits elsewhere in
		// the payload are never reinterpreted as the shared plan.
		if (rawWindow === undefined || rawWindow === null) {
			continue;
		}
		const parsed = parseWindow(
			rawWindow,
			`openai-plan-${position}`,
			"shared-plan",
			label,
		);
		if ("invalid" in parsed) {
			return invalidSection();
		}
		metrics.push(parsed.metric);
	}
	if (metrics.length === 0) {
		return invalidSection();
	}

	return {
		ok: true,
		section: {
			scope: "shared-plan",
			result: {
				state: "available",
				metrics,
				fetchedAt,
				expiresAt: sectionExpiry(fetchedAt, metrics, companion),
			},
		},
	};
}

type Failure = {
	state: UnavailableState;
	reason: QuotaReason;
	retryAfterMs?: number;
};

/**
 * 401/403 responses have no dedicated transport reason, so they are mapped
 * here. Expiry is only blamed when the cached companion credential is at or
 * near `exp`; otherwise the companion is treated as rejected. No refresh is
 * attempted under any circumstances.
 */
function failureFromError(
	error: unknown,
	now: number,
	companion: CodexCompanion,
): Failure {
	if (error instanceof QuotaRequestError) {
		if (error.status === 401 || error.status === 403) {
			return {
				state: "auth-required",
				reason:
					companion.expiresAt - now <= NEAR_EXPIRY_MS
						? "companion_expired"
						: "invalid_response",
			};
		}
		const reason = TRANSPORT_REASONS.has(error.reason)
			? error.reason
			: "invalid_response";
		return {
			state: "unavailable",
			reason,
			...(error.retryAfterMs === undefined
				? {}
				: { retryAfterMs: error.retryAfterMs }),
		};
	}
	return { state: "unavailable", reason: "invalid_response" };
}

function unavailableSection(
	scope: "shared-plan",
	failure: Failure,
	attemptedAt: number,
): { scope: "shared-plan"; result: SectionResult } {
	return {
		scope,
		result: {
			state: failure.state,
			reason: failure.reason,
			attemptedAt,
			...(failure.retryAfterMs === undefined
				? {}
				: { retryAfterMs: failure.retryAfterMs }),
		},
	};
}

function unavailableRead(failure: Failure, attemptedAt: number): QuotaRead {
	return {
		state: failure.state,
		reason: failure.reason,
		attemptedAt,
		...(failure.retryAfterMs === undefined
			? {}
			: { retryAfterMs: failure.retryAfterMs }),
	};
}

function companionHeaders(companion: CodexCompanion): Record<string, string> {
	return {
		Authorization: `Bearer ${companion.accessToken}`,
		"ChatGPT-Account-Id": companion.accountID,
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
}

/**
 * Retrieval protocol: match the native app first, and only then read the
 * shared plan. Both GETs use the companion bearer exclusively; the native
 * token-sharing bearer never reaches chatgpt.com.
 */
export async function fetchOpenAICompanionQuota(
	registration: NativeRegistration,
	companion: CodexCompanion,
	signal: AbortSignal,
	deps: ProviderDeps,
): Promise<QuotaRead> {
	const headers = companionHeaders(companion);

	const appAttemptedAt = deps.now();
	let appPayload: unknown;
	try {
		appPayload = await deps.getJson(OPENAI_COMPANION_APPS_URL, headers, signal);
	} catch (error) {
		return unavailableRead(
			failureFromError(error, deps.now(), companion),
			appAttemptedAt,
		);
	}

	const app = parseAppSection(
		appPayload,
		registration.clientID,
		appAttemptedAt,
		companion,
	);
	if (!app.ok) {
		return {
			state: "unavailable",
			reason: app.reason,
			attemptedAt: appAttemptedAt,
		};
	}

	const planAttemptedAt = deps.now();
	let planPayload: unknown;
	try {
		planPayload = await deps.getJson(
			OPENAI_COMPANION_PLAN_URL,
			headers,
			signal,
		);
	} catch (error) {
		return {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				app.section,
				unavailableSection(
					"shared-plan",
					failureFromError(error, deps.now(), companion),
					planAttemptedAt,
				),
			],
		};
	}

	const plan = parsePlanSection(planPayload, planAttemptedAt, companion);
	if (!plan.ok) {
		return {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				app.section,
				unavailableSection(
					"shared-plan",
					{ state: "unavailable", reason: plan.reason },
					planAttemptedAt,
				),
			],
		};
	}

	return {
		state: "available",
		authSource: "codex-companion",
		sections: [app.section, plan.section],
	};
}

type Identity = {
	registration?: NativeRegistration;
	companion?: CodexCompanion;
	reason?: QuotaReason;
	/** Set when the host bridge itself failed; currentness is unprovable. */
	hostFailure?: boolean;
};

function companionFailureReason(reason: string): QuotaReason {
	return COMPANION_REASONS.has(reason)
		? (reason as QuotaReason)
		: "invalid_companion";
}

function registrationFailureReason(reason: string): QuotaReason {
	return NATIVE_REASONS.has(reason)
		? (reason as QuotaReason)
		: "invalid_native_registration";
}

/**
 * Both sources are reread for every resolve/read/isCurrent call so Codex's own
 * renewal or an account change is observed without copying credentials into
 * plugin storage.
 */
async function readIdentity(
	input: AdapterResolveInput,
	readCompanion: (
		options: CompanionOptions,
		deps: CredentialReadDeps,
	) => Promise<CompanionRead>,
): Promise<Identity> {
	const companion = await readCompanion(input.companion, input.credentialDeps);
	if (companion.state !== "available") {
		return { reason: companionFailureReason(companion.reason) };
	}
	// Defense in depth: the reader already rejects an expired cache, but no
	// registration or network work happens for an unusable companion token.
	if (companion.credential.expiresAt <= input.deps.now()) {
		return { reason: "companion_expired" };
	}

	const registration = await loadNativeRegistration(input);
	if ("state" in registration) {
		const reason = registrationFailureReason(registration.reason);
		return {
			companion: companion.credential,
			reason,
			...(reason === "invalid_response" ? { hostFailure: true } : {}),
		};
	}

	return { registration, companion: companion.credential };
}

/**
 * Unresolved state still carries the observed companion fingerprint: the
 * coordinator must see a companion identity change even before a registration
 * resolves (ledger Task 7 minor #2).
 */
function identityKeyFor(identity: Identity): string {
	const resolved =
		identity.registration !== undefined && identity.companion !== undefined;
	const basis = resolved
		? `${identity.registration?.connectionKey ?? ""}\u0000${identity.companion?.identityKey ?? ""}`
		: `unresolved\u0000${identity.reason ?? "invalid_native_registration"}\u0000${identity.companion?.identityKey ?? ""}`;
	return createHash("sha256")
		.update(`openai-companion\u0000${basis}`)
		.digest("hex");
}

function sameIdentity(left: Identity, right: Identity): boolean {
	return (
		left.registration?.connectionKey === right.registration?.connectionKey &&
		left.companion?.identityKey === right.companion?.identityKey &&
		left.reason === right.reason
	);
}

async function readQuota(
	input: AdapterResolveInput,
	readCompanion: (
		options: CompanionOptions,
		deps: CredentialReadDeps,
	) => Promise<CompanionRead>,
	signal: AbortSignal,
): Promise<QuotaRead> {
	const attemptedAt = input.deps.now();
	const identity = await readIdentity(input, readCompanion);

	if (identity.registration === undefined || identity.companion === undefined) {
		const reason = identity.reason ?? "invalid_native_registration";
		return {
			state: reason === "companion_expired" ? "auth-required" : "unavailable",
			reason,
			attemptedAt,
		};
	}
	if (identity.companion.expiresAt <= attemptedAt) {
		return {
			state: "auth-required",
			reason: "companion_expired",
			attemptedAt,
		};
	}

	return fetchOpenAICompanionQuota(
		identity.registration,
		identity.companion,
		signal,
		input.deps,
	);
}

export function createOpenAICompanionAdapter(input: {
	readCompanion(
		options: CompanionOptions,
		deps: CredentialReadDeps,
	): Promise<CompanionRead>;
}): ProviderAdapter {
	return {
		id: "openai-companion",
		capabilities: [...CAPABILITIES],
		async resolve(
			adapterInput: AdapterResolveInput,
		): Promise<ResolvedQuotaSource | null> {
			if (adapterInput.integrationID !== OPENAI_INTEGRATION_ID) {
				return null;
			}
			// Key/env sign-ins stay declared as unsupported and make no requests.
			if (adapterInput.authMethod !== "oauth") {
				return null;
			}

			const identity = await readIdentity(adapterInput, input.readCompanion);

			return {
				identityKey: identityKeyFor(identity),
				read: (signal) => readQuota(adapterInput, input.readCompanion, signal),
				isCurrent: async () => {
					if (identity.hostFailure === true) {
						return false;
					}
					return sameIdentity(
						identity,
						await readIdentity(adapterInput, input.readCompanion),
					);
				},
			};
		},
	};
}

export type QuotaScope = "provider-balance" | "shared-plan" | "app";
export type UnavailableState =
	| "unsupported"
	| "not-applicable"
	| "auth-required"
	| "unavailable";

export type QuotaMetric =
	| {
			kind: "window";
			id: string;
			scope: QuotaScope;
			label: string;
			windowSeconds: number;
			usedPercent?: number;
			remainingPercent?: number;
			resetsAt?: number;
	  }
	| {
			kind: "money";
			id: string;
			scope: "provider-balance";
			label: string;
			currency: "USD";
			remaining: number;
			allowance?: number;
			used?: number;
			resetsAt?: number;
	  };

export type SectionResult =
	| {
			state: "available";
			metrics: QuotaMetric[];
			fetchedAt: number;
			expiresAt: number;
			configuredAppCapPercent?: number;
	  }
	| {
			state: UnavailableState;
			reason: string;
			attemptedAt: number;
			retryAfterMs?: number;
	  };

export type QuotaRead =
	| {
			state: "available" | "partial";
			authSource: "opencode" | "codex-companion";
			sections: { scope: QuotaScope; result: SectionResult }[];
	  }
	| {
			state: UnavailableState;
			reason: string;
			attemptedAt: number;
			retryAfterMs?: number;
	  };

/** A readable result that carries sections; currentness applies to this shape. */
export type QuotaSectionsRead = Extract<
	QuotaRead,
	{ state: "available" | "partial" }
>;

/**
 * Identity-safe historical presentation. `revision` changes only when the
 * coordinator commits an observation or invalidates an identity; reads and
 * clock ticks never move it. `lastKnown` is always a complete, fully available
 * observation and is never a claim that those figures are current.
 */
export type QuotaPresentation = {
	revision: number;
	lastKnown?: QuotaSectionsRead;
	failedSince?: number;
};

// Native time values below are epoch milliseconds; provider reset epochs are
// converted from seconds exactly once at the adapter boundary.
export type CodexCompanion = {
	accessToken: string;
	accountID: string;
	expiresAt: number;
	identityKey: string;
};
export type NativeRegistration = { clientID: string; connectionKey: string };

export type ProviderSummary = {
	providerID: string;
	name: string;
	integrationID?: string;
	authMethod: string;
	support:
		| "supported"
		| "unsupported"
		| "not-applicable"
		| "requires-companion";
	evidence: "live-validated" | "documented-only" | "unverified";
};

export type ProviderDeps = {
	now(): number;
	getJson(
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<unknown>;
};

export type CompanionOptions = { enabled: boolean; home?: string };

export type CredentialReadDeps = {
	now(): number;
	env: Record<string, string | undefined>;
	homeDirectory: string;
	readUtf8(path: string, maxBytes: number): Promise<string>;
};

export type CompanionRead =
	| { state: "available"; credential: CodexCompanion }
	| { state: "unavailable"; reason: string };

export type RegistrationFailure = { state: "unavailable"; reason: string };

export type ResolvedQuotaSource = {
	identityKey: string;
	read(signal: AbortSignal): Promise<QuotaRead>;
	isCurrent(): Promise<boolean>;
};

export type CoordinatorDeps = {
	now(): number;
	resolve(
		providerID: string,
		signal: AbortSignal,
	): Promise<ResolvedQuotaSource>;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
};

export type QuotaCoordinator = {
	watch(providerID: string, listener: (value: QuotaRead) => void): () => void;
	read(providerID: string): QuotaRead;
	refresh(providerID: string): Promise<QuotaRead>;
	/** Complete history plus mutation revision; independent of currentness. */
	presentation(providerID: string): QuotaPresentation;
	/** True only while a retryable failure episode is active. */
	isRecovering(providerID: string): boolean;
	invalidate(identityKey: string): void;
	dispose(): void;
};

export type LocaleContext = { locale: string; timeZone: string };

export type DisplayRow = {
	id: string;
	label: string;
	value: string;
	detail?: string;
	scope?: QuotaScope;
	tone: "normal" | "warning" | "error";
};

export type ProviderCapability = {
	match: { providerID?: string; integrationID?: string; authMethod: string };
	name: string;
	support: ProviderSummary["support"];
	evidence: ProviderSummary["evidence"];
};

/**
 * Server-private bridge to the host's supported credential APIs. Implementations
 * call the host, then serialize the ACTIVE connection's credential into the
 * auth.json-entry shape the adapter parsers already accept; adapters treat the
 * result as `unknown`. Never RPC output and never logged.
 */
export type NativeCredentialSource = {
	/** Return the ACTIVE connection's credential value, or `undefined` when the integration has no active connection. */
	resolve(integrationID: string): Promise<unknown | undefined>;
};

export type AdapterResolveInput = {
	providerID: string;
	integrationID?: string;
	authMethod: string;
	companion: CompanionOptions;
	deps: ProviderDeps;
	credentialDeps: CredentialReadDeps;
	signal: AbortSignal;
	/** Host-backed credential source; the file idiom stays the fallback. */
	nativeCredential?: NativeCredentialSource;
};

export type ProviderAdapter = {
	id: string;
	capabilities: ProviderCapability[];
	/** Decline with null (another adapter may claim the provider). First non-null wins. */
	resolve(input: AdapterResolveInput): Promise<ResolvedQuotaSource | null>;
};

export const QUOTA_REASON_CODES = [
	"companion_disabled",
	"companion_missing",
	"companion_expired",
	"unsupported_companion_storage",
	"invalid_companion",
	"app_registration_mismatch",
	"invalid_native_registration",
	"invalid_response",
	"rate_limited",
	"timeout",
	"network_error",
	"unsupported_auth_method",
	"no_validated_quota_source",
] as const;

export type QuotaReason = (typeof QUOTA_REASON_CODES)[number];

export class QuotaRequestError extends Error {
	readonly reason: QuotaReason;
	readonly status: number | undefined;
	readonly retryAfterMs: number | undefined;

	constructor(
		reason: QuotaReason,
		options: { status?: number; retryAfterMs?: number } = {},
	) {
		super(reason);
		this.name = "QuotaRequestError";
		this.reason = reason;
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
	}
}

const QUOTA_SCOPES: readonly QuotaScope[] = [
	"provider-balance",
	"shared-plan",
	"app",
];
const UNAVAILABLE_STATES: readonly UnavailableState[] = [
	"unsupported",
	"not-applicable",
	"auth-required",
	"unavailable",
];
const REASON_CODES: ReadonlySet<string> = new Set(QUOTA_REASON_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isQuotaScope(value: unknown): value is QuotaScope {
	return (
		typeof value === "string" &&
		(QUOTA_SCOPES as readonly string[]).includes(value)
	);
}

function isUnavailableState(value: unknown): value is UnavailableState {
	return (
		typeof value === "string" &&
		(UNAVAILABLE_STATES as readonly string[]).includes(value)
	);
}

function isReason(value: unknown): value is QuotaReason {
	return typeof value === "string" && REASON_CODES.has(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(
	value: unknown,
): value is number | undefined {
	return value === undefined || isNonNegativeNumber(value);
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isQuotaMetric(value: unknown): value is QuotaMetric {
	if (!isRecord(value)) {
		return false;
	}

	if (value.kind === "window") {
		return (
			hasOnlyKeys(value, [
				"kind",
				"id",
				"scope",
				"label",
				"windowSeconds",
				"usedPercent",
				"remainingPercent",
				"resetsAt",
			]) &&
			typeof value.id === "string" &&
			isQuotaScope(value.scope) &&
			typeof value.label === "string" &&
			isPositiveNumber(value.windowSeconds) &&
			isOptionalNonNegativeNumber(value.usedPercent) &&
			isOptionalNonNegativeNumber(value.remainingPercent) &&
			isOptionalNonNegativeNumber(value.resetsAt)
		);
	}

	if (value.kind === "money") {
		return (
			hasOnlyKeys(value, [
				"kind",
				"id",
				"scope",
				"label",
				"currency",
				"remaining",
				"allowance",
				"used",
				"resetsAt",
			]) &&
			typeof value.id === "string" &&
			value.scope === "provider-balance" &&
			typeof value.label === "string" &&
			value.currency === "USD" &&
			isNonNegativeNumber(value.remaining) &&
			isOptionalNonNegativeNumber(value.allowance) &&
			isOptionalNonNegativeNumber(value.used) &&
			isOptionalNonNegativeNumber(value.resetsAt)
		);
	}

	return false;
}

function isSectionResult(value: unknown): value is SectionResult {
	if (!isRecord(value)) {
		return false;
	}

	if (value.state === "available") {
		return (
			hasOnlyKeys(value, [
				"state",
				"metrics",
				"fetchedAt",
				"expiresAt",
				"configuredAppCapPercent",
			]) &&
			Array.isArray(value.metrics) &&
			value.metrics.every(isQuotaMetric) &&
			isNonNegativeNumber(value.fetchedAt) &&
			isNonNegativeNumber(value.expiresAt) &&
			isOptionalNonNegativeNumber(value.configuredAppCapPercent)
		);
	}

	if (isUnavailableState(value.state)) {
		return (
			hasOnlyKeys(value, ["state", "reason", "attemptedAt", "retryAfterMs"]) &&
			isReason(value.reason) &&
			isNonNegativeNumber(value.attemptedAt) &&
			isOptionalNonNegativeNumber(value.retryAfterMs)
		);
	}

	return false;
}

function isQuotaSection(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["scope", "result"]) &&
		isQuotaScope(value.scope) &&
		isSectionResult(value.result)
	);
}

function isQuotaReadValue(value: unknown): value is QuotaRead {
	if (!isRecord(value)) {
		return false;
	}

	if (value.state === "available" || value.state === "partial") {
		return (
			hasOnlyKeys(value, ["state", "authSource", "sections"]) &&
			(value.authSource === "opencode" ||
				value.authSource === "codex-companion") &&
			Array.isArray(value.sections) &&
			value.sections.every(isQuotaSection)
		);
	}

	if (isUnavailableState(value.state)) {
		return (
			hasOnlyKeys(value, ["state", "reason", "attemptedAt", "retryAfterMs"]) &&
			isReason(value.reason) &&
			isNonNegativeNumber(value.attemptedAt) &&
			isOptionalNonNegativeNumber(value.retryAfterMs)
		);
	}

	return false;
}

/**
 * Validates a public quota result. Unknown fields are rejected at every level so
 * credential material cannot cross the public boundary.
 */
export function isQuotaRead(value: unknown): value is QuotaRead {
	try {
		return isQuotaReadValue(value);
	} catch {
		return false;
	}
}

/**
 * Validates the public presentation envelope. A historical result is accepted
 * only when it is a complete available observation: partial, unavailable, or
 * mixed-section history would claim a coherence that was never observed.
 */
export function isQuotaPresentation(
	value: unknown,
): value is QuotaPresentation {
	try {
		if (!isRecord(value)) {
			return false;
		}
		if (!hasOnlyKeys(value, ["revision", "lastKnown", "failedSince"])) {
			return false;
		}
		if (
			typeof value.revision !== "number" ||
			!Number.isSafeInteger(value.revision) ||
			value.revision < 0
		) {
			return false;
		}
		if (!isOptionalNonNegativeNumber(value.failedSince)) {
			return false;
		}

		const lastKnown = value.lastKnown;
		if (lastKnown === undefined) {
			return true;
		}
		if (!isQuotaReadValue(lastKnown) || lastKnown.state !== "available") {
			return false;
		}
		return lastKnown.sections.every(
			(section) => section.result.state === "available",
		);
	} catch {
		return false;
	}
}

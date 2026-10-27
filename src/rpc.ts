import { Rpc } from "@opencode/plugin";
import type { ClaudeUsage } from "./claude-code/usage";
import {
	isQuotaPresentation,
	isQuotaRead,
	type ProviderSummary,
	QUOTA_REASON_CODES,
	type QuotaPresentation,
	type QuotaRead,
} from "./core/contracts";
import type { AdapterRegistry } from "./core/registry";

export const QUOTA_RPC_ID = "provider-usage";
export const QUOTA_PLUGIN_ID = QUOTA_RPC_ID;
/**
 * Version 2 adds the optional presentation envelope. The wire contract is
 * versioned, not dual-implemented: a client accepts only this exact version.
 */
export const QUOTA_RPC_VERSION = 2;

const supportValues = [
	"supported",
	"unsupported",
	"not-applicable",
	"requires-companion",
] as const;
const evidenceValues = [
	"live-validated",
	"documented-only",
	"unverified",
] as const;
const scopeValues = ["provider-balance", "shared-plan", "app"] as const;
const unavailableStateValues = [
	"unsupported",
	"not-applicable",
	"auth-required",
	"unavailable",
] as const;

const providerSummarySchema = {
	type: "object",
	properties: {
		providerID: { type: "string" },
		name: { type: "string" },
		integrationID: { type: "string" },
		authMethod: { type: "string" },
		support: { type: "string", enum: supportValues },
		evidence: { type: "string", enum: evidenceValues },
	},
	required: ["providerID", "name", "authMethod", "support", "evidence"],
	additionalProperties: false,
} as const;

const windowMetricSchema = {
	type: "object",
	properties: {
		kind: { type: "string", const: "window" },
		id: { type: "string" },
		scope: { type: "string", enum: scopeValues },
		label: { type: "string" },
		windowSeconds: { type: "number" },
		usedPercent: { type: "number" },
		remainingPercent: { type: "number" },
		resetsAt: { type: "number" },
	},
	required: ["kind", "id", "scope", "label", "windowSeconds"],
	additionalProperties: false,
} as const;

const moneyMetricSchema = {
	type: "object",
	properties: {
		kind: { type: "string", const: "money" },
		id: { type: "string" },
		scope: { type: "string", const: "provider-balance" },
		label: { type: "string" },
		currency: { type: "string", const: "USD" },
		remaining: { type: "number" },
		allowance: { type: "number" },
		used: { type: "number" },
		resetsAt: { type: "number" },
	},
	required: ["kind", "id", "scope", "label", "currency", "remaining"],
	additionalProperties: false,
} as const;

const availableSectionResultSchema = {
	type: "object",
	properties: {
		state: { type: "string", const: "available" },
		metrics: {
			type: "array",
			items: { oneOf: [windowMetricSchema, moneyMetricSchema] },
		},
		fetchedAt: { type: "number" },
		expiresAt: { type: "number" },
		configuredAppCapPercent: { type: "number" },
	},
	required: ["state", "metrics", "fetchedAt", "expiresAt"],
	additionalProperties: false,
} as const;

const unavailableResultSchema = {
	type: "object",
	properties: {
		state: { type: "string", enum: unavailableStateValues },
		reason: { type: "string", enum: [...QUOTA_REASON_CODES] },
		attemptedAt: { type: "number" },
		retryAfterMs: { type: "number" },
	},
	required: ["state", "reason", "attemptedAt"],
	additionalProperties: false,
} as const;

const sectionResultSchema = {
	oneOf: [availableSectionResultSchema, unavailableResultSchema],
} as const;

const quotaReadSchema = {
	oneOf: [
		{
			type: "object",
			properties: {
				state: { type: "string", enum: ["available", "partial"] },
				authSource: { type: "string", enum: ["opencode", "codex-companion"] },
				sections: {
					type: "array",
					items: {
						type: "object",
						properties: {
							scope: { type: "string", enum: scopeValues },
							result: sectionResultSchema,
						},
						required: ["scope", "result"],
						additionalProperties: false,
					},
				},
			},
			required: ["state", "authSource", "sections"],
			additionalProperties: false,
		},
		unavailableResultSchema,
	],
} as const;

/**
 * Historical figures must be one coherent, fully available observation.
 * Partial or unavailable history would claim a state that was never observed.
 */
const completeQuotaReadSchema = {
	type: "object",
	properties: {
		state: { type: "string", const: "available" },
		authSource: { type: "string", enum: ["opencode", "codex-companion"] },
		sections: {
			type: "array",
			items: {
				type: "object",
				properties: {
					scope: { type: "string", enum: scopeValues },
					result: availableSectionResultSchema,
				},
				required: ["scope", "result"],
				additionalProperties: false,
			},
		},
	},
	required: ["state", "authSource", "sections"],
	additionalProperties: false,
} as const;

const presentationSchema = {
	type: "object",
	properties: {
		revision: { type: "integer", minimum: 0 },
		lastKnown: completeQuotaReadSchema,
		failedSince: { type: "number", minimum: 0 },
	},
	required: ["revision"],
	additionalProperties: false,
} as const;

const providerViewSchema = {
	type: "object",
	properties: {
		provider: providerSummarySchema,
		quota: quotaReadSchema,
		presentation: presentationSchema,
	},
	required: ["provider", "quota"],
	additionalProperties: false,
} as const;

const providerInputSchema = {
	type: "object",
	properties: {
		providerID: { type: "string" },
	},
	required: ["providerID"],
	additionalProperties: false,
} as const;

const emptyInputSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const versionSchema = { type: "number", const: QUOTA_RPC_VERSION } as const;

const claudeUsageWindowSchema = {
	type: "object",
	properties: {
		usedPercent: { type: "number", minimum: 0, maximum: 100 },
		resetsAt: {
			type: "integer",
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		},
	},
	required: ["usedPercent", "resetsAt"],
	additionalProperties: false,
} as const;

/**
 * Page-only quota data from the local Claude Code CLI. It is deliberately not
 * a provider view: no credentials, terminal output, or provider identity
 * crosses this boundary.
 */
const claudeUsageSchema = {
	type: "object",
	properties: {
		session: claudeUsageWindowSchema,
		week: claudeUsageWindowSchema,
	},
	required: ["session", "week"],
	additionalProperties: false,
} as const;

const claudeUsageOutputSchema = {
	oneOf: [claudeUsageSchema, { type: "null" }],
} as const;

const invalidInputSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
	},
	required: ["message"],
	additionalProperties: false,
} as const;

const listOutputSchema = {
	type: "object",
	properties: {
		version: versionSchema,
		providers: {
			type: "array",
			items: providerViewSchema,
		},
	},
	required: ["version", "providers"],
	additionalProperties: false,
} as const;

const getOutputSchema = {
	type: "object",
	properties: {
		version: versionSchema,
		provider: providerSummarySchema,
		quota: quotaReadSchema,
		presentation: presentationSchema,
	},
	required: ["version", "provider", "quota"],
	additionalProperties: false,
} as const;

const updatedEventSchema = {
	type: "object",
	properties: {
		version: versionSchema,
		providerID: { type: "string" },
		quota: quotaReadSchema,
		presentation: presentationSchema,
	},
	required: ["version", "providerID", "quota"],
	additionalProperties: false,
} as const;

/**
 * Versioned plugin RPC. Inputs deliberately carry only a provider ID: the TUI
 * can never supply a credential value or credential path. All outputs are
 * provider/auth/support descriptors plus sanitized quota reads.
 */
export const QuotaRpc = Rpc.define({
	id: QUOTA_RPC_ID,
	methods: {
		list: {
			input: emptyInputSchema,
			output: listOutputSchema,
			errors: { invalid_input: invalidInputSchema },
		},
		get: {
			input: providerInputSchema,
			output: getOutputSchema,
			errors: { invalid_input: invalidInputSchema },
		},
		refresh: {
			input: providerInputSchema,
			output: getOutputSchema,
			errors: { invalid_input: invalidInputSchema },
		},
		/**
		 * Page-only collection from the local Claude Code CLI. Failure is a
		 * null result, never an error or an omission of other providers.
		 *
		 * The method is additive and unversioned, so v2 servers predating it
		 * answer `rpc.method_not_found`; clients must treat that as "no Claude
		 * data" and keep the rest of the page usable.
		 */
		claudeCodeUsage: {
			input: emptyInputSchema,
			output: claudeUsageOutputSchema,
			errors: { invalid_input: invalidInputSchema },
		},
	},
	events: {
		updated: { schema: updatedEventSchema },
	},
});

export type QuotaProviderRef = {
	providerID: string;
	integrationID?: string;
	authMethod: string;
};

export type QuotaProviderView = {
	provider: ProviderSummary;
	quota: QuotaRead;
	presentation?: QuotaPresentation;
};

export type QuotaListResult = {
	version: number;
	providers: QuotaProviderView[];
};

export type QuotaGetResult = {
	version: number;
	provider: ProviderSummary;
	quota: QuotaRead;
	presentation?: QuotaPresentation;
};

export type QuotaUpdatedEvent = {
	version: number;
	providerID: string;
	quota: QuotaRead;
	presentation?: QuotaPresentation;
};

export type QuotaReadRequest = QuotaProviderRef & { signal: AbortSignal };

export type QuotaRpcSource = {
	registry: AdapterRegistry;
	providers(): Promise<QuotaProviderRef[]>;
	read(input: QuotaReadRequest): Promise<QuotaRead>;
	/** Complete, server-derived history; never a client claim of currentness. */
	presentation(providerID: string): QuotaPresentation;
	/** Atomically capture current quota and its revision after a shared read.
	 * Coordinator-backed sources must provide this to avoid identity-switch races.
	 * Simple v2 custom sources may omit it and use their immutable read result. */
	snapshot?(providerID: string): {
		quota: QuotaRead;
		presentation: QuotaPresentation;
	};
	now(): number;
};

export type QuotaRpcOptions = {
	source: QuotaRpcSource;
	publish?(event: QuotaUpdatedEvent): Promise<void> | void;
	/**
	 * Page-only Claude Code collection. Optional so existing custom sources and
	 * tests keep their contract; a missing collector means "no data".
	 */
	claudeUsage?(signal: AbortSignal): Promise<ClaudeUsage | null>;
};

type QuotaMethods = typeof QuotaRpc.methods;
type QuotaMethodName = keyof QuotaMethods;
type MethodFor<Name extends QuotaMethodName> = QuotaMethods[Name];

export type QuotaRpcHandlers = {
	[Name in QuotaMethodName]: (
		input: Rpc.Output<MethodFor<Name>["input"]>,
		context: {
			readonly signal: AbortSignal;
			readonly error: Rpc.ErrorFactory<MethodFor<Name>>;
		},
	) => Promise<
		| Rpc.HandlerOutput<MethodFor<Name>["output"]>
		| Rpc.HandlerError<MethodFor<Name>>
	>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isProviderSummary(value: unknown): value is ProviderSummary {
	if (!isRecord(value)) {
		return false;
	}
	return (
		hasOnlyKeys(value, [
			"providerID",
			"name",
			"integrationID",
			"authMethod",
			"support",
			"evidence",
		]) &&
		typeof value.providerID === "string" &&
		typeof value.name === "string" &&
		(value.integrationID === undefined ||
			typeof value.integrationID === "string") &&
		typeof value.authMethod === "string" &&
		typeof value.support === "string" &&
		(supportValues as readonly string[]).includes(value.support) &&
		typeof value.evidence === "string" &&
		(evidenceValues as readonly string[]).includes(value.evidence)
	);
}

export function isQuotaProviderView(
	value: unknown,
): value is QuotaProviderView {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["provider", "quota", "presentation"]) &&
		isProviderSummary(value.provider) &&
		isQuotaRead(value.quota) &&
		(value.presentation === undefined ||
			isQuotaPresentation(value.presentation))
	);
}

export function isQuotaListResult(value: unknown): value is QuotaListResult {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["version", "providers"]) &&
		value.version === QUOTA_RPC_VERSION &&
		Array.isArray(value.providers) &&
		value.providers.every(isQuotaProviderView)
	);
}

export function isQuotaGetResult(value: unknown): value is QuotaGetResult {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["version", "provider", "quota", "presentation"]) &&
		value.version === QUOTA_RPC_VERSION &&
		isProviderSummary(value.provider) &&
		isQuotaRead(value.quota) &&
		(value.presentation === undefined ||
			isQuotaPresentation(value.presentation))
	);
}

export function isQuotaUpdatedEvent(
	value: unknown,
): value is QuotaUpdatedEvent {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["version", "providerID", "quota", "presentation"]) &&
		value.version === QUOTA_RPC_VERSION &&
		typeof value.providerID === "string" &&
		value.providerID.length > 0 &&
		isQuotaRead(value.quota) &&
		(value.presentation === undefined ||
			isQuotaPresentation(value.presentation))
	);
}

function isClaudeUsageWindow(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["usedPercent", "resetsAt"]) &&
		typeof value.usedPercent === "number" &&
		Number.isFinite(value.usedPercent) &&
		value.usedPercent >= 0 &&
		value.usedPercent <= 100 &&
		typeof value.resetsAt === "number" &&
		Number.isSafeInteger(value.resetsAt) &&
		value.resetsAt >= 1
	);
}

/**
 * Validates page-only Claude usage: exactly two windows of finite 0-100
 * percentages and positive safe-integer epoch-millisecond reset instants,
 * matching the wire schema. Unknown fields are rejected so raw or
 * credential-shaped data can never cross the boundary.
 */
export function isClaudeUsage(value: unknown): value is ClaudeUsage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["session", "week"]) &&
		isClaudeUsageWindow(value.session) &&
		isClaudeUsageWindow(value.week)
	);
}

type ParsedProviderInput =
	| { ok: true; providerID: string }
	| { ok: false; message: string };

function parseProviderInput(value: unknown): ParsedProviderInput {
	if (!isRecord(value)) {
		return { ok: false, message: "input must be an object" };
	}
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "providerID") {
		return {
			ok: false,
			message: "input accepts exactly one field: providerID",
		};
	}
	const providerID = value.providerID;
	if (typeof providerID !== "string" || providerID.length === 0) {
		return { ok: false, message: "providerID must be a non-empty string" };
	}
	return { ok: true, providerID };
}

type ParsedEmptyInput = { ok: true } | { ok: false; message: string };

function parseEmptyInput(value: unknown): ParsedEmptyInput {
	if (value === undefined || value === null) {
		return { ok: true };
	}
	if (!isRecord(value)) {
		return { ok: false, message: "input must be an object" };
	}
	if (Object.keys(value).length > 0) {
		return { ok: false, message: "input accepts no fields" };
	}
	return { ok: true };
}

function invalidResponseRead(now: number): QuotaRead {
	return { state: "unavailable", reason: "invalid_response", attemptedAt: now };
}

/**
 * Presentation is auxiliary metadata. A custom or buggy source that returns
 * malformed history, unknown fields, or nonfinite timing loses only the
 * metadata; the validated quota read still crosses the boundary.
 */
function safePresentation(
	source: QuotaRpcSource,
	providerID: string,
): QuotaPresentation | undefined {
	try {
		const value = source.presentation(providerID);
		return isQuotaPresentation(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function safeRead(
	source: QuotaRpcSource,
	input: QuotaReadRequest,
): Promise<QuotaRead> {
	try {
		const value = await source.read(input);
		return isQuotaRead(value) ? value : invalidResponseRead(source.now());
	} catch {
		return invalidResponseRead(source.now());
	}
}

async function providerView(
	source: QuotaRpcSource,
	ref: QuotaProviderRef,
	signal: AbortSignal,
): Promise<QuotaProviderView> {
	const provider = source.registry.summarize(ref);
	let quota = await safeRead(source, { ...ref, signal });
	let presentation: QuotaPresentation | undefined;
	if (source.snapshot !== undefined) {
		try {
			// No await between current quota and metadata. The read that settled
			// above may already belong to a discarded identity.
			const captured = source.snapshot(ref.providerID);
			quota = isQuotaRead(captured.quota)
				? captured.quota
				: invalidResponseRead(source.now());
			presentation = isQuotaPresentation(captured.presentation)
				? captured.presentation
				: undefined;
		} catch {
			quota = invalidResponseRead(source.now());
		}
	} else {
		presentation = safePresentation(source, ref.providerID);
	}
	return {
		provider,
		quota,
		...(presentation === undefined ? {} : { presentation }),
	};
}

async function findProvider(
	source: QuotaRpcSource,
	providerID: string,
): Promise<QuotaProviderRef> {
	const refs = await source.providers();
	return (
		refs.find((ref) => ref.providerID === providerID) ?? {
			providerID,
			authMethod: "none",
		}
	);
}

function publish(
	options: QuotaRpcOptions,
	event: QuotaUpdatedEvent,
): Promise<void> {
	return Promise.resolve(options.publish?.(event)).catch(() => undefined);
}

export function createQuotaRpcHandlers(
	options: QuotaRpcOptions,
): QuotaRpcHandlers {
	const { source } = options;

	return {
		async list(input, context) {
			const parsed = parseEmptyInput(input);
			if (!parsed.ok) {
				return context.error("invalid_input", parsed.message, {
					message: parsed.message,
				});
			}
			const refs = await source.providers();
			const providers = await Promise.all(
				refs.map((ref) => providerView(source, ref, context.signal)),
			);
			return { version: QUOTA_RPC_VERSION, providers };
		},

		async get(input, context) {
			const parsed = parseProviderInput(input);
			if (!parsed.ok) {
				return context.error("invalid_input", parsed.message, {
					message: parsed.message,
				});
			}
			const ref = await findProvider(source, parsed.providerID);
			const view = await providerView(source, ref, context.signal);
			return {
				version: QUOTA_RPC_VERSION,
				provider: view.provider,
				quota: view.quota,
				...(view.presentation === undefined
					? {}
					: { presentation: view.presentation }),
			};
		},

		async refresh(input, context) {
			const parsed = parseProviderInput(input);
			if (!parsed.ok) {
				return context.error("invalid_input", parsed.message, {
					message: parsed.message,
				});
			}
			const ref = await findProvider(source, parsed.providerID);
			const view = await providerView(source, ref, context.signal);
			await publish(options, {
				version: QUOTA_RPC_VERSION,
				providerID: ref.providerID,
				quota: view.quota,
				...(view.presentation === undefined
					? {}
					: { presentation: view.presentation }),
			});
			return {
				version: QUOTA_RPC_VERSION,
				provider: view.provider,
				quota: view.quota,
				...(view.presentation === undefined
					? {}
					: { presentation: view.presentation }),
			};
		},

		async claudeCodeUsage(input, context) {
			const parsed = parseEmptyInput(input);
			if (!parsed.ok) {
				return context.error("invalid_input", parsed.message, {
					message: parsed.message,
				});
			}
			const collect = options.claudeUsage;
			if (collect === undefined || context.signal.aborted) {
				return null;
			}
			try {
				const usage = await collect(context.signal);
				// A result that settles after cancellation belongs to a closed or
				// superseded page and must not be delivered.
				if (context.signal.aborted || !isClaudeUsage(usage)) {
					return null;
				}
				return usage;
			} catch {
				// Collection failure is an omission, never an RPC error that could
				// affect other providers.
				return null;
			}
		},
	};
}

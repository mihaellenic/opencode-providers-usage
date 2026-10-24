import type {
	AdapterResolveInput,
	CompanionOptions,
	CredentialReadDeps,
	NativeCredentialSource,
	ProviderAdapter,
	ProviderCapability,
	ProviderDeps,
	ProviderSummary,
	ResolvedQuotaSource,
} from "./contracts";

type SummarizeInput = {
	providerID: string;
	integrationID?: string;
	authMethod: string;
};

type ResolveInput = SummarizeInput & {
	companion: CompanionOptions;
	deps: ProviderDeps;
	credentialDeps: CredentialReadDeps;
	signal: AbortSignal;
	/** Optional so existing callers and tests keep the file-only behavior. */
	nativeCredential?: NativeCredentialSource;
};

export type AdapterRegistry = {
	adapters(): ProviderAdapter[];
	capabilities(): ProviderCapability[];
	summarize(input: SummarizeInput): ProviderSummary;
	resolve(input: ResolveInput): Promise<ResolvedQuotaSource | null>;
};

function capabilityMatches(
	match: ProviderCapability["match"],
	input: SummarizeInput,
): boolean {
	const providerMatches =
		match.providerID !== undefined && match.providerID === input.providerID;
	const integrationMatches =
		match.integrationID !== undefined &&
		match.integrationID === input.integrationID;
	const authMatches =
		match.authMethod === "any" || match.authMethod === input.authMethod;
	return (providerMatches || integrationMatches) && authMatches;
}

function summaryFromCapability(
	capability: ProviderCapability,
	input: SummarizeInput,
): ProviderSummary {
	return {
		providerID: input.providerID,
		...(input.integrationID !== undefined
			? { integrationID: input.integrationID }
			: {}),
		name: capability.name,
		authMethod: input.authMethod,
		support: capability.support,
		evidence: capability.evidence,
	};
}

function synthesizedSummary(input: SummarizeInput): ProviderSummary {
	return {
		providerID: input.providerID,
		...(input.integrationID !== undefined
			? { integrationID: input.integrationID }
			: {}),
		name: input.providerID,
		authMethod: input.authMethod,
		support: "unsupported",
		evidence: "unverified",
	};
}

export function createAdapterRegistry(
	adapters: ProviderAdapter[],
): AdapterRegistry {
	const registered = [...adapters];

	return {
		adapters() {
			return [...registered];
		},
		capabilities() {
			return registered.flatMap((adapter) => adapter.capabilities);
		},
		summarize(input) {
			const declared = registered
				.flatMap((adapter) => adapter.capabilities)
				.find((capability) => capabilityMatches(capability.match, input));
			return declared
				? summaryFromCapability(declared, input)
				: synthesizedSummary(input);
		},
		async resolve(input) {
			const adapterInput: AdapterResolveInput = {
				providerID: input.providerID,
				...(input.integrationID !== undefined
					? { integrationID: input.integrationID }
					: {}),
				authMethod: input.authMethod,
				companion: input.companion,
				deps: input.deps,
				credentialDeps: input.credentialDeps,
				signal: input.signal,
				...(input.nativeCredential === undefined
					? {}
					: { nativeCredential: input.nativeCredential }),
			};

			for (const adapter of registered) {
				const resolved = await adapter.resolve(adapterInput);
				if (resolved !== null) {
					return resolved;
				}
			}

			return null;
		},
	};
}

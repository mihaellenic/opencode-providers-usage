import { homedir } from "node:os";
import type { ConnectionInfo } from "@opencode/client";
import { Plugin } from "@opencode/plugin";
import {
	type CompanionOptions,
	type CredentialReadDeps,
	isQuotaRead,
	type NativeCredentialSource,
	type ProviderAdapter,
	type ProviderDeps,
	type QuotaRead,
} from "./core/contracts";
import { createAdapterRegistry } from "./core/registry";
import { readCodexCompanion } from "./providers/codex-credentials";
import { createOllamaAdapter } from "./providers/ollama";
import { createOpenAICompanionAdapter } from "./providers/openai-companion";
import {
	createQuotaRpcHandlers,
	QUOTA_PLUGIN_ID,
	type QuotaProviderRef,
	QuotaRpc,
	type QuotaRpcSource,
	type QuotaUpdatedEvent,
} from "./rpc";

/**
 * The single registration point for quota adapters. New providers are appended
 * here; core, RPC, and TUI code never gain provider branches.
 */
export const QUOTA_ADAPTERS: ProviderAdapter[] = [
	createOllamaAdapter(),
	createOpenAICompanionAdapter({ readCompanion: readCodexCompanion }),
];

type ServerContext = Pick<
	Plugin.Context,
	"provider" | "integration" | "rpc" | "options"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Companion access is opt-in and server-side only. No credential value can be
 * supplied through plugin configuration; only the consent flag and an optional
 * trusted home directory are read.
 */
function resolveCompanionOptions(
	options: Plugin.Context["options"] | undefined,
): CompanionOptions {
	const raw = options?.codexCompanion;
	if (!isRecord(raw)) {
		return { enabled: false };
	}
	const home =
		typeof raw.home === "string" && raw.home.trim() !== ""
			? raw.home
			: undefined;
	return {
		enabled: raw.enabled === true,
		...(home === undefined ? {} : { home }),
	};
}

export function authMethodForConnection(
	connection: ConnectionInfo | undefined,
): string {
	if (connection === undefined) {
		return "none";
	}
	return connection.type === "credential" ? connection.method : "env";
}

type HostConnectionApi = ServerContext["integration"]["connection"];
type HostCredentialValue = NonNullable<
	Awaited<ReturnType<HostConnectionApi["resolve"]>>
>;

/**
 * Serializes the host credential into the auth.json-entry JSON shape both
 * adapter parsers already accept. Refresh tokens and expiry are deliberately
 * dropped: the adapters only need selectors plus the access/key value, and
 * fewer secrets cross the bridge. Never logged and never RPC output.
 */
function serializeNativeCredential(value: HostCredentialValue): unknown {
	if (value.type === "key") {
		return { type: "key", key: value.key };
	}
	if (value.type === "oauth") {
		return {
			type: "oauth",
			methodID: value.methodID,
			access: value.access,
			...(value.metadata === undefined ? {} : { metadata: value.metadata }),
		};
	}
	// "external" references manage their secret outside the credential store.
	return undefined;
}

/**
 * The host bridge reads only the ACTIVE connection for an integration; no
 * credential path or value can arrive through RPC or plugin options. Host
 * errors propagate to the adapter, which maps them to a sanitized read.
 */
function createNativeCredentialSource(
	connection: HostConnectionApi,
): NativeCredentialSource {
	return {
		async resolve(integrationID) {
			const active = await connection.active(integrationID);
			if (active === undefined) {
				return undefined;
			}
			const value = await connection.resolve(active);
			if (value === undefined) {
				return undefined;
			}
			return serializeNativeCredential(value);
		},
	};
}

/**
 * Resolves provider metadata to quota inputs. The integration ID comes from the
 * provider record, never from an assumption that provider ID equals integration
 * ID; the auth method comes from the active connection.
 */
export async function resolveProviderRefs(
	ctx: ServerContext,
): Promise<QuotaProviderRef[]> {
	const providers = (await ctx.provider.list()).data;
	return Promise.all(
		providers.map(async (provider) => {
			const integrationID = provider.integrationID;
			const authMethod =
				integrationID === undefined
					? "none"
					: authMethodForConnection(
							await ctx.integration.connection.active(integrationID),
						);
			return {
				providerID: provider.id,
				...(integrationID === undefined ? {} : { integrationID }),
				authMethod,
			};
		}),
	);
}

function unavailableRead(now: number): QuotaRead {
	return {
		state: "unsupported",
		reason: "no_validated_quota_source",
		attemptedAt: now,
	};
}

function invalidResponseRead(now: number): QuotaRead {
	return {
		state: "unavailable",
		reason: "invalid_response",
		attemptedAt: now,
	};
}

/**
 * Interim direct-resolve path. Task 8 replaces this with the shared
 * identity-aware coordinator; keep it thin and side-effect free.
 */
function createRead(source: {
	registry: ReturnType<typeof createAdapterRegistry>;
	now(): number;
	companion: CompanionOptions;
	deps: ProviderDeps;
	credentialDeps: CredentialReadDeps;
	nativeCredential: NativeCredentialSource;
}) {
	return async (input: {
		providerID: string;
		integrationID?: string;
		authMethod: string;
		signal: AbortSignal;
	}): Promise<QuotaRead> => {
		try {
			const resolved = await source.registry.resolve({
				providerID: input.providerID,
				...(input.integrationID === undefined
					? {}
					: { integrationID: input.integrationID }),
				authMethod: input.authMethod,
				companion: source.companion,
				deps: source.deps,
				credentialDeps: source.credentialDeps,
				nativeCredential: source.nativeCredential,
				signal: input.signal,
			});
			if (resolved === null) {
				return unavailableRead(source.now());
			}
			const value = await resolved.read(input.signal);
			return isQuotaRead(value) ? value : invalidResponseRead(source.now());
		} catch {
			return invalidResponseRead(source.now());
		}
	};
}

export async function setupQuotaServer(ctx: ServerContext): Promise<void> {
	const now = () => Date.now();
	const registry = createAdapterRegistry(QUOTA_ADAPTERS);
	const companion = resolveCompanionOptions(ctx.options);
	const nativeCredential = createNativeCredentialSource(
		ctx.integration.connection,
	);
	const source: QuotaRpcSource = {
		registry,
		now,
		providers: () => resolveProviderRefs(ctx),
		read: createRead({
			registry,
			now,
			companion,
			nativeCredential,
			deps: {
				now,
				async getJson() {
					throw new Error("quota transport is not wired yet");
				},
			},
			credentialDeps: {
				now,
				env: process.env,
				homeDirectory: homedir(),
				async readUtf8() {
					throw new Error("credential reads are not wired yet");
				},
			},
		}),
	};

	let emitUpdated: ((event: QuotaUpdatedEvent) => Promise<void>) | undefined;
	const handlers = createQuotaRpcHandlers({
		source,
		publish: async (event) => {
			await emitUpdated?.(event);
		},
	});
	const registration = await ctx.rpc.register(QuotaRpc, handlers);
	emitUpdated = (event) => registration.events.emit("updated", event);
}

export default Plugin.define({
	id: QUOTA_PLUGIN_ID,
	setup: setupQuotaServer,
});

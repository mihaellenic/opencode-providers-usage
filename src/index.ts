import { open } from "node:fs/promises";
import { homedir } from "node:os";
import type { ConnectionInfo } from "@opencode/client";
import { Plugin } from "@opencode/plugin";
import type {
	CompanionOptions,
	CredentialReadDeps,
	NativeCredentialSource,
	ProviderAdapter,
	ProviderDeps,
	QuotaRead,
	ResolvedQuotaSource,
} from "./core/contracts";
import { createQuotaCoordinator } from "./core/refresh";
import { createAdapterRegistry } from "./core/registry";
import { readCodexCompanion } from "./providers/codex-credentials";
import { getQuotaJson } from "./providers/http";
import { createOllamaAdapter } from "./providers/ollama";
import { createOpenAICompanionAdapter } from "./providers/openai-companion";
import {
	createQuotaRpcHandlers,
	QUOTA_PLUGIN_ID,
	QUOTA_RPC_VERSION,
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
	// `undefined` here intentionally means "not observable"; the pinned auth
	// method gates keep external references out of the supported adapters.
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
 * A resolved source that needs no further resolution work: unsupported
 * connections and rejected adapter/registry calls still produce a truthful
 * sanitized read, and they never become a second request path.
 */
function staticSource(
	identityKey: string,
	read: () => QuotaRead,
): ResolvedQuotaSource {
	return {
		identityKey,
		read: async () => read(),
		isCurrent: async () => true,
	};
}

/**
 * Bounded UTF-8 file read for the credential readers. The byte bound is
 * enforced while reading, never trusted from an earlier stat: the handle reads
 * in chunks and aborts as soon as the bound is crossed. Error messages carry no
 * path or file contents, so credential material cannot reach diagnostics.
 */
async function readBoundedUtf8(
	path: string,
	maxBytes: number,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new Error("invalid credential byte bound");
	}
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) {
				break;
			}
			total += bytesRead;
			if (total > maxBytes) {
				throw new Error("credential file exceeds the configured byte bound");
			}
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		await handle.close();
	}
}

export async function setupQuotaServer(
	ctx: ServerContext,
): Promise<() => Promise<void>> {
	const now = () => Date.now();
	const registry = createAdapterRegistry(QUOTA_ADAPTERS);
	const companion = resolveCompanionOptions(ctx.options);
	const nativeCredential = createNativeCredentialSource(
		ctx.integration.connection,
	);
	const deps: ProviderDeps = { now, getJson: getQuotaJson };
	const credentialDeps: CredentialReadDeps = {
		now,
		env: process.env,
		homeDirectory: homedir(),
		readUtf8: readBoundedUtf8,
	};

	/** Last provider/auth reference observed through an RPC read. */
	const providerRefs = new Map<string, QuotaProviderRef>();

	async function refreshProviderRefs(): Promise<QuotaProviderRef[]> {
		const refs = await resolveProviderRefs(ctx);
		for (const ref of refs) {
			providerRefs.set(ref.providerID, ref);
		}
		return refs;
	}

	/**
	 * The registry's resolve, adapted to the coordinator's provider-only seam.
	 * The provider/auth reference observed by the last RPC read is reused so a
	 * poll does not repeat the host inventory lookup; the adapters still reread
	 * the active credential/companion cache on every call, so an account switch
	 * is observed without restarting the plugin.
	 */
	async function resolveSource(
		providerID: string,
		signal: AbortSignal,
	): Promise<ResolvedQuotaSource> {
		let ref = providerRefs.get(providerID);
		if (ref === undefined) {
			try {
				const refs = await refreshProviderRefs();
				ref = refs.find((candidate) => candidate.providerID === providerID) ?? {
					providerID,
					authMethod: "none",
				};
			} catch {
				return staticSource(`provider:${providerID}:unresolved`, () =>
					invalidResponseRead(now()),
				);
			}
		}
		try {
			const resolved = await registry.resolve({
				...ref,
				companion,
				deps,
				credentialDeps,
				nativeCredential,
				signal,
			});
			if (resolved !== null) {
				return resolved;
			}
			return staticSource(`provider:${providerID}:unsupported`, () =>
				unavailableRead(now()),
			);
		} catch {
			// An adapter/registry bug is a sanitized observation, never a crash.
			return staticSource(`provider:${providerID}:error`, () =>
				invalidResponseRead(now()),
			);
		}
	}

	// One coordinator per server plugin runtime: it is the only owner of poll
	// timers, in-flight requests, caching, and cancellation. Deduplication is
	// not promised across separate OpenCode server processes.
	const coordinator = createQuotaCoordinator({
		now,
		resolve: resolveSource,
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	});

	let emitUpdated: ((event: QuotaUpdatedEvent) => Promise<void>) | undefined;
	const watchers = new Map<string, () => void>();

	function publish(providerID: string, quota: QuotaRead): void {
		void emitUpdated?.({
			version: QUOTA_RPC_VERSION,
			providerID,
			quota,
		}).catch(() => undefined);
	}

	/**
	 * A provider enters the poll lifecycle when an RPC consumer first reads it.
	 * Providers that are never read are never resolved or polled, and the
	 * coordinator itself refuses to schedule polling for unsupported or
	 * non-retryable results.
	 */
	function ensureWatched(providerID: string): void {
		if (watchers.has(providerID)) {
			return;
		}
		watchers.set(
			providerID,
			coordinator.watch(providerID, (quota) => publish(providerID, quota)),
		);
	}

	const source: QuotaRpcSource = {
		registry,
		now,
		providers: () => refreshProviderRefs(),
		async read(input) {
			providerRefs.set(input.providerID, {
				providerID: input.providerID,
				...(input.integrationID === undefined
					? {}
					: { integrationID: input.integrationID }),
				authMethod: input.authMethod,
			});
			// The RPC read is a read-through: it joins the shared in-flight
			// request or starts one inside the 15-second floor. The caller's
			// signal stays with the RPC transport; one view leaving must not
			// cancel another view's shared request.
			ensureWatched(input.providerID);
			return coordinator.refresh(input.providerID);
		},
	};

	const handlers = createQuotaRpcHandlers({
		source,
		publish: async (event) => {
			await emitUpdated?.(event);
		},
	});
	const registration = await ctx.rpc.register(QuotaRpc, handlers);
	emitUpdated = (event) => registration.events.emit("updated", event);

	return async () => {
		coordinator.dispose();
		for (const unwatch of watchers.values()) {
			unwatch();
		}
		watchers.clear();
		await registration.dispose();
	};
}

export default Plugin.define({
	id: QUOTA_PLUGIN_ID,
	setup: setupQuotaServer,
});

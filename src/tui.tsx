import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createResource, createSignal, onCleanup } from "solid-js";
import {
	isQuotaRead,
	type ProviderSummary,
	type QuotaRead,
} from "./core/contracts";
import {
	isQuotaGetResult,
	isQuotaListResult,
	QUOTA_PLUGIN_ID,
	type QuotaGetResult,
	type QuotaListResult,
	QuotaRpc,
	type QuotaUpdatedEvent,
} from "./rpc";
import {
	defaultLocaleContext,
	formatQuotaRows,
	revalidateQuota,
} from "./ui/format";
import { Sidebar } from "./ui/Sidebar";
import { UsagePage } from "./ui/UsagePage";

export type QuotaTuiContext = Pick<
	Plugin.Context,
	"client" | "data" | "keymap" | "location" | "ui"
>;

export type QuotaKeymapLayer = ReturnType<
	Parameters<QuotaTuiContext["keymap"]["layer"]>[0]
>;
export type QuotaKeymapCommand = NonNullable<
	QuotaKeymapLayer["commands"]
>[number];

export type QuotaSelection = {
	providerID?: string;
	label: string;
};

const USAGE_PAGE_NAME = "provider-usage";
const USAGE_COMMAND_ID = "provider-quota.usage";
const REFRESH_COMMAND_ID = "provider-quota.refresh";
const PREFERRED_SLASH = "usage";
const FALLBACK_SLASH = "provider-usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuotaUpdatedEventData(value: unknown): value is QuotaUpdatedEvent {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.providerID === "string" &&
		value.providerID.length > 0 &&
		isQuotaRead(value.quota) &&
		Object.keys(value).length === 3
	);
}

type QuotaEventSubscription = {
	on(name: "updated", handler: (payload: unknown) => void): () => void;
};

/**
 * Subscribes to the server's pushed snapshots. The subscription belongs to the
 * mounting view and is disposed with it on unload; it creates no timer and no
 * request. Clients without event support degrade to the resource read.
 */
export function subscribeQuotaUpdates(
	context: Pick<QuotaTuiContext, "client">,
	handler: (event: QuotaUpdatedEvent) => void,
): () => void {
	const client = context.client.rpc(QuotaRpc);
	const events = (client as { events?: Partial<QuotaEventSubscription> })
		.events;
	if (events?.on === undefined) {
		return () => {};
	}
	try {
		return events.on("updated", (payload) => {
			if (isRecord(payload) && isQuotaUpdatedEventData(payload.data)) {
				handler(payload.data);
			}
		});
	} catch {
		return () => {};
	}
}

/**
 * Reads the prompt's selected model reactively. With no selection the UI says
 * so explicitly instead of falling back to the server's default model.
 */
export function currentSelection(
	context: Pick<QuotaTuiContext, "ui" | "data" | "location">,
): QuotaSelection {
	const selected = context.ui.model.current();
	if (selected === undefined) {
		return { label: "No provider selected" };
	}
	const provider = context.data.location.provider
		.list(context.location)
		?.find((candidate) => candidate.id === selected.providerID);
	return {
		providerID: selected.providerID,
		label: provider?.name ?? selected.providerID,
	};
}

export function usageSlashName(
	context: Pick<QuotaTuiContext, "keymap">,
): string {
	const occupied = context.keymap
		.commands()
		.some(
			(command) =>
				command.id !== USAGE_COMMAND_ID &&
				command.slash?.name === PREFERRED_SLASH,
		);
	return occupied ? FALLBACK_SLASH : PREFERRED_SLASH;
}

function quotaHeadline(quota: QuotaRead): string {
	const [row] = formatQuotaRows(quota, defaultLocaleContext());
	return row?.value ?? "no quota reported";
}

async function fetchProvider(
	context: QuotaTuiContext,
	providerID: string,
	signal: AbortSignal,
): Promise<QuotaGetResult | undefined> {
	try {
		const result: unknown = await context.client
			.rpc(QuotaRpc)
			.get({ providerID }, { signal });
		return isQuotaGetResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

async function refreshProvider(
	context: QuotaTuiContext,
	providerID: string,
): Promise<QuotaGetResult | undefined> {
	try {
		const result: unknown = await context.client
			.rpc(QuotaRpc)
			.refresh({ providerID });
		return isQuotaGetResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

async function fetchProviders(
	context: QuotaTuiContext,
	signal: AbortSignal,
): Promise<QuotaListResult | undefined> {
	try {
		const result: unknown = await context.client
			.rpc(QuotaRpc)
			.list({}, { signal });
		return isQuotaListResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Latest pushed snapshot per provider. Keyed by provider ID, so an update for
 * one provider can never be rendered under another provider's label.
 */
function usePushedQuota(context: QuotaTuiContext) {
	const [pushed, setPushed] = createSignal<Record<string, QuotaRead>>({});
	const dispose = subscribeQuotaUpdates(context, (event) => {
		setPushed((current) => ({
			...current,
			[event.providerID]: event.quota,
		}));
	});
	onCleanup(dispose);
	return pushed;
}

type VisibleProvider = {
	provider: ProviderSummary;
	quota: QuotaRead;
};

// The host JSX runtime types component props as Record<string, unknown>;
// these narrow component contracts are validated where they are rendered.
const SidebarHost = Sidebar as unknown as (
	props: Record<string, unknown>,
) => unknown;
const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;

export function QuotaSidebar(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const selection = createMemo(() => currentSelection(context));
	const pushed = usePushedQuota(context);
	let inFlight: AbortController | undefined;
	const [snapshot] = createResource(selection, async (selected) => {
		inFlight?.abort();
		if (selected.providerID === undefined) {
			return undefined;
		}
		const controller = new AbortController();
		inFlight = controller;
		return fetchProvider(context, selected.providerID, controller.signal);
	});
	onCleanup(() => inFlight?.abort());

	// Only a snapshot fetched for the currently selected provider is shown; a
	// resource keeps the previous value while refetching, and account A's
	// figures must never appear under account B's label. Pushed snapshots are
	// re-validated locally so an expiry that passed since the server push stops
	// rendering figures (ledger ruling 2).
	const visibleProvider = (): VisibleProvider | undefined => {
		const selected = selection();
		if (selected.providerID === undefined) {
			return undefined;
		}
		const fetched = snapshot();
		const matching =
			fetched !== undefined &&
			fetched.provider.providerID === selected.providerID
				? fetched
				: undefined;
		const quota = pushed()[selected.providerID] ?? matching?.quota;
		if (matching === undefined || quota === undefined) {
			return undefined;
		}
		return {
			provider: matching.provider,
			quota: revalidateQuota(quota, Date.now()),
		};
	};

	const openUsage = () =>
		context.ui.router.navigate({ type: "plugin", name: USAGE_PAGE_NAME });

	return jsx("box", {
		flexDirection: "column",
		children: () => {
			const selected = selection();
			if (selected.providerID === undefined) {
				return jsx("text", { children: "No provider selected" });
			}
			const visible = visibleProvider();
			if (visible === undefined) {
				return jsx("text", {
					children: snapshot.loading
						? `${selected.label}: checking quota`
						: `${selected.label}: quota unavailable`,
				});
			}
			return jsx(SidebarHost, {
				provider: visible.provider,
				quota: visible.quota,
				openUsage,
			});
		},
	});
}

export function QuotaUsagePage(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const pushed = usePushedQuota(context);
	let inFlight: AbortController | undefined;
	const [snapshot, { refetch }] = createResource(async () => {
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		return fetchProviders(context, controller.signal);
	});
	onCleanup(() => inFlight?.abort());

	const pageView = (): {
		providers: ProviderSummary[];
		quotaByProvider: Record<string, QuotaRead>;
	} => {
		const result = snapshot();
		if (result === undefined) {
			return { providers: [], quotaByProvider: {} };
		}
		const now = Date.now();
		const providers: ProviderSummary[] = [];
		const quotaByProvider: Record<string, QuotaRead> = {};
		for (const view of result.providers) {
			const providerID = view.provider.providerID;
			providers.push(view.provider);
			const quota = pushed()[providerID] ?? view.quota;
			quotaByProvider[providerID] = revalidateQuota(quota, now);
		}
		return { providers, quotaByProvider };
	};

	const refresh = (providerID: string): void => {
		void (async () => {
			await refreshProvider(context, providerID);
			// Re-read the sanitized list so the page reflects the refresh even
			// when the client has no event subscription; the RPC floor returns
			// the just-committed snapshot. There is no local override that could
			// outlive an account change.
			await refetch();
		})();
	};

	const back = () => context.ui.router.navigate({ type: "home" });

	return jsx("box", {
		flexDirection: "column",
		children: () => {
			if (snapshot() === undefined) {
				return jsx("text", { children: "Loading provider usage..." });
			}
			const view = pageView();
			return jsx(UsagePageHost, {
				providers: view.providers,
				quotaByProvider: view.quotaByProvider,
				refresh,
				back,
			});
		},
	});
}

async function refreshSelected(context: QuotaTuiContext): Promise<void> {
	const selection = currentSelection(context);
	if (selection.providerID === undefined) {
		context.ui.toast.show({
			message: "No provider selected",
			variant: "warning",
		});
		return;
	}
	const result = await refreshProvider(context, selection.providerID);
	context.ui.toast.show({
		message:
			result === undefined
				? `${selection.label}: quota unavailable`
				: `${selection.label}: ${quotaHeadline(result.quota)}`,
	});
}

/**
 * Passive host integration: a compact sidebar line, a namespaced full page,
 * and palette/slash commands. Nothing here fetches quota directly; the RPC is
 * the only boundary, and the server coordinator is the only refresh owner. No
 * widget owns a timer, so mounting sidebar and page shares one request rate.
 */
export function setupQuotaTui(context: QuotaTuiContext): () => void {
	const disposeSidebar = context.ui.slot({
		append: "sidebar.content",
		render: () => jsx(QuotaSidebar, { context }),
	});
	const disposePage = context.ui.router.register({
		name: USAGE_PAGE_NAME,
		render: (input) => jsx(QuotaUsagePage, { context, data: input.data }),
	});
	context.keymap.layer(() => ({
		mode: "global",
		priority: 10,
		commands: [
			{
				id: USAGE_COMMAND_ID,
				title: "Show provider usage",
				description: "Open provider quotas and support status",
				group: "Provider usage",
				palette: true,
				slash: { name: usageSlashName(context) },
				run: () => {
					context.ui.router.navigate({
						type: "plugin",
						name: USAGE_PAGE_NAME,
					});
				},
			},
			{
				id: REFRESH_COMMAND_ID,
				title: "Refresh provider usage",
				group: "Provider usage",
				palette: true,
				run: () => refreshSelected(context),
			},
		],
	}));

	return () => {
		disposeSidebar();
		disposePage();
	};
}

export default Plugin.define({
	id: `${QUOTA_PLUGIN_ID}.tui`,
	setup: setupQuotaTui,
});

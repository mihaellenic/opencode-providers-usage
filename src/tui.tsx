import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { isQuotaRead, type QuotaRead } from "./core/contracts";
import {
	isQuotaGetResult,
	isQuotaListResult,
	QUOTA_PLUGIN_ID,
	type QuotaGetResult,
	type QuotaListResult,
	QuotaRpc,
	type QuotaUpdatedEvent,
} from "./rpc";

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

function quotaState(quota: QuotaRead | undefined): string {
	if (quota === undefined) {
		return "quota unavailable";
	}
	if ("sections" in quota) {
		return quota.state;
	}
	return `${quota.state} (${quota.reason})`;
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

function sidebarLine(
	selection: QuotaSelection,
	quota: QuotaRead | undefined,
	loading: boolean,
): string {
	if (selection.providerID === undefined) {
		return "No provider selected";
	}
	if (loading) {
		return `${selection.label}: checking quota`;
	}
	if (quota === undefined) {
		return `${selection.label}: quota unavailable`;
	}
	return `${selection.label}: ${quotaState(quota)}`;
}

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
	// figures must never appear under account B's label.
	const visibleQuota = (): QuotaRead | undefined => {
		const selected = selection();
		if (selected.providerID === undefined) {
			return undefined;
		}
		const pushedValue = pushed()[selected.providerID];
		if (pushedValue !== undefined) {
			return pushedValue;
		}
		const fetched = snapshot();
		return fetched !== undefined &&
			fetched.provider.providerID === selected.providerID
			? fetched.quota
			: undefined;
	};

	return jsx("text", {
		children: () =>
			sidebarLine(
				selection(),
				visibleQuota(),
				snapshot.loading && visibleQuota() === undefined,
			),
	});
}

function pageText(
	selection: QuotaSelection,
	result: QuotaListResult | undefined,
	pushed: () => Record<string, QuotaRead>,
): string {
	const lines = ["Provider usage", `Selected: ${selection.label}`, ""];
	if (result === undefined) {
		lines.push("Provider inventory unavailable");
		return lines.join("\n");
	}
	if (result.providers.length === 0) {
		lines.push("No providers available");
		return lines.join("\n");
	}
	for (const view of result.providers) {
		const quota = pushed()[view.provider.providerID] ?? view.quota;
		lines.push(
			`${view.provider.name} [${view.provider.providerID}]: ${view.provider.support} / ${quotaState(quota)}`,
		);
	}
	return lines.join("\n");
}

export function QuotaUsagePage(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const selection = createMemo(() => currentSelection(context));
	const pushed = usePushedQuota(context);
	let inFlight: AbortController | undefined;
	const [snapshot] = createResource(async () => {
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		return fetchProviders(context, controller.signal);
	});
	onCleanup(() => inFlight?.abort());

	return jsx("box", {
		flexDirection: "column",
		children: jsx("text", {
			children: () => pageText(selection(), snapshot(), pushed),
		}),
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
				: `${selection.label}: ${quotaState(result.quota)}`,
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

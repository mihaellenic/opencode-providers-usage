import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createResource } from "solid-js";
import type { QuotaRead } from "./core/contracts";
import {
	isQuotaGetResult,
	isQuotaListResult,
	QUOTA_PLUGIN_ID,
	type QuotaGetResult,
	type QuotaListResult,
	QuotaRpc,
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
): Promise<QuotaGetResult | undefined> {
	try {
		const result: unknown = await context.client
			.rpc(QuotaRpc)
			.get({ providerID });
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
): Promise<QuotaListResult | undefined> {
	try {
		const result: unknown = await context.client.rpc(QuotaRpc).list({});
		return isQuotaListResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

function sidebarLine(
	selection: QuotaSelection,
	result: QuotaGetResult | undefined,
	loading: boolean,
): string {
	if (selection.providerID === undefined) {
		return "No provider selected";
	}
	if (loading) {
		return `${selection.label}: checking quota`;
	}
	if (result === undefined) {
		return `${selection.label}: quota unavailable`;
	}
	return `${selection.label}: ${quotaState(result.quota)}`;
}

export function QuotaSidebar(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const selection = createMemo(() => currentSelection(context));
	const [snapshot] = createResource(selection, async (selected) => {
		if (selected.providerID === undefined) {
			return undefined;
		}
		return fetchProvider(context, selected.providerID);
	});

	return jsx("text", {
		children: () => sidebarLine(selection(), snapshot(), snapshot.loading),
	});
}

function pageText(
	selection: QuotaSelection,
	result: QuotaListResult | undefined,
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
		lines.push(
			`${view.provider.name} [${view.provider.providerID}]: ${view.provider.support} / ${quotaState(view.quota)}`,
		);
	}
	return lines.join("\n");
}

export function QuotaUsagePage(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const selection = createMemo(() => currentSelection(context));
	const [snapshot] = createResource(() => fetchProviders(context));
	return jsx("box", {
		flexDirection: "column",
		children: jsx("text", {
			children: () => pageText(selection(), snapshot()),
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
 * the only boundary, and the interim server wiring returns truthful
 * unsupported/unavailable states for the empty registry.
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

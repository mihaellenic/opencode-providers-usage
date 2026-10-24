import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createResource, createSignal, onCleanup } from "solid-js";
import {
	isQuotaRead,
	type LocaleContext,
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
	formatSidebarRows,
	revalidateQuota,
} from "./ui/format";
import { UsagePage } from "./ui/UsagePage";

export type QuotaTuiContext = Pick<
	Plugin.Context,
	"client" | "data" | "keymap" | "location" | "theme" | "ui"
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
function createPushedQuota(context: QuotaTuiContext) {
	const [pushed, setPushed] = createSignal<Record<string, QuotaRead>>({});
	const dispose = subscribeQuotaUpdates(context, (event) => {
		setPushed((current) => ({
			...current,
			[event.providerID]: event.quota,
		}));
	});
	return { pushed, dispose };
}

function usePushedQuota(context: QuotaTuiContext) {
	const created = createPushedQuota(context);
	onCleanup(created.dispose);
	return created.pushed;
}

type SidebarSnapshotState = {
	loading: boolean;
	value: QuotaGetResult | undefined;
};

/**
 * Sidebar fetch driver. A plain signal (not `createResource`) keeps the
 * contribution independent of host resource machinery; `sync` is invoked from
 * the slot render computation only when the selected provider changes, and the
 * async result is stored in a signal read by a memo.
 */
function createSidebarDriver(context: QuotaTuiContext) {
	const [snapshot, setSnapshot] = createSignal<SidebarSnapshotState>({
		loading: false,
		value: undefined,
	});
	let inFlight: AbortController | undefined;
	let started = false;
	let currentProvider: string | undefined;

	const sync = (providerID: string | undefined) => {
		if (started && providerID === currentProvider) {
			return;
		}
		started = true;
		currentProvider = providerID;
		inFlight?.abort();
		if (providerID === undefined) {
			setSnapshot({ loading: false, value: undefined });
			return;
		}
		const controller = new AbortController();
		inFlight = controller;
		setSnapshot({ loading: true, value: undefined });
		void fetchProvider(context, providerID, controller.signal).then(
			(result) => {
				if (!controller.signal.aborted) {
					setSnapshot({ loading: false, value: result });
				}
			},
		);
	};

	return {
		snapshot,
		sync,
		dispose: () => inFlight?.abort(),
	};
}

type PageInventory =
	| { state: "loading" }
	| { state: "failed" }
	| { state: "ready"; result: QuotaListResult };

export const INVENTORY_FAILED_TITLE = "Provider inventory unavailable";
export const INVENTORY_FAILED_DETAIL =
	"Quota could not be read from the server. No figures are shown.";
export const INVENTORY_RETRY_HINT = "[ctrl+r] retry   [esc] back";

/**
 * Separates in-flight (`undefined`, no error) from failed-and-retryable
 * (`null` sentinel or a resource error). Collapsing these into "loading" left
 * the user without a truthful state or any way to retry.
 */
export function quotaInventory(
	value: QuotaListResult | null | undefined,
	error: unknown,
): PageInventory {
	if (error !== undefined || value === null) {
		return { state: "failed" };
	}
	if (value === undefined) {
		return { state: "loading" };
	}
	return { state: "ready", result: value };
}

export type RecoveryCommand = {
	id: string;
	title: string;
	bind: string;
	run: () => void;
};

/** Escape/retry bindings used only while the full page cannot register its own. */
export function inventoryRecoveryCommands(handlers: {
	retry: () => void;
	back: () => void;
}): RecoveryCommand[] {
	return [
		{
			id: "provider-quota.recovery.back",
			title: "Back from provider usage",
			bind: "escape",
			run: handlers.back,
		},
		{
			id: "provider-quota.recovery.retry",
			title: "Retry provider inventory",
			bind: "ctrl+r",
			run: handlers.retry,
		},
	];
}

// The host JSX runtime types component props as Record<string, unknown>;
// these narrow component contracts are validated where they are rendered.
const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;

/**
 * Plain sidebar text for the slot contribution. `null` means the host should
 * render nothing; every other branch is one string joined with newlines so the
 * slot returns exactly one static text node with a plain-string child.
 */
export function buildSidebarText(input: {
	selection: QuotaSelection | undefined;
	provider: ProviderSummary | undefined;
	quota: QuotaRead | undefined;
	loading: boolean;
	locale: LocaleContext;
	now?: number;
}): string | null {
	if (input.selection === undefined) {
		return null;
	}
	const selection = input.selection;
	if (selection.providerID === undefined) {
		return "No provider selected";
	}
	if (input.provider === undefined || input.quota === undefined) {
		return input.loading
			? `${selection.label}: checking quota`
			: `${selection.label}: quota unavailable`;
	}
	return formatSidebarRows(
		input.provider,
		input.quota,
		input.locale,
		input.now ?? Date.now(),
	)
		.map((row) => `${row.label}: ${row.value}`)
		.join("\n");
}

export function QuotaUsagePage(props: Record<string, unknown>) {
	const context = props.context as QuotaTuiContext;
	const pushed = usePushedQuota(context);
	let inFlight: AbortController | undefined;
	// `null` is the failed-inventory sentinel; `undefined` means the resource
	// has not produced a first value yet. They must never collapse into the
	// same "loading" UI.
	const [snapshot, { refetch }] = createResource(
		async (): Promise<QuotaListResult | null> => {
			inFlight?.abort();
			const controller = new AbortController();
			inFlight = controller;
			return (await fetchProviders(context, controller.signal)) ?? null;
		},
	);
	onCleanup(() => inFlight?.abort());

	const inventory = createMemo(() =>
		quotaInventory(snapshot(), snapshot.error),
	);

	const pageView = (
		result: QuotaListResult,
	): {
		providers: ProviderSummary[];
		quotaByProvider: Record<string, QuotaRead>;
	} => {
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
	const retry = () => void refetch();

	// While the inventory is loading or failed the full page component is not
	// mounted, so its keymap cannot help. This recovery layer guarantees a way
	// out of the failure state; it disables itself once the page mounts.
	context.keymap.layer(() => ({
		mode: "global",
		priority: 20,
		enabled: () => inventory().state !== "ready",
		commands: inventoryRecoveryCommands({ retry, back }),
	}));

	const content = createMemo(() => {
		const current = inventory();
		if (current.state === "loading") {
			return jsx("text", { children: "Loading provider usage..." });
		}
		if (current.state === "failed") {
			return jsx("box", {
				flexDirection: "column",
				children: [
					jsx("text", {
						fg: context.theme.text.feedback.error.base,
						children: INVENTORY_FAILED_TITLE,
					}),
					jsx("text", {
						fg: context.theme.text.feedback.error.base,
						children: INVENTORY_FAILED_DETAIL,
					}),
					jsx("text", {
						fg: context.theme.text.muted,
						children: INVENTORY_RETRY_HINT,
					}),
				],
			});
		}
		const view = pageView(current.result);
		return jsx(UsagePageHost, {
			providers: view.providers,
			quotaByProvider: view.quotaByProvider,
			refresh,
			back,
		});
	});

	return jsx("box", {
		flexDirection: "column",
		get children() {
			return content();
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
	const sidebarSelection = createMemo(() => currentSelection(context));
	const sidebarPushed = createPushedQuota(context);
	const sidebarDriver = createSidebarDriver(context);
	const sidebarLocale = defaultLocaleContext();
	// The slot contribution is one static text node with a plain-string child.
	// No component wrapper, box, getter, or async resource sits on the render
	// path: the driver result is consumed inside this memo and the host
	// re-diffs only the returned string.
	const sidebarText = createMemo(() => {
		const selected = sidebarSelection();
		const snapshot = sidebarDriver.snapshot();
		const fetched = snapshot.value;
		const matching =
			fetched !== undefined &&
			selected.providerID !== undefined &&
			fetched.provider.providerID === selected.providerID
				? fetched
				: undefined;
		const quota =
			selected.providerID === undefined
				? undefined
				: (sidebarPushed.pushed()[selected.providerID] ?? matching?.quota);
		return buildSidebarText({
			selection: selected,
			provider: matching?.provider,
			quota:
				quota === undefined ? undefined : revalidateQuota(quota, Date.now()),
			loading: snapshot.loading,
			locale: sidebarLocale,
		});
	});
	const disposeSidebar = context.ui.slot({
		append: "sidebar.content",
		render: () => {
			sidebarDriver.sync(sidebarSelection().providerID);
			const text = sidebarText();
			if (text === null) {
				return null;
			}
			return jsx("text", { children: text });
		},
	});
	const disposePage = context.ui.router.register({
		name: USAGE_PAGE_NAME,
		render: (input) => jsx(QuotaUsagePage, { context, data: input.data }),
	});
	// The slash-yield choice is evaluated ONCE, at setup, outside the layer
	// factory. The factory must stay pure (host docs): reading
	// `keymap.commands()` reactively inside a layer factory re-enters the
	// command store while it registers — a recursive update loop that ends as
	// "RangeError: Maximum call stack size exceeded" the first time the host
	// recomputes command state. The static choice costs late-registrating
	// plugins the ability to steal `/usage` after us; collision at that later
	// point is the host's duplicate-slash problem, not a quota failure.
	const usageSlash = usageSlashName(context);
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
				slash: { name: usageSlash },
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
		sidebarDriver.dispose();
		sidebarPushed.dispose();
		disposeSidebar();
		disposePage();
	};
}

export default Plugin.define({
	id: `${QUOTA_PLUGIN_ID}.tui`,
	setup: setupQuotaTui,
});

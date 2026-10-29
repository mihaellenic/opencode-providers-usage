// Desktop GUI entry. With src/gui/host-binding.ts, the only module that
// imports the GUI SDK; the views and the controller stay host-agnostic.
import {
	Command,
	MenuItem,
	Panel,
	type PanelFrame,
	Plugin,
	type Registry,
	usePanel,
} from "@opencode/plugin/gui";
import { createMemo, type JSX, onCleanup, Show, untrack } from "solid-js";
import { DashboardView } from "./gui/DashboardView";
import {
	bindSessionHost,
	bindUsageRpc,
	type RpcBindingContext,
	type SessionServer,
} from "./gui/host-binding";
import { SummaryView } from "./gui/SummaryView";
import { useController } from "./gui/solid";
import {
	type ControllerView,
	createUsageController,
	type UsageController,
} from "./gui/state";
import { QUOTA_PLUGIN_ID } from "./rpc";

/** Contribution ids are local to the plugin; the host prefixes them with `ctx.id`. */
export const PANEL_ID = `${QUOTA_PLUGIN_ID}-panel`;
export const COMMAND_ID = `${QUOTA_PLUGIN_ID}-open-dashboard`;
export const MENU_ID = `${QUOTA_PLUGIN_ID}-open-summary`;

export type OwningSession = {
	readonly key: string;
	readonly id: string;
	readonly server: SessionServer;
};

/** The routed session object a command or menu item acts on. */
export type RoutedSession = { readonly key: string };

export type UsageClock = {
	now(): number;
	setTimer(cb: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
};

export type UsageDeps = {
	usePanel(): Pick<PanelFrame, "visible" | "present">;
	clock: UsageClock;
};

type AddContribution = {
	add<T>(registry: Registry<T>, item: T | (() => T | undefined)): unknown;
};

/**
 * The slice of the setup context this entry uses. `S` is the session object
 * the host hands to `sessions.current()` and `layout.open()`.
 */
export type UsageSetupContext<S extends RoutedSession = RoutedSession> =
	RpcBindingContext &
		AddContribution & {
			readonly id: string;
			readonly layout: {
				open(key: string, session: S): void;
				state(
					key: string,
					session: S,
				): "closed" | "open" | "active" | "visible";
			};
			readonly sessions: { current(): S | undefined };
		};

type TimerBox = { readonly id: ReturnType<typeof setTimeout> };

function isTimerBox(value: unknown): value is TimerBox {
	return typeof value === "object" && value !== null && "id" in value;
}

export const realClock: UsageClock = {
	now: () => Date.now(),
	setTimer: (cb, ms): TimerBox => ({ id: setTimeout(cb, ms) }),
	clearTimer(handle) {
		if (isTimerBox(handle)) clearTimeout(handle.id);
	},
};

export const realDeps: UsageDeps = { usePanel, clock: realClock };

/** The slice of the owning session screen this entry reads (`PanelProps.screen`). */
export type OwningScreen = {
	readonly composer: {
		model(): { readonly providerID: string } | undefined;
	};
};

export type UsagePanelProps = {
	readonly session: OwningSession;
	readonly screen: OwningScreen;
};

export function setupUsage<S extends RoutedSession>(
	ctx: UsageSetupContext<S>,
	deps: UsageDeps = realDeps,
): () => void {
	const rpc = bindUsageRpc(ctx);
	// View per session survives controller disposal on session switch.
	const views = new Map<string, ControllerView>();
	const live = new Map<string, UsageController>();
	let disposed = false;

	const disposeAll = (): void => {
		disposed = true;
		for (const controller of [...live.values()]) controller.dispose();
		live.clear();
	};
	if (ctx.signal.aborted) disposeAll();
	else ctx.signal.addEventListener("abort", disposeAll, { once: true });

	const panelKey = `${ctx.id}:${PANEL_ID}`;
	const tab = {
		id: PANEL_ID,
		title: "Provider usage",
		closable: "compact" as const,
		fallback: true,
	};

	function SessionBody(props: {
		sessionKey: string;
		session: () => OwningSession;
		screen: () => OwningScreen;
		visible: () => boolean;
	}): JSX.Element {
		const key = props.sessionKey;
		const first = untrack(props.session);
		const controller = createUsageController({
			session: bindSessionHost(ctx, first.id, {
				server: () => props.session().server,
				composerProviderID: () => props.screen().composer.model()?.providerID,
				visible: props.visible,
			}),
			rpc,
			initialView: views.get(key) ?? "summary",
			onView: (view) => {
				views.set(key, view);
			},
			...deps.clock,
		});
		if (disposed) controller.dispose();
		else live.set(key, controller);
		onCleanup(() => {
			if (live.get(key) === controller) live.delete(key);
			controller.dispose();
		});

		const version = useController(controller);
		const view = createMemo(() => {
			version();
			return controller.view();
		});
		return (
			<Show
				when={view() === "dashboard"}
				fallback={<SummaryView controller={controller} />}
			>
				<DashboardView controller={controller} />
			</Show>
		);
	}

	const open = (view: ControllerView): void => {
		const session = ctx.sessions.current();
		if (session === undefined) return;
		views.set(session.key, view);
		live.get(session.key)?.open(view);
		ctx.layout.open(panelKey, session);
	};

	ctx.add(Panel, {
		id: PANEL_ID,
		region: "side",
		list: ({ open: stored }) => (stored.includes(PANEL_ID) ? [tab] : []),
		render: (props: UsagePanelProps) => {
			const frame = deps.usePanel();
			// Keyed by session: the render stays mounted across a session switch, the
			// body (and its controller) is rebuilt for the next session.
			return (
				<Show when={props.session.key} keyed>
					{(key) => (
						<SessionBody
							sessionKey={key}
							session={() => props.session}
							screen={() => props.screen}
							visible={() => frame.visible() && frame.present()}
						/>
					)}
				</Show>
			);
		},
	});

	ctx.add(Command, {
		id: COMMAND_ID,
		title: "Show provider usage",
		slash: { name: "usage" },
		run: () => open("dashboard"),
	});

	ctx.add(MenuItem, () => {
		const session = ctx.sessions.current();
		return {
			menu: "session.panel" as const,
			id: MENU_ID,
			title: "Provider usage",
			opened:
				session !== undefined &&
				ctx.layout.state(panelKey, session) !== "closed",
			run: () => open("summary"),
		};
	});

	return disposeAll;
}

export default Plugin.define({
	setup: (ctx) => setupUsage(ctx),
});

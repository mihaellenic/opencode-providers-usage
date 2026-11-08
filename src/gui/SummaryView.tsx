import { createMemo, type JSX, onCleanup, onMount, Show } from "solid-js";
import { claudeSidebarModel } from "../ui/claude-sidebar";
import { defaultLocaleContext } from "../ui/format";
import { buildSidebarModel, type SidebarLine } from "../ui/sidebar-model";
import { UsageLines } from "./ProviderCard";
import {
	registerSummaryButton,
	unregisterSummaryButton,
	useController,
} from "./solid";
import type { UsageController } from "./state";
import { styles } from "./styles";

export type SummaryViewProps = {
	controller: UsageController;
	/** Formatting reference; defaults to the wall clock. */
	now?: (() => number) | undefined;
};

type Shown = {
	state: "no-selection" | "loading" | "ready" | "failed";
	status: string;
	name?: string;
	note?: string;
	lines: SidebarLine[];
};

export function SummaryView(props: SummaryViewProps): JSX.Element {
	const version = useController(props.controller);
	const locale = defaultLocaleContext();

	const shown = createMemo((): Shown => {
		version();
		const now = props.now?.() ?? Date.now();
		const summary = props.controller.summary();
		switch (summary.kind) {
			case "no-selection":
				return {
					state: "no-selection",
					status: "No model selected",
					lines: [],
				};
			case "claude": {
				const model = claudeSidebarModel(summary.state, locale, now);
				return {
					state: summary.state.status,
					status: model.provider,
					name: model.provider,
					lines: model.lines,
				};
			}
			case "loading":
				return { state: "loading", status: "Loading usage…", lines: [] };
			case "ready": {
				const model = buildSidebarModel(
					summary.view.provider,
					summary.view.quota,
					locale,
					now,
				);
				return {
					state: "ready",
					status: model.provider,
					name: model.provider,
					lines: model.lines,
				};
			}
			case "failed": {
				if (summary.lastKnown === undefined) {
					return {
						state: "failed",
						status: "Usage unavailable",
						note: "Refresh failed. Open the dashboard to retry.",
						lines: [],
					};
				}
				const model = buildSidebarModel(
					summary.lastKnown.provider,
					summary.lastKnown.quota,
					locale,
					now,
					undefined,
					{ mightBeStale: true },
				);
				return {
					state: "failed",
					status: `${model.provider} (last known)`,
					name: model.provider,
					note: "Refresh failed",
					lines: model.lines,
				};
			}
		}
	});

	const open = (): void => props.controller.open("dashboard");

	return (
		<section class="ou-summary" data-state={shown().state}>
			<style>{styles}</style>
			<button
				ref={(element) => {
					onMount(() => registerSummaryButton(props.controller, element));
					onCleanup(() => unregisterSummaryButton(props.controller, element));
				}}
				class="ou-summary-button"
				type="button"
				aria-label={`Provider usage ${shown().status}. Open dashboard`}
				aria-busy={shown().state === "loading" ? "true" : undefined}
				onClick={open}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					if (event.ctrlKey || event.metaKey || event.altKey) return;
					event.preventDefault();
					open();
				}}
			>
				<span class="ou-title">Provider usage</span>{" "}
				<span>{shown().status}</span>
			</button>
			<Show when={shown().note}>
				{(note) => (
					<p class="ou-note" data-tone="warning">
						{note()}
					</p>
				)}
			</Show>
			<UsageLines lines={shown().lines} subject={shown().name ?? "Provider"} />
		</section>
	);
}

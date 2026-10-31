import { createMemo, For, type JSX, Show } from "solid-js";
import { defaultLocaleContext } from "../ui/format";
import { buildUsagePageModel } from "../ui/usage-page-model";
import { partitionUsageCards } from "../ui/usage-shared";
import { ProviderCard } from "./ProviderCard";
import { focusSummary, useController } from "./solid";
import type { UsageController } from "./state";
import { styles } from "./styles";

export type DashboardViewProps = {
	controller: UsageController;
	/** Formatting reference; defaults to the wall clock. */
	now?: (() => number) | undefined;
};

export function DashboardView(props: DashboardViewProps): JSX.Element {
	const version = useController(props.controller);
	const locale = defaultLocaleContext();

	const state = createMemo(() => {
		version();
		const dashboard = props.controller.dashboard();
		const model = buildUsagePageModel({
			providers: dashboard.providers.map((view) => view.provider),
			quotaByProvider: Object.fromEntries(
				dashboard.providers.map((view) => [
					view.provider.providerID,
					view.quota,
				]),
			),
			locale,
			now: props.now?.() ?? Date.now(),
			claudeUsage: dashboard.claude,
		});
		// A card with a visible refresh error must stay a card with its Retry,
		// even when its last successful read is unsupported or not-applicable.
		const partitionQuota = Object.fromEntries(
			dashboard.providers
				.filter(
					(view) =>
						dashboard.cardErrors[view.provider.providerID] === undefined,
				)
				.map((view) => [view.provider.providerID, view.quota]),
		);
		const partition = partitionUsageCards(model.cards, partitionQuota);
		return {
			inventory: dashboard.inventory,
			cardErrors: dashboard.cardErrors,
			title: model.title,
			subtitle: model.subtitle,
			/** Connected inventory before partitioning decides the disconnected state. */
			total: model.cards.length,
			cards: partition.cards,
			unavailableNote: partition.unavailableNote,
		};
	});

	const back = (): void => {
		props.controller.open("summary");
		focusSummary(props.controller);
	};

	return (
		<section class="ou-dashboard" data-dashboard aria-label={state().title}>
			<style>{styles}</style>
			<header class="ou-header">
				<button class="ou-button" type="button" onClick={back}>
					Back
				</button>
				<h2 class="ou-title">{state().title}</h2>
				<button
					class="ou-button"
					type="button"
					onClick={() => props.controller.refresh()}
				>
					Refresh
				</button>
			</header>
			<p class="ou-note">{state().subtitle}</p>
			<Show when={state().inventory === "loading"}>
				<p class="ou-note" role="status" aria-busy="true" data-loading>
					Loading providers…
				</p>
			</Show>
			<Show when={state().inventory === "failed"}>
				<p class="ou-note" role="alert" data-tone="error">
					Could not load providers. Use Refresh to try again.
				</p>
			</Show>
			<Show
				when={state().inventory !== "ready" || state().total > 0}
				fallback={<p class="ou-note">No connected providers.</p>}
			>
				<Show when={state().cards.length > 0}>
					<div class="ou-grid">
						<For each={state().cards}>
							{(card) => (
								<ProviderCard
									card={card}
									error={state().cardErrors[card.id]}
									onRetry={
										state().cardErrors[card.id] === undefined
											? undefined
											: () => props.controller.retry(card.id)
									}
								/>
							)}
						</For>
					</div>
				</Show>
				<Show when={state().unavailableNote}>
					{(note) => (
						<p class="ou-note" data-unavailable-note data-tone="muted">
							{note()}
						</p>
					)}
				</Show>
			</Show>
		</section>
	);
}

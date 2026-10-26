import { usePlugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo } from "solid-js";
import type {
	LocaleContext,
	ProviderSummary,
	QuotaRead,
} from "../core/contracts";
import { renderSidebarLines, toneColor } from "./bar-row";
import { defaultLocaleContext } from "./format";
import { resolveSidebarTheme } from "./theme";
import { buildUsagePageModel } from "./usage-page-model";

export type UsagePageProps = {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
	refresh: (providerID: string) => void;
	back: () => void;
};

/**
 * Full-page dashboard. Every connected provider becomes one card that repeats
 * the sidebar quota widget for its sanitized read; the page adds only the
 * update-age cell, absolute reset timestamps, and the reported total-credits
 * row. Escape returns and ctrl+r refreshes every connected provider through
 * the injected callback (RPC only; no inference request).
 */
export function UsagePage(props: UsagePageProps) {
	const context = usePlugin();
	const locale: LocaleContext = defaultLocaleContext();
	context.keymap.layer(() => ({
		mode: "global",
		priority: 20,
		commands: [
			{
				id: "provider-quota.page.back",
				title: "Back from provider usage",
				bind: "escape",
				run: () => props.back(),
			},
			{
				id: "provider-quota.page.refresh",
				title: "Refresh provider usage",
				bind: "ctrl+r",
				run: () => {
					for (const provider of props.providers) {
						props.refresh(provider.providerID);
					}
				},
			},
		],
	}));

	const content = createMemo(() => {
		const theme = resolveSidebarTheme(context.theme);
		const model = buildUsagePageModel({
			providers: props.providers,
			quotaByProvider: props.quotaByProvider,
			locale,
			now: Date.now(),
		});
		const children: unknown[] = [
			jsx("text", {
				key: "title",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.base,
				children: model.title,
			}),
			jsx("text", {
				key: "subtitle",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.muted,
				children: model.subtitle,
			}),
		];
		if (model.cards.length === 0) {
			children.push(
				jsx("text", {
					key: "empty",
					maxWidth: "100%",
					wrapMode: "word",
					fg: theme.muted,
					children: "No connected providers.",
				}),
			);
		} else {
			model.cards.forEach((card, index) => {
				if (index > 0) {
					children.push(
						jsx("text", {
							key: `${card.id}:separator`,
							children: "",
						}),
					);
				}
				children.push(
					jsx("box", {
						key: `${card.id}:card`,
						flexDirection: "column",
						maxWidth: "100%",
						children: [
							jsx("box", {
								key: `${card.id}:header`,
								flexDirection: "row",
								flexWrap: "wrap",
								justifyContent: "space-between",
								columnGap: 1,
								width: "100%",
								children: [
									jsx("text", {
										key: `${card.id}:name`,
										maxWidth: "100%",
										wrapMode: "word",
										fg: theme.base,
										children: card.name,
									}),
									...(card.updated === undefined
										? []
										: [
												jsx("text", {
													key: `${card.id}:updated`,
													maxWidth: "100%",
													flexShrink: 0,
													wrapMode: "word",
													fg: toneColor(theme, card.updated.tone),
													children: card.updated.text,
												}),
											]),
								],
							}),
							...renderSidebarLines(card.lines, theme),
						],
					}),
				);
			});
		}
		children.push(
			jsx("text", {
				key: "footer",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.muted,
				children: "[esc] back   [ctrl+r] refresh",
			}),
		);
		return children;
	});

	return jsx("box", {
		flexDirection: "column",
		get children() {
			return content();
		},
	});
}

export default UsagePage;

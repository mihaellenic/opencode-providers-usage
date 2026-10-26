import { usePlugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
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

const CARD_WIDTH = 56;

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
				attributes: TextAttributes.BOLD,
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
			const unavailable = (id: string) => {
				const state = props.quotaByProvider[id]?.state;
				return state === "unsupported" || state === "not-applicable";
			};
			// Quota widgets share the first rows; source-less accounts follow as
			// full-width cards, matching the approved mock without provider rules.
			const cards = [
				...model.cards.filter((card) => !unavailable(card.id)),
				...model.cards.filter((card) => unavailable(card.id)),
			];
			children.push(
				jsx("box", {
					key: "cards",
					width: "100%",
					maxWidth: CARD_WIDTH * 2 + 2,
					flexDirection: "row",
					flexWrap: "wrap",
					columnGap: 2,
					rowGap: 1,
					marginY: 1,
					children: cards.map((card) =>
						jsx("box", {
							key: `${card.id}:card`,
							flexDirection: "column",
							width: unavailable(card.id) ? "100%" : CARD_WIDTH,
							flexShrink: 0,
							maxWidth: "100%",
							border: true,
							borderStyle: "single",
							borderColor: theme.muted,
							padding: 1,
							children: [
								jsx("box", {
									key: `${card.id}:header`,
									flexDirection: "row",
									flexWrap: "wrap",
									justifyContent: "space-between",
									columnGap: 1,
									marginBottom: 1,
									width: "100%",
									children: [
										jsx("text", {
											key: `${card.id}:name`,
											maxWidth: "100%",
											wrapMode: "word",
											fg: theme.base,
											attributes: TextAttributes.BOLD,
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
								...card.lines.flatMap((line) => {
									const rendered = renderSidebarLines([line], theme);
									return line.kind === "credit"
										? [
												jsx("box", {
													key: `${line.id}:summary`,
													flexDirection: "column",
													marginTop: 1,
													children: rendered,
												}),
											]
										: rendered;
								}),
							],
						}),
					),
				}),
			);
		}
		children.push(
			jsx("box", {
				key: "footer",
				width: "100%",
				border: ["top"],
				borderColor: theme.muted,
				paddingTop: 1,
				children: jsx("text", {
					maxWidth: "100%",
					wrapMode: "word",
					fg: theme.muted,
					children: "[esc] back   [ctrl+r] refresh",
				}),
			}),
		);
		return children;
	});

	return jsx("scrollbox", {
		focused: true,
		width: "100%",
		height: "100%",
		maxWidth: 180,
		scrollX: false,
		scrollY: true,
		children: jsx("box", {
			flexDirection: "column",
			flexShrink: 0,
			width: "100%",
			paddingX: 1,
			paddingY: 1,
			get children() {
				return content();
			},
		}),
	});
}

export default UsagePage;

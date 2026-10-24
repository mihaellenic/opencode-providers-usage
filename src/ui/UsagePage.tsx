import { usePlugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import type {
	DisplayRow,
	LocaleContext,
	ProviderSummary,
	QuotaRead,
} from "../core/contracts";
import { defaultLocaleContext, formatUsageSections } from "./format";

export type UsagePageProps = {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
	refresh: (providerID: string) => void;
	back: () => void;
};

type Theme = ReturnType<typeof usePlugin>["theme"];

function toneColor(theme: Theme, tone: DisplayRow["tone"]) {
	if (tone === "error") {
		return theme.text.feedback.error.base;
	}
	if (tone === "warning") {
		return theme.text.feedback.warning.base;
	}
	return theme.text.base;
}

function rowElement(theme: Theme, row: DisplayRow) {
	return [
		jsx("text", {
			key: row.id,
			fg: toneColor(theme, row.tone),
			children: `${row.label}: ${row.value}`,
		}),
		...(row.detail === undefined
			? []
			: [
					jsx("text", {
						key: `${row.id}:detail`,
						fg: theme.text.muted,
						children: `  ${row.detail}`,
					}),
				]),
	];
}

/**
 * Full-page dashboard. Sections are derived from provider declarations and
 * sanitized quota reads, never from per-provider branches. Escape returns
 * and ctrl+r refreshes every connected provider through the injected
 * callback (RPC only; no inference request).
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

	return jsx("box", {
		flexDirection: "column",
		children: () => {
			const theme = context.theme;
			const sections = formatUsageSections({
				providers: props.providers,
				quotaByProvider: props.quotaByProvider,
				locale,
			});
			const children: unknown[] = [
				jsx("text", {
					key: "title",
					fg: theme.text.base,
					children: "Provider usage",
				}),
				jsx("text", {
					key: "hint",
					fg: theme.text.faint,
					children: "[ctrl+r] refresh   [esc] back",
				}),
			];
			if (sections.length === 0) {
				children.push(
					jsx("text", {
						key: "empty",
						fg: theme.text.muted,
						children: "No connected providers.",
					}),
				);
				return children;
			}
			for (const section of sections) {
				children.push(
					jsx("text", {
						key: `${section.providerID}:heading`,
						fg: theme.text.base,
						children: `${section.heading} — ${section.support}`,
					}),
				);
				for (const row of section.rows) {
					children.push(...rowElement(theme, row));
				}
				children.push(
					jsx("text", {
						key: `${section.providerID}:separator`,
						fg: theme.text.faint,
						children: "",
					}),
				);
			}
			return children;
		},
	});
}

export default UsagePage;

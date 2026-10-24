import { usePlugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import type {
	DisplayRow,
	LocaleContext,
	ProviderSummary,
	QuotaRead,
} from "../core/contracts";
import { defaultLocaleContext, formatSidebarRows } from "./format";

export type SidebarProps = {
	provider: ProviderSummary;
	quota: QuotaRead;
	openUsage: () => void;
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

/**
 * Compact selected-provider contribution. All labels, values, scopes and
 * states come from the sanitized declarations and quota read; this component
 * only paints the view model and forwards a click as the usage-page action.
 */
export function Sidebar(props: SidebarProps) {
	const context = usePlugin();
	const locale: LocaleContext = defaultLocaleContext();

	return jsx("box", {
		flexDirection: "column",
		onMouseDown: () => props.openUsage(),
		children: () =>
			formatSidebarRows(props.provider, props.quota, locale).map((row) =>
				jsx("text", {
					key: row.id,
					fg: toneColor(context.theme, row.tone),
					children: `${row.label}: ${row.value}`,
				}),
			),
	});
}

export default Sidebar;

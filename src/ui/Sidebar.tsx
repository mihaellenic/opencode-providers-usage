import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo } from "solid-js";
import type {
	LocaleContext,
	ProviderSummary,
	QuotaRead,
} from "../core/contracts";
import { defaultLocaleContext, formatSidebarRows } from "./format";

export type SidebarProps = {
	provider: ProviderSummary;
	quota: QuotaRead;
};

/**
 * Compact selected-provider contribution as one text node with a plain-string
 * child. The live sidebar slot builds the same joined string directly in its
 * render computation; this wrapper remains as the reusable presentation shape
 * (and is what the host-render tests exercise). Click-to-open was removed from
 * the text shape; the page is opened through /usage or the palette command.
 */
export function Sidebar(props: SidebarProps) {
	const locale: LocaleContext = defaultLocaleContext();
	const content = createMemo(() =>
		formatSidebarRows(props.provider, props.quota, locale)
			.map((row) => `${row.label}: ${row.value}`)
			.join("\n"),
	);

	return jsx("text", {
		get children() {
			return content();
		},
	});
}

export default Sidebar;

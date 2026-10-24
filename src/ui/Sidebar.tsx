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
 * Test-only presentation shape: the live sidebar slot renders the joined text
 * directly in src/tui.tsx. This wrapper keeps the pinned compact component
 * contract and is what the host-render tests exercise. Click-to-open was
 * removed from the text shape; the page opens through /usage or the palette
 * command.
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

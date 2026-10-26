import { jsx } from "@opentui/solid/jsx-runtime";
import type { QuotaTuiContext } from "../tui";
import { renderSidebarLines } from "./bar-row";
import type { SidebarModel } from "./sidebar-model";
import { resolveSidebarTheme, type SidebarTheme } from "./theme";

export { resolveSidebarTheme, type SidebarTheme };

export type SidebarProps = {
	model: SidebarModel;
	theme: QuotaTuiContext["theme"];
	openUsage: () => void;
};

/**
 * Static terminal interpretation of the approved compact quota block:
 * provider-name title, a width-adaptive used-quota bar with a compact reset
 * countdown and percent-only threshold tone, dimmed detail rows, and a
 * whole-card click target. Every value comes from the plain data model; this
 * function performs no host reads and returns fresh renderable nodes on every
 * call so a disposed tree is never reused.
 */
export function renderSidebar(
	model: SidebarModel,
	theme: SidebarTheme,
	openUsage: () => void,
) {
	return jsx("box", {
		flexDirection: "column",
		maxWidth: "100%",
		paddingLeft: 1,
		onMouseDown: openUsage,
		children: [
			jsx("text", {
				key: "provider",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.base,
				children: model.provider,
			}),
			...renderSidebarLines(model.lines, theme),
		],
	});
}

/** Component wrapper: same static renderer, same plain model, no host reads. */
export function Sidebar(props: SidebarProps) {
	return renderSidebar(
		props.model,
		resolveSidebarTheme(props.theme),
		props.openUsage,
	);
}

export default Sidebar;

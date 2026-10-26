import type { RGBA } from "@opentui/core";
import type { QuotaTuiContext } from "../tui";

/** Minimal semantic tokens the quota block actually paints. */
export type SidebarTheme = {
	readonly base: RGBA;
	readonly muted: RGBA;
	readonly success: RGBA;
	readonly warning: RGBA;
	readonly error: RGBA;
	readonly action: RGBA;
};

/**
 * Snapshots the required theme families into plugin-owned plain values. The
 * live setup calls this from reactively tracked theme reads outside the slot
 * render; the renderer never reaches back into the host theme object.
 */
export function resolveSidebarTheme(
	theme: QuotaTuiContext["theme"],
): SidebarTheme {
	return {
		base: theme.text.base,
		muted: theme.text.muted,
		success: theme.text.feedback.success.base,
		warning: theme.text.feedback.warning.base,
		error: theme.text.feedback.error.base,
		action: theme.text.action.primary.base,
	};
}

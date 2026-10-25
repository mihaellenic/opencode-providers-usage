import type { RGBA } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { QuotaTuiContext } from "../tui";
import type { SidebarCell, SidebarModel, SidebarTone } from "./sidebar-model";

/** Minimal semantic tokens the quota block actually paints. */
export type SidebarTheme = {
	readonly base: RGBA;
	readonly muted: RGBA;
	readonly success: RGBA;
	readonly warning: RGBA;
	readonly error: RGBA;
	readonly action: RGBA;
};

export type SidebarProps = {
	model: SidebarModel;
	theme: QuotaTuiContext["theme"];
	openUsage: () => void;
};

type HostTheme = QuotaTuiContext["theme"];

// Long runs clipped to their flex segment; the terminal width decides how many
// glyphs are actually painted, so the renderer never reads the host width.
const USED_GLYPHS = "━".repeat(1000);
const REMAINING_GLYPHS = "─".repeat(1000);

/**
 * Snapshots the required theme families into plugin-owned plain values. The
 * live setup calls this from reactively tracked theme reads outside the slot
 * render; the renderer never reaches back into the host theme object.
 */
export function resolveSidebarTheme(theme: HostTheme): SidebarTheme {
	return {
		base: theme.text.base,
		muted: theme.text.muted,
		success: theme.text.feedback.success.base,
		warning: theme.text.feedback.warning.base,
		error: theme.text.feedback.error.base,
		action: theme.text.action.primary.base,
	};
}

function toneColor(theme: SidebarTheme, tone: SidebarTone) {
	switch (tone) {
		case "success":
			return theme.success;
		case "warning":
			return theme.warning;
		case "error":
			return theme.error;
		case "muted":
			return theme.muted;
		default:
			return theme.base;
	}
}

function cell(
	theme: SidebarTheme,
	value: SidebarCell,
	key: string,
	width?: number,
) {
	return jsx("text", {
		key,
		maxWidth: "100%",
		...(width === undefined ? {} : { width, flexShrink: 0 }),
		wrapMode: "word",
		fg: theme.muted,
		children: value.text,
	});
}

type BarRow = {
	id: string;
	label?: string;
	fill: number;
	percent: SidebarCell;
	reset?: string;
};

/**
 * One compact bar row: optional duration label, the width-adaptive used (base)
 * / remaining (muted) track, the percent used, and an optional inline reset
 * countdown. The track grows to the available frame width; each glyph run is
 * clipped by its flex segment, so no host width read is needed.
 */
function barRow(theme: SidebarTheme, line: BarRow) {
	const percentTone =
		line.percent.tone === "normal"
			? theme.muted
			: toneColor(theme, line.percent.tone);
	const fill = Math.min(1, Math.max(0, line.fill));
	return jsx("box", {
		key: line.id,
		flexDirection: "row",
		flexWrap: "wrap",
		width: "100%",
		columnGap: 1,
		children: [
			...(line.label === undefined
				? []
				: [
						jsx("text", {
							key: `${line.id}:label`,
							maxWidth: "100%",
							flexShrink: 0,
							wrapMode: "word",
							fg: theme.muted,
							children: line.label,
						}),
					]),
			jsx("box", {
				key: `${line.id}:bar`,
				flexDirection: "row",
				flexGrow: 1,
				flexBasis: 0,
				minWidth: 1,
				children: [
					...(fill <= 0
						? []
						: [
								jsx("text", {
									key: `${line.id}:used`,
									flexGrow: fill,
									flexBasis: 0,
									flexShrink: 0,
									overflow: "hidden",
									wrapMode: "none",
									fg: theme.base,
									children: USED_GLYPHS,
								}),
							]),
					...(fill >= 1
						? []
						: [
								jsx("text", {
									key: `${line.id}:remaining`,
									flexGrow: 1 - fill,
									flexBasis: 0,
									flexShrink: 0,
									overflow: "hidden",
									wrapMode: "none",
									fg: theme.muted,
									children: REMAINING_GLYPHS,
								}),
							]),
				],
			}),
			jsx("text", {
				key: `${line.id}:percent`,
				flexShrink: 0,
				wrapMode: "none",
				fg: percentTone,
				children: line.percent.text,
			}),
			...(line.reset === undefined
				? []
				: [
						jsx("text", {
							key: `${line.id}:reset`,
							flexShrink: 0,
							maxWidth: "100%",
							wrapMode: "word",
							fg: theme.muted,
							children: `· ${line.reset}`,
						}),
					]),
		],
	});
}

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
	const rows = model.lines.map((line) => {
		if (line.kind === "window") {
			if (line.fill === undefined) {
				return jsx("box", {
					key: line.id,
					flexDirection: "row",
					flexWrap: "wrap",
					columnGap: 1,
					children: [
						jsx("text", {
							key: `${line.id}:label`,
							maxWidth: "100%",
							flexShrink: 0,
							wrapMode: "word",
							fg: theme.muted,
							children: line.label,
						}),
						cell(theme, line.value, `${line.id}:value`),
						...(line.reset === undefined
							? []
							: [
									jsx("text", {
										key: `${line.id}:reset`,
										maxWidth: "100%",
										wrapMode: "word",
										fg: theme.muted,
										children: `· ${line.reset}`,
									}),
								]),
					],
				});
			}
			return barRow(theme, {
				id: line.id,
				label: line.label,
				fill: line.fill,
				percent: line.value,
				reset: line.reset,
			});
		}
		if (line.kind === "credit") {
			return jsx("box", {
				key: line.id,
				flexDirection: "column",
				children: [
					jsx("box", {
						key: `${line.id}:row`,
						flexDirection: "row",
						justifyContent: "space-between",
						columnGap: 1,
						children: [
							jsx("text", {
								key: `${line.id}:label`,
								maxWidth: "100%",
								wrapMode: "word",
								fg: theme.muted,
								children: line.label,
							}),
							cell(theme, line.value, `${line.id}:value`),
						],
					}),
					...(line.detail === undefined
						? []
						: [
								jsx("text", {
									key: `${line.id}:detail`,
									maxWidth: "100%",
									wrapMode: "word",
									fg: theme.muted,
									children: line.detail,
								}),
							]),
				],
			});
		}
		if (line.kind === "pair") {
			return jsx("box", {
				key: line.id,
				flexDirection: "row",
				flexWrap: "wrap",
				justifyContent: "space-between",
				columnGap: 1,
				children: [
					cell(theme, line.left, `${line.id}:left`),
					...(line.right === undefined
						? []
						: [cell(theme, line.right, `${line.id}:right`)]),
				],
			});
		}
		if (line.kind === "bar") {
			return barRow(theme, line);
		}
		return jsx("text", {
			key: line.id,
			maxWidth: "100%",
			wrapMode: "word",
			fg: theme.muted,
			children: line.text,
		});
	});

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
			...rows,
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

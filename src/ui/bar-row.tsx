import { jsx } from "@opentui/solid/jsx-runtime";
import type { SidebarCell, SidebarLine, SidebarTone } from "./sidebar-model";
import type { SidebarTheme } from "./theme";

// Long runs clipped to their flex segment; the terminal width decides how many
// glyphs are actually painted, so the renderer never reads the host width.
const USED_GLYPHS = "━".repeat(1000);
const REMAINING_GLYPHS = "─".repeat(1000);

export function toneColor(theme: SidebarTheme, tone: SidebarTone) {
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

export type BarRowInput = {
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
export function barRow(theme: SidebarTheme, line: BarRowInput) {
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
 * Paints the compact widget rows shared by the sidebar and the full usage
 * page. Every value comes from the plain data model; this function performs no
 * host reads and returns fresh renderable nodes on every call so a disposed
 * tree is never reused.
 */
export function renderSidebarLines(lines: SidebarLine[], theme: SidebarTheme) {
	return lines.map((line) => {
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
						flexWrap: "wrap",
						justifyContent: "space-between",
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
}

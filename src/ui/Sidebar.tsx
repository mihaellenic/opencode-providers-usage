import type { RGBA } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { QuotaTuiContext } from "../tui";
import type {
	SidebarCell,
	SidebarLine,
	SidebarModel,
	SidebarTone,
} from "./sidebar-model";

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
		fg: toneColor(theme, value.tone),
		children: value.text,
	});
}

/**
 * Static terminal interpretation of the approved compact quota block:
 * accent rule, `Quota`/provider header, aligned window cells, paired credit
 * metrics, muted freshness footer, and the real page link. Every value comes
 * from the plain data model; this function performs no host reads and returns
 * fresh renderable nodes on every call so a disposed tree is never reused.
 */
export function renderSidebar(
	model: SidebarModel,
	theme: SidebarTheme,
	openUsage: () => void,
) {
	// Shared intrinsic columns: wide enough for actual labels/values at normal
	// pane widths. `maxWidth: "100%"` lets a real parent constrain a column that
	// is wider than the pane, so text wraps instead of clipping without any
	// host width read or fixed pane-size assumption.
	const labelWidth = Math.max(
		1,
		...model.lines
			.filter(
				(line): line is Extract<SidebarLine, { kind: "window" }> =>
					line.kind === "window",
			)
			.map((line) => line.label.length),
	);
	const valueWidth = Math.max(
		1,
		...model.lines
			.filter(
				(line): line is Extract<SidebarLine, { kind: "window" }> =>
					line.kind === "window",
			)
			.map((line) => line.value.text.length),
	);
	const rows = model.lines.map((line) => {
		if (line.kind === "window") {
			return jsx("box", {
				key: line.id,
				flexDirection: "row",
				flexWrap: "wrap",
				columnGap: 1,
				children: [
					jsx("text", {
						key: `${line.id}:label`,
						width: labelWidth,
						maxWidth: "100%",
						flexShrink: 0,
						wrapMode: "word",
						fg: theme.base,
						children: line.label,
					}),
					cell(theme, line.value, `${line.id}:value`, valueWidth),
					...(line.reset === undefined
						? []
						: [
								jsx("text", {
									key: `${line.id}:reset`,
									flexGrow: 1,
									flexShrink: 0,
									maxWidth: "100%",
									textAlign: "right",
									wrapMode: "word",
									fg: theme.muted,
									children: line.reset,
								}),
							]),
				],
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
								fg: theme.base,
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
					cell(theme, line.right, `${line.id}:right`),
				],
			});
		}
		return jsx("text", {
			key: line.id,
			maxWidth: "100%",
			wrapMode: "word",
			fg: toneColor(theme, line.tone),
			children: line.text,
		});
	});

	return jsx("box", {
		flexDirection: "column",
		maxWidth: "100%",
		border: ["left"],
		borderStyle: "single",
		borderColor: theme.action,
		paddingLeft: 1,
		children: [
			jsx("box", {
				key: "header",
				flexDirection: "row",
				flexWrap: "wrap",
				justifyContent: "space-between",
				columnGap: 1,
				maxWidth: "100%",
				children: [
					jsx("text", {
						key: "header:title",
						wrapMode: "word",
						fg: theme.base,
						children: "Quota",
					}),
					jsx("text", {
						key: "header:provider",
						flexGrow: 1,
						flexShrink: 1,
						minWidth: 10,
						maxWidth: "100%",
						textAlign: "right",
						wrapMode: "word",
						fg: theme.muted,
						children: model.provider,
					}),
				],
			}),
			...rows,
			jsx("text", {
				key: "footer",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.muted,
				children: model.footer,
			}),
			jsx("text", {
				key: "open-usage",
				maxWidth: "100%",
				wrapMode: "word",
				fg: theme.action,
				onMouseDown: openUsage,
				children: "View all providers →",
			}),
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

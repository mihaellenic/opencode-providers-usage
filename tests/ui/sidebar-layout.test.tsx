import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import { renderSidebar, type SidebarTheme } from "../../src/ui/Sidebar";
import {
	buildSidebarModel,
	type SidebarModel,
} from "../../src/ui/sidebar-model";

const PRODUCTION_NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const PRODUCTION_LOCALE = { locale: "en-GB", timeZone: "UTC" };
const OPENAI_PROVIDER: ProviderSummary = {
	providerID: "openai",
	name: "OpenAI ChatGPT with Codex companion",
	integrationID: "openai",
	authMethod: "oauth",
	support: "requires-companion",
	evidence: "live-validated",
};

function productionRead(): QuotaRead {
	return {
		state: "available",
		authSource: "codex-companion",
		sections: [
			{
				scope: "shared-plan",
				result: {
					state: "available",
					metrics: [
						{
							kind: "window",
							id: "five-hour",
							scope: "shared-plan",
							label: "Primary",
							windowSeconds: 18_000,
							remainingPercent: 97,
							usedPercent: 3,
							resetsAt: Date.UTC(2026, 9, 24, 17, 0, 0),
						},
						{
							kind: "window",
							id: "weekly",
							scope: "shared-plan",
							label: "Secondary",
							windowSeconds: 604_800,
							remainingPercent: 9,
							usedPercent: 91,
							resetsAt: Date.UTC(2026, 9, 29, 11, 0, 0),
						},
					],
					fetchedAt: PRODUCTION_NOW - 30_000,
					expiresAt: PRODUCTION_NOW + 60_000,
				},
			},
		],
	};
}

export const LAYOUT_THEME: SidebarTheme = {
	base: RGBA.fromHex("#ffffff"),
	muted: RGBA.fromHex("#aaaaaa"),
	success: RGBA.fromHex("#a7d5b2"),
	warning: RGBA.fromHex("#ebc588"),
	error: RGBA.fromHex("#ff3355"),
	action: RGBA.fromHex("#c3a6ef"),
};

const TWO_WINDOWS: SidebarModel = {
	provider: "OpenAI · Codex quota",
	lines: [
		{
			id: "app-week",
			kind: "window",
			label: "App 7d",
			value: { text: "90% left", tone: "success" },
			reset: "Resets Thu 14:00",
		},
		{
			id: "shared-5h",
			kind: "window",
			label: "Shared 5h",
			value: { text: "9% left", tone: "warning" },
			reset: "Resets 18:00",
		},
	],
	footer: "updated 30s ago · Europe/Stockholm",
};

const COMPLETE_CREDITS: SidebarModel = {
	provider: "Ollama Cloud",
	lines: [
		{
			id: "included",
			kind: "credit",
			label: "Included",
			value: { text: "83.5% left", tone: "success" },
			detail: "$50.10 of $60 left · refills in 3w",
		},
		{
			id: "purchased-total",
			kind: "pair",
			left: { text: "Purchased $4.27", tone: "normal" },
			right: { text: "Total $54.37", tone: "normal" },
			metricIDs: ["purchased", "total"],
		},
	],
	footer: "updated 30s ago · Europe/Stockholm",
};

const UNAVAILABLE: SidebarModel = {
	provider: "OpenCode / Zen",
	lines: [
		{
			id: "status",
			kind: "status",
			text: "Quota unavailable: no quota source is validated for this provider.",
			tone: "warning",
		},
	],
	footer: "last attempt 30s ago · Europe/Stockholm",
};

const LONG_CUSTOM_LABELS: SidebarModel = {
	provider: "A very long arbitrary provider name",
	lines: [
		{
			id: "custom-long",
			kind: "window",
			label: "Shared 7d · Custom daily window",
			value: { text: "45% left", tone: "success" },
			reset: "Resets Nov 30, 12:00 · 2027",
		},
		{
			id: "unknown-long",
			kind: "window",
			label: "App 5h",
			value: { text: "Unknown (not reported)", tone: "muted" },
		},
	],
	footer: "updated 12s ago · Europe/Stockholm",
};

function paintedLines(frame: string): string[] {
	return frame
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

async function paint(model: SidebarModel, width: number) {
	const setup = await testRender(
		() => renderSidebar(model, LAYOUT_THEME, () => {}),
		{ width, height: 20 },
	);
	await setup.renderOnce();
	return setup;
}

async function capture(model: SidebarModel, width: number): Promise<string[]> {
	const setup = await paint(model, width);
	try {
		return paintedLines(setup.captureCharFrame());
	} finally {
		await setup.dispose();
	}
}

function spanFor(
	frame: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
	text: string,
) {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(text)) {
				return span;
			}
		}
	}
	throw new Error(`no painted span contains ${JSON.stringify(text)}`);
}

describe("approved sidebar layout", () => {
	test("60_and_40_columns_match_the_mock_derived_two_window_layout", async () => {
		expect(await capture(TWO_WINDOWS, 60)).toEqual([
			"│ Quota                                 OpenAI · Codex quota",
			"│ App 7d    90% left                        Resets Thu 14:00",
			"│ Shared 5h 9% left                             Resets 18:00",
			"│ updated 30s ago · Europe/Stockholm",
			"│ View all providers →",
		]);
		expect(await capture(TWO_WINDOWS, 40)).toEqual([
			"│ Quota             OpenAI · Codex quota",
			"│ App 7d    90% left    Resets Thu 14:00",
			"│ Shared 5h 9% left         Resets 18:00",
			"│ updated 30s ago · Europe/Stockholm",
			"│ View all providers →",
		]);
	});

	test("production_model_resets_stay_intact_at_every_verified_width", async () => {
		const model = buildSidebarModel(
			OPENAI_PROVIDER,
			productionRead(),
			PRODUCTION_LOCALE,
			PRODUCTION_NOW,
		);
		expect(model.provider).toBe("OpenAI · Codex quota");
		const windows = model.lines.filter(
			(
				line,
			): line is Extract<SidebarModel["lines"][number], { kind: "window" }> =>
				line.kind === "window",
		);
		expect(windows.map((line) => line.label)).toEqual([
			"Shared 5h",
			"Shared 7d",
		]);
		expect(windows.map((line) => line.value)).toEqual([
			{ text: "97% left", tone: "success" },
			{ text: "9% left", tone: "warning" },
		]);
		const resets = windows
			.map((line) => line.reset)
			.filter((reset): reset is string => reset !== undefined);
		expect(resets).toHaveLength(2);

		expect(await capture(model, 40)).toEqual([
			"│ Quota             OpenAI · Codex quota",
			"│ Shared 5h 97% left        Resets 17:00",
			"│ Shared 7d 9% left        29 Oct, 11:00",
			"│ updated 30s ago · UTC",
			"│ View all providers →",
		]);

		for (const width of [24, 32, 40, 60]) {
			const setup = await paint(model, width);
			try {
				const frame = setup.captureCharFrame();
				const lines = paintedLines(frame);
				expect(lines.every((line) => line.length <= width)).toBe(true);
				for (const reset of resets) {
					// A reset is one readable cell: it may move to its own line when the
					// pane is narrow, but it must not split mid-clock or mid-date.
					expect(frame).toContain(reset);
				}
				expect(frame).toContain("97% left");
				expect(frame).toContain("9% left");
			} finally {
				await setup.dispose();
			}
		}
	});

	test("32_and_24_columns_preserve_every_value_and_reset_without_clipping", async () => {
		expect(await capture(TWO_WINDOWS, 32)).toEqual([
			"│ Quota     OpenAI · Codex quota",
			"│ App 7d    90% left",
			"│               Resets Thu 14:00",
			"│ Shared 5h 9% left",
			"│                   Resets 18:00",
			"│ updated 30s ago · Europe/",
			"│ Stockholm",
			"│ View all providers →",
		]);
		expect(await capture(TWO_WINDOWS, 24)).toEqual([
			"│ Quota",
			"│   OpenAI · Codex quota",
			"│ App 7d    90% left",
			"│       Resets Thu 14:00",
			"│ Shared 5h 9% left",
			"│           Resets 18:00",
			"│ updated 30s ago ·",
			"│ Europe/Stockholm",
			"│ View all providers →",
		]);

		for (const width of [24, 32, 40, 60]) {
			const lines = await capture(TWO_WINDOWS, width);
			expect(lines.every((line) => line.length <= width)).toBe(true);
			const painted = lines.join("\n").replace(/[│\s]+/g, "");
			for (const text of [
				"Quota",
				"OpenAI · Codex quota",
				"App 7d",
				"90% left",
				"Resets Thu 14:00",
				"Shared 5h",
				"9% left",
				"Resets 18:00",
				"updated 30s ago · Europe/Stockholm",
				"View all providers →",
			]) {
				expect(painted).toContain(text.replace(/\s+/g, ""));
			}
		}
	});

	test("long_custom_labels_and_values_wrap_without_clipping_at_every_width", async () => {
		for (const width of [24, 32, 40, 60]) {
			const lines = await capture(LONG_CUSTOM_LABELS, width);
			expect(lines.every((line) => line.length <= width)).toBe(true);
			const painted = lines.join("\n").replace(/[│\s]+/g, "");
			for (const text of [
				"A very long arbitrary provider name",
				"Shared 7d ·",
				"Custom daily window",
				"45% left",
				"Resets Nov 30, 12:00 · 2027",
				"App 5h",
				"Unknown (not reported)",
				"updated 12s ago · Europe/Stockholm",
				"View all providers →",
			]) {
				expect(painted).toContain(text.replace(/\s+/g, ""));
			}
		}
	});

	test("long_custom_layout_keeps_intrinsic_columns_wide_and_wraps_only_when_narrow", async () => {
		expect(await capture(LONG_CUSTOM_LABELS, 60)).toEqual([
			"│ Quota                  A very long arbitrary provider name",
			"│ Shared 7d · Custom daily window 45% left",
			"│                                Resets Nov 30, 12:00 · 2027",
			"│ App 5h                          Unknown (not reported)",
			"│ updated 12s ago · Europe/Stockholm",
			"│ View all providers →",
		]);
		expect(await capture(LONG_CUSTOM_LABELS, 24)).toEqual([
			"│ Quota",
			"│ A very long arbitrary",
			"│          provider name",
			"│ Shared 7d · Custom",
			"│ daily window",
			"│ 45% left",
			"│ Resets Nov 30, 12:00 ·",
			"│                   2027",
			"│ App 5h",
			"│ Unknown (not reported)",
			"│ updated 12s ago ·",
			"│ Europe/Stockholm",
			"│ View all providers →",
		]);
	});

	test("window_cells_share_aligned_label_value_and_right_edges_at_normal_widths", async () => {
		const lines = await capture(TWO_WINDOWS, 60);
		expect(lines[1]?.indexOf("90% left")).toBe(12);
		expect(lines[2]?.indexOf("9% left")).toBe(12);
		expect(lines[1]?.endsWith("Resets Thu 14:00")).toBe(true);
		expect(lines[2]?.endsWith("Resets 18:00")).toBe(true);
		expect(lines[1]?.length).toBe(60);
		expect(lines[2]?.length).toBe(60);
	});

	test("credit_pair_and_status_rows_stay_compact_and_truthful", async () => {
		expect(await capture(COMPLETE_CREDITS, 60)).toEqual([
			"│ Quota                                         Ollama Cloud",
			"│ Included                                        83.5% left",
			"│ $50.10 of $60 left · refills in 3w",
			"│ Purchased $4.27                               Total $54.37",
			"│ updated 30s ago · Europe/Stockholm",
			"│ View all providers →",
		]);
		expect(await capture(COMPLETE_CREDITS, 24)).toEqual([
			"│ Quota     Ollama Cloud",
			"│ Included    83.5% left",
			"│ $50.10 of $60 left ·",
			"│ refills in 3w",
			"│ Purchased $4.27",
			"│ Total $54.37",
			"│ updated 30s ago ·",
			"│ Europe/Stockholm",
			"│ View all providers →",
		]);
		expect(await capture(UNAVAILABLE, 32)).toEqual([
			"│ Quota           OpenCode / Zen",
			"│ Quota unavailable: no quota",
			"│ source is validated for this",
			"│ provider.",
			"│ last attempt 30s ago · Europe/",
			"│ Stockholm",
			"│ View all providers →",
		]);
	});

	test("semantic_values_resets_footer_and_action_use_their_theme_families", async () => {
		const setup = await paint(TWO_WINDOWS, 60);
		try {
			const frame = setup.captureSpans();
			const theme = LAYOUT_THEME;
			expect(spanFor(frame, "90% left").fg.equals(theme.success)).toBe(true);
			expect(spanFor(frame, "9% left").fg.equals(theme.warning)).toBe(true);
			expect(spanFor(frame, "Resets Thu 14:00").fg.equals(theme.muted)).toBe(
				true,
			);
			expect(spanFor(frame, "updated 30s ago").fg.equals(theme.muted)).toBe(
				true,
			);
			expect(
				spanFor(frame, "View all providers →").fg.equals(theme.action),
			).toBe(true);
		} finally {
			await setup.dispose();
		}

		const errorSetup = await paint(
			{
				...UNAVAILABLE,
				lines: [
					{
						id: "status",
						kind: "status",
						text: "Quota unavailable: check the server.",
						tone: "error",
					},
				],
			},
			60,
		);
		try {
			const span = spanFor(errorSetup.captureSpans(), "Quota unavailable");
			expect(span.fg.equals(LAYOUT_THEME.error)).toBe(true);
		} finally {
			await errorSetup.dispose();
		}
	});

	test("view_all_providers_is_clickable_at_every_verified_width", async () => {
		for (const width of [24, 32, 40, 60]) {
			let opened = 0;
			const setup = await testRender(
				() =>
					renderSidebar(TWO_WINDOWS, LAYOUT_THEME, () => {
						opened += 1;
					}),
				{ width, height: 20 },
			);
			try {
				await setup.renderOnce();
				const lines = paintedLines(setup.captureCharFrame());
				const linkLine = lines.findIndex((line) =>
					line.includes("View all providers →"),
				);
				expect(linkLine).toBeGreaterThanOrEqual(0);
				expect(lines[linkLine]?.length).toBeLessThanOrEqual(width);
				await setup.mockMouse.click(3, linkLine);
				await setup.renderOnce();
				expect(opened).toBe(1);
			} finally {
				await setup.dispose();
			}
		}
	});

	test("repeated_model_and_theme_reconciliation_stays_stable_and_keeps_actions_live", async () => {
		let opened = 0;
		const constructed: unknown[] = [];
		const alternateTheme: SidebarTheme = {
			...LAYOUT_THEME,
			success: RGBA.fromHex("#22aa66"),
		};
		const setup = await testRender(
			() => {
				for (let update = 0; update < 8; update += 1) {
					constructed.push(
						renderSidebar(
							{
								...TWO_WINDOWS,
								provider:
									update % 2 === 1 ? "Ollama Cloud" : "OpenAI · Codex quota",
							},
							update % 2 === 1 ? LAYOUT_THEME : alternateTheme,
							() => {},
						),
					);
				}
				return renderSidebar(
					{ ...TWO_WINDOWS, provider: "Ollama Cloud" },
					LAYOUT_THEME,
					() => {
						opened += 1;
					},
				) as never;
			},
			{ width: 40, height: 20 },
		);
		try {
			await setup.renderOnce();
			expect(constructed.length).toBeGreaterThanOrEqual(8);
			// Every reconciliation created a new renderable; no disposed node was
			// returned twice.
			expect(new Set(constructed).size).toBe(constructed.length);
			const frame = setup.captureCharFrame();
			expect(paintedLines(frame).join(" ")).toContain("Ollama Cloud");
			const spans = setup.captureSpans();
			expect(spanFor(spans, "90% left").fg.equals(LAYOUT_THEME.success)).toBe(
				true,
			);
			expect(spanFor(spans, "9% left").fg.equals(LAYOUT_THEME.warning)).toBe(
				true,
			);

			const linkLine = frame
				.split("\n")
				.findIndex((line) => line.includes("View all providers →"));
			expect(linkLine).toBeGreaterThanOrEqual(0);
			await setup.mockMouse.click(3, linkLine);
			await setup.renderOnce();
			expect(opened).toBe(1);
		} finally {
			await setup.dispose();
		}
	});

	test("renderer_returns_fresh_static_renderables_without_function_children", async () => {
		let first: unknown;
		let second: unknown;
		const setup = await testRender(
			() => {
				first = renderSidebar(TWO_WINDOWS, LAYOUT_THEME, () => {});
				second = renderSidebar(TWO_WINDOWS, LAYOUT_THEME, () => {});
				return first as never;
			},
			{ width: 40, height: 20 },
		);
		try {
			await setup.renderOnce();
			expect(first).not.toBe(second);
			const children = (first as { getChildren(): unknown[] }).getChildren();
			expect(children.every((child) => typeof child !== "function")).toBe(true);
			expect(children.length).toBeGreaterThan(0);
			const visit = (node: unknown): void => {
				expect(typeof node).not.toBe("function");
				const candidate = node as { getChildren?: () => unknown[] };
				if (typeof candidate.getChildren === "function") {
					for (const child of candidate.getChildren()) {
						visit(child);
					}
				}
			};
			visit(first);
		} finally {
			await setup.dispose();
		}
	});
});

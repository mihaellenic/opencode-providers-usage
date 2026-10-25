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

const OLLAMA_PROVIDER: ProviderSummary = {
	providerID: "ollama",
	name: "Ollama Cloud",
	authMethod: "api-key",
	support: "supported",
	evidence: "live-validated",
};

function productionRead(): QuotaRead {
	return {
		state: "available",
		authSource: "codex-companion",
		sections: [
			{
				scope: "app",
				result: {
					state: "available",
					metrics: [
						{
							kind: "window",
							id: "weekly",
							scope: "app",
							label: "Current app limit",
							windowSeconds: 604_800,
							remainingPercent: 75,
							usedPercent: 25,
							resetsAt: PRODUCTION_NOW + 2 * 86_400_000 + 4 * 3_600_000,
						},
						{
							kind: "window",
							id: "five-hour",
							scope: "app",
							label: "Current app limit",
							windowSeconds: 18_000,
							remainingPercent: 41,
							usedPercent: 59,
							resetsAt: PRODUCTION_NOW + 8 * 3_600_000,
						},
					],
					fetchedAt: PRODUCTION_NOW - 30_000,
					expiresAt: PRODUCTION_NOW + 60_000,
				},
			},
		],
	};
}

function ollamaRead(): QuotaRead {
	return {
		state: "available",
		authSource: "opencode",
		sections: [
			{
				scope: "provider-balance",
				result: {
					state: "available",
					metrics: [
						{
							kind: "money",
							id: "included",
							scope: "provider-balance",
							label: "Included credits",
							currency: "USD",
							remaining: 35.03,
							allowance: 60,
							resetsAt: PRODUCTION_NOW + 25 * 86_400_000 + 15 * 3_600_000,
						},
						{
							kind: "money",
							id: "purchased",
							scope: "provider-balance",
							label: "Purchased credits",
							currency: "USD",
							remaining: 4.27,
						},
						{
							kind: "money",
							id: "total",
							scope: "provider-balance",
							label: "Total credits",
							currency: "USD",
							remaining: 39.31,
						},
					],
					fetchedAt: PRODUCTION_NOW - 12_000,
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
			id: "app-5h",
			kind: "window",
			label: "5h",
			value: { text: "59%", tone: "normal" },
			fill: 0.59,
			reset: "resets 8h",
		},
		{
			id: "app-7d",
			kind: "window",
			label: "7d",
			value: { text: "25%", tone: "normal" },
			fill: 0.25,
			reset: "resets 2d 4h",
		},
	],
};

const COMPLETE_CREDITS: SidebarModel = {
	provider: "Ollama Cloud",
	lines: [
		{
			id: "included",
			kind: "bar",
			fill: (60 - 35.03) / 60,
			percent: { text: "41.6%", tone: "normal" },
			reset: "resets 25d 15h",
		},
		{
			id: "included-stats",
			kind: "pair",
			left: { text: "$24.97 / $60.00 used", tone: "normal" },
			right: { text: "+$4.27 credits", tone: "normal" },
			metricIDs: ["included", "purchased", "total"],
		},
	],
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
};

const LONG_CUSTOM_LABELS: SidebarModel = {
	provider: "A very long arbitrary provider name",
	lines: [
		{
			id: "custom-long",
			kind: "window",
			label: "7d · Custom daily window",
			value: { text: "55%", tone: "normal" },
			fill: 0.55,
			reset: "resets 2d 4h",
		},
		{
			id: "unknown-long",
			kind: "window",
			label: "5h",
			value: { text: "Unknown (not reported)", tone: "muted" },
		},
	],
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
			" OpenAI · Codex quota",
			" 5h ━━━━━━━━━━━━━━━━━━━━━━━───────────────── 59% · resets 8h",
			" 7d ━━━━━━━━━──────────────────────────── 25% · resets 2d 4h",
		]);
		expect(await capture(TWO_WINDOWS, 40)).toEqual([
			" OpenAI · Codex quota",
			" 5h ━━━━━━━━━━━───────── 59% · resets 8h",
			" 7d ━━━━───────────── 25% · resets 2d 4h",
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
		expect(windows.map((line) => line.label)).toEqual(["5h", "7d"]);
		expect(windows.map((line) => line.value)).toEqual([
			{ text: "59%", tone: "normal" },
			{ text: "25%", tone: "normal" },
		]);
		expect(windows.map((line) => line.fill)).toEqual([0.59, 0.25]);
		const resets = windows
			.map((line) => line.reset)
			.filter((reset): reset is string => reset !== undefined);
		expect(resets).toEqual(["resets 8h", "resets 2d 4h"]);

		expect(await capture(model, 40)).toEqual([
			" OpenAI · Codex quota",
			" 5h ━━━━━━━━━━━───────── 59% · resets 8h",
			" 7d ━━━━───────────── 25% · resets 2d 4h",
		]);

		for (const width of [24, 32, 40, 60]) {
			const setup = await paint(model, width);
			try {
				const frame = setup.captureCharFrame();
				const lines = paintedLines(frame);
				expect(lines.every((line) => line.length <= width)).toBe(true);
				const squashed = frame.replace(/\s+/g, "");
				for (const reset of resets) {
					// A reset countdown may move under the bar at narrow widths, but
					// every word stays painted and readable.
					expect(squashed).toContain(reset.replace(/\s+/g, ""));
				}
				expect(frame).toContain("59%");
				expect(frame).toContain("25%");
			} finally {
				await setup.dispose();
			}
		}
	});

	test("production_ollama_credits_render_the_used_bar_and_stat_row", async () => {
		const model = buildSidebarModel(
			OLLAMA_PROVIDER,
			ollamaRead(),
			PRODUCTION_LOCALE,
			PRODUCTION_NOW,
		);
		expect(model.lines[0]).toMatchObject({
			kind: "bar",
			reset: "resets 25d 15h",
			percent: { text: "41.6%", tone: "normal" },
		});
		expect(model.lines[1]).toMatchObject({
			kind: "pair",
			left: { text: "US$24.97 / US$60.00 used", tone: "normal" },
			right: { text: "+US$4.27 credits", tone: "normal" },
			metricIDs: ["included", "purchased", "total"],
		});
		const frame = await capture(model, 40);
		expect(frame).toEqual([
			" Ollama Cloud",
			" ━━━━━━────────── 41.6% · resets 25d 15h",
			" US$24.97 / US$60.00 used",
			" +US$4.27 credits",
		]);
		expect(frame.join("\n")).not.toContain("updated");
		expect(frame.join("\n")).not.toContain("Purchased");
		expect(frame.join("\n")).not.toContain("Total");
	});

	test("32_and_24_columns_preserve_every_value_and_reset_without_clipping", async () => {
		expect(await capture(TWO_WINDOWS, 32)).toEqual([
			" OpenAI · Codex quota",
			" 5h ━━━━━━━───── 59% · resets 8h",
			" 7d ━━─────── 25% · resets 2d 4h",
		]);
		expect(await capture(TWO_WINDOWS, 24)).toEqual([
			" OpenAI · Codex quota",
			" 5h ━━── 59% · resets 8h",
			" 7d ─ 25% · resets 2d 4h",
		]);

		for (const width of [24, 32, 40, 60]) {
			const lines = await capture(TWO_WINDOWS, width);
			expect(lines.every((line) => line.length <= width)).toBe(true);
			const painted = lines.join("\n").replace(/[│\s]+/g, "");
			for (const text of [
				"OpenAI · Codex quota",
				"5h",
				"59%",
				"resets 8h",
				"7d",
				"25%",
				"resets 2d 4h",
			]) {
				expect(painted).toContain(text.replace(/\s+/g, ""));
			}
			expect(painted).not.toContain("updated");
			expect(painted).not.toContain("Europe/Stockholm");
			expect(painted).not.toContain("Viewallproviders");
		}
	});

	test("long_custom_labels_and_values_wrap_without_clipping_at_every_width", async () => {
		for (const width of [24, 32, 40, 60]) {
			const lines = await capture(LONG_CUSTOM_LABELS, width);
			expect(lines.every((line) => line.length <= width)).toBe(true);
			const painted = lines.join("\n").replace(/[│\s]+/g, "");
			for (const text of [
				"A very long arbitrary provider name",
				"7d ·",
				"Customdaily",
				"window",
				"55%",
				"resets 2d 4h",
				"5h",
				"Unknown (not reported)",
			]) {
				expect(painted).toContain(text.replace(/\s+/g, ""));
			}
			expect(painted).not.toContain("updated");
			expect(painted).not.toContain("Viewallproviders");
		}
	});

	test("long_custom_layout_keeps_intrinsic_columns_wide_and_wraps_only_when_narrow", async () => {
		expect(await capture(LONG_CUSTOM_LABELS, 60)).toEqual([
			" A very long arbitrary provider name",
			" 7d · Custom daily window ━━━━━━━━─────── 55% · resets 2d 4h",
			" 5h Unknown (not reported)",
		]);
		expect(await capture(LONG_CUSTOM_LABELS, 24)).toEqual([
			" A very long arbitrary",
			" provider name",
			" 7d · Custom daily  ━━──",
			" window",
			" 55% · resets 2d 4h",
			" 5h",
			" Unknown (not reported)",
		]);
	});

	test("window_bars_share_compact_label_and_reset_edges_at_normal_widths", async () => {
		const lines = await capture(TWO_WINDOWS, 60);
		expect(lines[1]?.startsWith(" 5h ")).toBe(true);
		expect(lines[2]?.startsWith(" 7d ")).toBe(true);
		expect(lines[1]?.indexOf("59%")).toBeGreaterThan(4);
		expect(lines[2]?.indexOf("25%")).toBeGreaterThan(4);
		expect(lines[1]?.endsWith("resets 8h")).toBe(true);
		expect(lines[2]?.endsWith("resets 2d 4h")).toBe(true);
		expect(lines[1]?.length).toBe(60);
		expect(lines[2]?.length).toBe(60);
	});

	test("credit_bar_pair_and_status_rows_stay_compact_and_truthful", async () => {
		expect(await capture(COMPLETE_CREDITS, 60)).toEqual([
			" Ollama Cloud",
			" ━━━━━━━━━━━━━━────────────────────── 41.6% · resets 25d 15h",
			" $24.97 / $60.00 used                         +$4.27 credits",
		]);
		expect(await capture(COMPLETE_CREDITS, 24)).toEqual([
			" Ollama Cloud",
			" ━━━━━━━────────── 41.6%",
			" · resets 25d 15h",
			" $24.97 / $60.00 used",
			" +$4.27 credits",
		]);
		expect(await capture(UNAVAILABLE, 32)).toEqual([
			" OpenCode / Zen",
			" Quota unavailable: no quota",
			" source is validated for this",
			" provider.",
		]);
	});

	test("full_and_empty_bars_paint_only_their_own_segment", async () => {
		const bar = (fill: number, percent: string): SidebarModel => ({
			provider: "Ollama Cloud",
			lines: [
				{
					id: "bar",
					kind: "bar",
					fill,
					percent: { text: percent, tone: fill >= 1 ? "error" : "normal" },
				},
			],
		});

		const empty = (await capture(bar(0, "0%"), 40)).join("\n");
		expect(empty).toContain("─");
		expect(empty).not.toContain("━");
		expect(empty).toContain("0%");

		const full = (await capture(bar(1, "100%"), 40)).join("\n");
		expect(full).toContain("━");
		expect(full).not.toContain("─");
		expect(full).toContain("100%");
	});

	test("window_used_fill_paints_a_distinct_proportional_base_run_for_both_percent_paths", async () => {
		const read = (percent: {
			remainingPercent?: number;
			usedPercent?: number;
		}): QuotaRead => ({
			state: "available",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							{
								kind: "window",
								id: "five-hour",
								scope: "app",
								label: "Current app limit",
								windowSeconds: 18_000,
								...percent,
								resetsAt: PRODUCTION_NOW + 3_600_000,
							},
						],
						fetchedAt: PRODUCTION_NOW - 1000,
						expiresAt: PRODUCTION_NOW + 60_000,
					},
				},
			],
		});

		for (const quota of [
			read({ remainingPercent: 33 }),
			read({ usedPercent: 67 }),
		]) {
			const model = buildSidebarModel(
				OPENAI_PROVIDER,
				quota,
				PRODUCTION_LOCALE,
				PRODUCTION_NOW,
			);
			expect(model.lines[0]).toMatchObject({
				kind: "window",
				fill: 0.67,
				value: { text: "67%", tone: "normal" },
			});

			const setup = await paint(model, 60);
			try {
				const line = paintedLines(setup.captureCharFrame())[1];
				expect(line).toBeDefined();
				expect(line).toContain("67%");
				const barStart = line?.indexOf("━") ?? -1;
				const percentAt = line?.indexOf("67%") ?? -1;
				expect(barStart).toBeGreaterThan(0);
				expect(percentAt).toBeGreaterThan(barStart);
				const bar = line?.slice(barStart, percentAt).trimEnd() ?? "";
				const used = (bar.match(/━/g) ?? []).length;
				const remaining = (bar.match(/─/g) ?? []).length;
				expect(used).toBeGreaterThan(0);
				expect(remaining).toBeGreaterThan(0);
				expect(used / (used + remaining)).toBeCloseTo(0.67, 1);

				const spans = setup.captureSpans();
				expect(spanFor(spans, "━").fg.equals(LAYOUT_THEME.base)).toBe(true);
				expect(spanFor(spans, "─").fg.equals(LAYOUT_THEME.muted)).toBe(true);
				expect(spanFor(spans, "67%").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			} finally {
				await setup.dispose();
			}
		}
	});

	test("titles_stay_bright_while_rows_stay_dim_and_percent_tones_hold", async () => {
		const setup = await paint(TWO_WINDOWS, 60);
		try {
			const frame = setup.captureSpans();
			const theme = LAYOUT_THEME;
			expect(spanFor(frame, "OpenAI · Codex quota").fg.equals(theme.base)).toBe(
				true,
			);
			expect(spanFor(frame, "5h").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "7d").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "59%").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "25%").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "━").fg.equals(theme.base)).toBe(true);
			expect(spanFor(frame, "─").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "· resets 8h").fg.equals(theme.muted)).toBe(true);
			expect(spanFor(frame, "· resets 2d 4h").fg.equals(theme.muted)).toBe(
				true,
			);
		} finally {
			await setup.dispose();
		}

		const warningWindow = await paint(
			{
				provider: "OpenAI · Codex quota",
				lines: [
					{
						id: "warning-window",
						kind: "window",
						label: "5h",
						value: { text: "90%", tone: "warning" },
						fill: 0.9,
						reset: "resets 8h",
					},
				],
			},
			60,
		);
		try {
			const frame = warningWindow.captureSpans();
			expect(spanFor(frame, "90%").fg.equals(LAYOUT_THEME.warning)).toBe(true);
			expect(spanFor(frame, "5h").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			expect(spanFor(frame, "━").fg.equals(LAYOUT_THEME.base)).toBe(true);
			expect(spanFor(frame, "· resets 8h").fg.equals(LAYOUT_THEME.muted)).toBe(
				true,
			);
		} finally {
			await warningWindow.dispose();
		}

		const barSetup = await paint(COMPLETE_CREDITS, 60);
		try {
			const frame = barSetup.captureSpans();
			// The bar segments, reset note, stat amounts, and neutral percent are
			// all dimmed; only a threshold percent keeps its semantic color.
			expect(spanFor(frame, "━").fg.equals(LAYOUT_THEME.base)).toBe(true);
			expect(spanFor(frame, "─").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			expect(spanFor(frame, "41.6%").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			expect(
				spanFor(frame, "· resets 25d 15h").fg.equals(LAYOUT_THEME.muted),
			).toBe(true);
			expect(
				spanFor(frame, "$24.97 / $60.00 used").fg.equals(LAYOUT_THEME.muted),
			).toBe(true);
			expect(
				spanFor(frame, "+$4.27 credits").fg.equals(LAYOUT_THEME.muted),
			).toBe(true);
		} finally {
			await barSetup.dispose();
		}

		const lowQuota = await paint(
			{
				provider: "Ollama Cloud",
				lines: [
					{
						id: "included",
						kind: "bar",
						fill: 0.924,
						percent: { text: "92.4%", tone: "warning" },
						reset: "resets 15h 30m",
					},
					{
						id: "included-stats",
						kind: "pair",
						left: { text: "$55.44 / $60.00 used", tone: "normal" },
						right: { text: "+$4.27 credits", tone: "normal" },
						metricIDs: ["included"],
					},
				],
			},
			60,
		);
		try {
			const frame = lowQuota.captureSpans();
			expect(spanFor(frame, "92.4%").fg.equals(LAYOUT_THEME.warning)).toBe(
				true,
			);
			expect(spanFor(frame, "━").fg.equals(LAYOUT_THEME.base)).toBe(true);
			expect(spanFor(frame, "─").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			expect(
				spanFor(frame, "$55.44 / $60.00 used").fg.equals(LAYOUT_THEME.muted),
			).toBe(true);
			expect(
				spanFor(frame, "+$4.27 credits").fg.equals(LAYOUT_THEME.muted),
			).toBe(true);
		} finally {
			await lowQuota.dispose();
		}

		const exhausted = await paint(
			{
				provider: "Ollama Cloud",
				lines: [
					{
						id: "included",
						kind: "bar",
						fill: 1,
						percent: { text: "100%", tone: "error" },
					},
				],
			},
			60,
		);
		try {
			const frame = exhausted.captureSpans();
			expect(spanFor(frame, "100%").fg.equals(LAYOUT_THEME.error)).toBe(true);
			expect(spanFor(frame, "━").fg.equals(LAYOUT_THEME.base)).toBe(true);
		} finally {
			await exhausted.dispose();
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
			expect(span.fg.equals(LAYOUT_THEME.muted)).toBe(true);
		} finally {
			await errorSetup.dispose();
		}
	});

	test("whole_card_is_clickable_at_every_verified_width", async () => {
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
				expect(lines.every((line) => line.length <= width)).toBe(true);
				expect(lines.join(" ")).not.toContain("View all providers");
				// Clicking a body row (not a dedicated link) still opens the page.
				await setup.mockMouse.click(3, 1);
				await setup.renderOnce();
				expect(opened).toBe(1);
				// Clicking the header cell works too.
				await setup.mockMouse.click(3, 0);
				await setup.renderOnce();
				expect(opened).toBe(2);
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
			expect(spanFor(spans, "59%").fg.equals(LAYOUT_THEME.muted)).toBe(true);
			expect(spanFor(spans, "25%").fg.equals(LAYOUT_THEME.muted)).toBe(true);

			expect(frame).not.toContain("View all providers");
			await setup.mockMouse.click(3, 1);
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
			const root = first as unknown as {
				border?: unknown;
				_mouseListeners?: { down?: unknown };
			};
			expect(root.border).toBe(false);
			expect(typeof root._mouseListeners?.down).toBe("function");
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

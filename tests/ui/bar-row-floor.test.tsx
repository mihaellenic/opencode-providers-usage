import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { barRow } from "../../src/ui/bar-row";
import type { SidebarTheme } from "../../src/ui/Sidebar";

const color = RGBA.fromInts(200, 200, 200);
const THEME = {
	base: color,
	muted: color,
	success: color,
	warning: color,
	error: color,
} as unknown as SidebarTheme;

describe("bar row used-glyph geometry", () => {
	test("used_glyphs_are_floor_of_track_times_fill_for_every_width_and_fill", async () => {
		for (const width of [20, 33, 40, 60, 77]) {
			for (let pct = 1; pct <= 99; pct++) {
				const setup = await testRender(
					() =>
						barRow(THEME, {
							id: "b",
							fill: pct / 100,
							percent: { text: "", tone: "normal" },
						}),
					{ width, height: 2 },
				);
				await setup.renderOnce();
				const line = setup.captureCharFrame().split("\n")[0] ?? "";
				await setup.dispose();
				const used = [...line].filter((c) => c === "━").length;
				const track = [...line].filter((c) => c === "━" || c === "─").length;
				expect(track).toBe(width - 2);
				expect(used).toBe(Math.floor((track * pct) / 100));
			}
		}
	});

	async function paint(width: number, fill: number, pct = "") {
		const setup = await testRender(
			() =>
				barRow(THEME, {
					id: "b",
					fill,
					percent: { text: pct, tone: "normal" },
				}),
			{ width, height: 2 },
		);
		await setup.renderOnce();
		const line = setup.captureCharFrame().split("\n")[0] ?? "";
		return { setup, line };
	}
	const count = (line: string, ch: string) =>
		[...line].filter((c) => c === ch).length;

	test("arbitrary_non_centesimal_fills_and_large_widths_floor_exactly", async () => {
		const fills = [
			0,
			1e-9,
			0.004,
			0.0123,
			1 / 3,
			0.5,
			2 / 3,
			0.9876,
			0.999,
			1 - 1e-9,
			1,
		];
		for (const width of [4, 10, 45, 120, 400]) {
			for (const fill of fills) {
				const { setup, line } = await paint(width, fill);
				await setup.dispose();
				const track = width - 2;
				expect([width, fill, count(line, "━") + count(line, "─")]).toEqual([
					width,
					fill,
					track,
				]);
				expect(count(line, "━")).toBe(Math.floor(track * fill));
			}
		}
	});

	test("percent_text_stays_true_and_track_has_no_gaps_or_overflow", async () => {
		const { setup, line } = await paint(40, 0.337, "33.7%");
		await setup.dispose();
		expect(line.endsWith(" 33.7%")).toBe(true);
		const track = line.slice(0, line.length - " 33.7%".length);
		expect(track).toMatch(/^━*─*$/);
		expect([...track].length).toBe(40 - 6);
		expect(count(track, "━")).toBe(Math.floor(34 * 0.337));
	});

	test("resizing_reconverges_to_floor_geometry", async () => {
		const setup = await testRender(
			() =>
				barRow(THEME, {
					id: "b",
					fill: 0.337,
					percent: { text: "", tone: "normal" },
				}),
			{ width: 30, height: 2 },
		);
		await setup.renderOnce();
		for (const width of [80, 17, 61, 200]) {
			setup.resize(width, 2);
			await setup.renderOnce();
			await setup.renderOnce();
			const line = setup.captureCharFrame().split("\n")[0] ?? "";
			expect(count(line, "━") + count(line, "─")).toBe(width - 2);
			expect(count(line, "━")).toBe(Math.floor((width - 2) * 0.337));
			expect(line).toMatch(/^━*─*\s*$/);
		}
		await setup.dispose();
	});
});

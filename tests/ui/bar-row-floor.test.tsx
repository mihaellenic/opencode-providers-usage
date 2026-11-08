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

	test.each([
		[4, 0],
		[4, 1],
		[10, 1e-9],
		[10, 1],
		[20, 0.01],
		[20, 0.5],
		[20, 0.99],
		[33, 0.07],
		[40, 0.5],
		[45, 1 / 3],
		[60, 0.33],
		[77, 0.99],
		[120, 0.9876],
		[400, 0.004],
		[400, 1 - 1e-9],
	])(
		"used_glyphs_are_floor_of_track_times_fill_at_width_%i_fill_%f",
		async (width, fill) => {
			const { setup, line } = await paint(width, fill);
			await setup.dispose();
			const track = width - 2;
			expect(count(line, "━") + count(line, "─")).toBe(track);
			expect(count(line, "━")).toBe(Math.floor(track * fill));
		},
	);

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

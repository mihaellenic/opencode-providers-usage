import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import {
	defaultLocaleContext,
	formatCurrency,
	formatPercent,
} from "../../src/ui/format";
import { UsagePage } from "../../src/ui/UsagePage";

const FIXED_NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const REAL_NOW = Date.now;
const LOCALE = defaultLocaleContext();

// The page reads its locale/timezone from the host process. Freezing the clock
// and deriving every expected string through the same formatters keeps these
// layout tests independent of the developer's TZ/locale.
beforeAll(() => {
	Date.now = () => FIXED_NOW;
});

afterAll(() => {
	Date.now = REAL_NOW;
});

const THEME = {
	base: RGBA.fromHex("#ffffff"),
	muted: RGBA.fromHex("#aaaaaa"),
	success: RGBA.fromHex("#a7d5b2"),
	warning: RGBA.fromHex("#ebc588"),
	error: RGBA.fromHex("#ff3355"),
	action: RGBA.fromHex("#c3a6ef"),
};

const OPENAI: ProviderSummary = {
	providerID: "openai",
	name: "OpenAI",
	authMethod: "oauth",
	support: "requires-companion",
	evidence: "live-validated",
};

const OLLAMA: ProviderSummary = {
	providerID: "ollama",
	name: "Ollama Cloud",
	authMethod: "api-key",
	support: "supported",
	evidence: "live-validated",
};

const ZEN: ProviderSummary = {
	providerID: "zen",
	name: "OpenCode / Zen",
	authMethod: "api-key",
	support: "unsupported",
	evidence: "unverified",
};

const FUTURE: ProviderSummary = {
	providerID: "future-provider",
	name: "Future Provider",
	authMethod: "api-key",
	support: "supported",
	evidence: "documented-only",
};

// Sidebar-style countdowns need future resets; each fixture uses a distinct
// duration so the expected strings stay readable.
const OPENAI_5H_RESET = FIXED_NOW + 8 * 3_600_000;
const OPENAI_WEEK_RESET = FIXED_NOW + 2 * 86_400_000 + 4 * 3_600_000;
const OLLAMA_RESET = FIXED_NOW + 25 * 86_400_000 + 15 * 3_600_000;

function money(value: number): string {
	return formatCurrency(value, LOCALE);
}

function percent(value: number): string {
	return `${formatPercent(value, LOCALE)}%`;
}

type CapturedCommand = {
	id?: string;
	bind?: string;
	run?: () => void | false | Promise<void>;
};

type CapturedLayer = { commands?: readonly CapturedCommand[] };

const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;
const ProviderHost = PluginContextProvider as unknown as (
	props: Record<string, unknown>,
) => unknown;

function mockHostContext() {
	const layers: CapturedLayer[] = [];
	const theme = {
		text: {
			base: THEME.base,
			muted: THEME.muted,
			faint: THEME.muted,
			action: {
				primary: { base: THEME.action },
			},
			feedback: {
				error: { base: THEME.error, muted: THEME.error },
				warning: { base: THEME.warning, muted: THEME.warning },
				success: { base: THEME.success, muted: THEME.success },
				info: { base: THEME.action, muted: THEME.action },
			},
		},
	};
	const context = {
		theme,
		keymap: {
			layer(factory: () => CapturedLayer) {
				layers.push(factory());
			},
		},
	};
	return { context, layers };
}

function pageFixtures(): {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
} {
	const fetchedAt = Date.now() - 30_000;
	return {
		providers: [OPENAI, OLLAMA, ZEN],
		quotaByProvider: {
			openai: {
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
									label: "5-hour window",
									windowSeconds: 18_000,
									remainingPercent: 0,
									resetsAt: OPENAI_5H_RESET,
								},
								{
									kind: "window",
									id: "weekly",
									scope: "app",
									label: "Weekly window",
									windowSeconds: 604_800,
									remainingPercent: 84,
									resetsAt: OPENAI_WEEK_RESET,
								},
							],
							fetchedAt,
							expiresAt: fetchedAt + 120_000,
						},
					},
				],
			},
			ollama: {
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
									remaining: 50.1,
									allowance: 60,
									resetsAt: OLLAMA_RESET,
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
									remaining: 54.37,
								},
							],
							fetchedAt,
							expiresAt: fetchedAt + 120_000,
						},
					},
				],
			},
			zen: {
				state: "not-applicable",
				reason: "no_validated_quota_source",
				attemptedAt: fetchedAt,
			},
		},
	};
}

async function renderPage(options: {
	width: number;
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
}) {
	const { context } = mockHostContext();
	const setup = await testRender(
		() =>
			jsx(ProviderHost, {
				value: context as never,
				get children() {
					return jsx(UsagePageHost, {
						providers: options.providers,
						quotaByProvider: options.quotaByProvider,
						refresh: () => {},
						back: () => {},
					});
				},
			}),
		{ width: options.width, height: 60 },
	);
	await setup.renderOnce();
	return setup;
}

function paintedLines(frame: string): string[] {
	return frame
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Frame borders (│) and bar tracks (━ / ─) are painted into the same character
 * grid as the content, so a wrapped label can be separated from its own text by
 * decoration. Drop only those two kinds of chrome before comparing content;
 * every meaningful character survives.
 */
function squash(value: string): string {
	return value.replace(/[│━─]/g, "").replace(/\s+/g, "");
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

type FrameRect = { top: number; bottom: number; left: number; right: number };
type Position = { row: number; col: number };

function charRows(frame: string): string[] {
	return frame.split("\n").map((line) => line.replace(/\s+$/u, ""));
}

function textAt(rows: string[], text: string): Position {
	for (let row = 0; row < rows.length; row += 1) {
		const col = (rows[row] ?? "").indexOf(text);
		if (col !== -1) {
			return { row, col };
		}
	}
	throw new Error(`painted frame is missing ${JSON.stringify(text)}`);
}

/**
 * Locate the single-line box that surrounds a painted label by walking the
 * actual frame character grid. This deliberately ignores component props and
 * styles: a border only counts when corner, horizontal, and vertical glyphs
 * are painted at the captured coordinates.
 */
function cardFrame(rows: string[], label: string): FrameRect {
	const anchor = textAt(rows, label);
	const anchorLine = rows[anchor.row] ?? "";
	const left = anchorLine.lastIndexOf("│", anchor.col - 1);
	const right = anchorLine.indexOf("│", anchor.col + label.length);
	if (left === -1 || right === -1) {
		throw new Error(
			`no single-line card border surrounds ${JSON.stringify(label)} on row ${anchor.row}`,
		);
	}

	let top = -1;
	for (let row = anchor.row; row >= 0; row -= 1) {
		if (rows[row]?.[left] === "┌" && rows[row]?.[right] === "┐") {
			top = row;
			break;
		}
	}
	if (top === -1) {
		throw new Error(
			`card ${JSON.stringify(label)} has no top border above row ${anchor.row}`,
		);
	}

	let bottom = -1;
	for (let row = anchor.row; row < rows.length; row += 1) {
		if (rows[row]?.[left] === "└" && rows[row]?.[right] === "┘") {
			bottom = row;
			break;
		}
	}
	if (bottom === -1) {
		throw new Error(
			`card ${JSON.stringify(label)} has no bottom border below row ${anchor.row}`,
		);
	}

	const topBorder = (rows[top] ?? "").slice(left, right + 1);
	const bottomBorder = (rows[bottom] ?? "").slice(left, right + 1);
	if (!/^┌─+┐$/.test(topBorder) || !/^└─+┘$/.test(bottomBorder)) {
		throw new Error(
			`card ${JSON.stringify(label)} is not framed by single-line box drawing`,
		);
	}
	for (let row = top + 1; row < bottom; row += 1) {
		if (rows[row]?.[left] !== "│" || rows[row]?.[right] !== "│") {
			throw new Error(
				`card ${JSON.stringify(label)} frame has a gap on row ${row}`,
			);
		}
	}

	return { top, bottom, left, right };
}

function textInFrame(rows: string[], frame: FrameRect, text: string): Position {
	for (let row = frame.top + 1; row < frame.bottom; row += 1) {
		const col = (rows[row] ?? "").indexOf(text, frame.left + 1);
		if (col !== -1 && col + text.length <= frame.right) {
			return { row, col };
		}
	}
	throw new Error(
		`card frame ${JSON.stringify(frame)} does not fully paint ${JSON.stringify(text)}`,
	);
}

/**
 * Interior text of one card, squashed so a value wrapped across rows still
 * reads as one token while borders and padding are excluded.
 */
function frameContent(rows: string[], frame: FrameRect): string {
	return squash(
		rows
			.slice(frame.top + 1, frame.bottom)
			.map((line) => line.slice(frame.left + 1, frame.right))
			.join("\n"),
	);
}

describe("usage page card layout", () => {
	test("renders page chrome, per-provider cards, bars, resets, and footer", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({ width: 60, ...fixtures });
		try {
			const frame = setup.captureCharFrame();
			const lines = paintedLines(frame);
			const content = squash(frame);

			expect(lines).toContain("Provider usage");
			expect(lines).toContain("Connected accounts · quota & balances");
			const openaiHeader = lines.find((line) => line.includes("OpenAI"));
			expect(openaiHeader).toBeDefined();
			expect(openaiHeader).not.toContain("Updated");
			const ollamaHeader = lines.find((line) => line.includes("Ollama Cloud"));
			expect(ollamaHeader).toBeDefined();
			expect(ollamaHeader).not.toContain("Updated");

			// Labels share their row with the bar track, so compare the painted
			// content with the framing/track glyphs removed rather than raw rows.
			expect(content).toContain(squash("5h"));
			expect(content).toContain(squash("7d"));
			expect(content).toContain(squash(percent(100)));
			expect(content).toContain(squash(percent(16)));
			expect(content).toContain(squash("resets 8h"));
			expect(content).toContain(squash("resets 2d 4h"));
			expect(content).toContain(
				squash(`${money(60 - 50.1)} / ${money(60)} used`),
			);
			expect(content).toContain(squash(`+${money(4.27)} credits`));
			expect(content).toContain(squash("resets 25d 15h"));
			expect(content).not.toContain(squash("Total credits"));
			expect(content).not.toContain(squash("Configured app cap"));
			expect(content).toContain(squash("[esc] back   [ctrl+r] refresh"));

			expect(frame).toContain("━");
			expect(frame).toContain("─");

			for (const forbidden of [
				"Auth source",
				"supported ·",
				"Account-wide",
				"Subscription allowance",
				"Prototype only",
			]) {
				expect(frame).not.toContain(forbidden);
			}

			const spans = setup.captureSpans();
			expect(spanFor(spans, "Provider usage").fg.equals(THEME.base)).toBe(true);
			expect(spanFor(spans, "Connected accounts").fg.equals(THEME.muted)).toBe(
				true,
			);
			expect(spanFor(spans, "OpenAI").fg.equals(THEME.base)).toBe(true);
			expect(spanFor(spans, percent(100)).fg.equals(THEME.error)).toBe(true);
			expect(spanFor(spans, percent(16)).fg.equals(THEME.muted)).toBe(true);
			expect(spanFor(spans, "━").fg.equals(THEME.base)).toBe(true);
			expect(spanFor(spans, "─").fg.equals(THEME.muted)).toBe(true);
			expect(spanFor(spans, "[esc] back").fg.equals(THEME.muted)).toBe(true);
		} finally {
			await setup.dispose();
		}
	});

	test("preserves every token and stays within 24 columns when narrow", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({ width: 24, ...fixtures });
		try {
			const rawLines = setup
				.captureCharFrame()
				.split("\n")
				.map((line) => line.trimEnd());
			expect(rawLines.every((line) => line.length <= 24)).toBe(true);

			const raw = rawLines.join("\n");
			const content = squash(raw);
			for (const token of [
				"Provider usage",
				"Connected accounts · quota & balances",
				"OpenAI",
				"5h",
				"7d",
				percent(100),
				percent(16),
				"resets 8h",
				"resets 2d 4h",
				"Ollama Cloud",
				percent(16.5),
				`${money(60 - 50.1)} / ${money(60)} used`,
				`+${money(4.27)} credits`,
				"resets 25d 15h",
				"[esc] back",
				"[ctrl+r] refresh",
			]) {
				expect(content).toContain(squash(token));
			}
			expect(raw).toContain("━");
			expect(raw).toContain("─");
		} finally {
			await setup.dispose();
		}
	});

	test("hides source-less provider cards while keeping populated ones", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({
			width: 120,
			...fixtures,
			providers: [OPENAI, ZEN, OLLAMA],
			quotaByProvider: {
				...fixtures.quotaByProvider,
				zen: {
					state: "unsupported",
					reason: "no_validated_quota_source",
					attemptedAt: Date.now() - 30_000,
				},
			},
		});
		try {
			const frame = setup.captureCharFrame();
			expect(frame).toContain("OpenAI");
			expect(frame).toContain("Ollama Cloud");
			expect(frame).not.toContain("OpenCode / Zen");
			expect(frame).not.toContain("Quota unavailable");
		} finally {
			await setup.dispose();
		}
	});

	test("hides an unsupported provider card entirely", async () => {
		const setup = await renderPage({
			width: 60,
			providers: [ZEN],
			quotaByProvider: {
				zen: {
					state: "unsupported",
					reason: "no_validated_quota_source",
					attemptedAt: Date.now() - 30_000,
				},
			},
		});
		try {
			const frame = setup.captureCharFrame();
			expect(frame).not.toContain("OpenCode / Zen");
			expect(frame).not.toContain("Quota unavailable");
			expect(frame).toContain("Provider usage");
		} finally {
			await setup.dispose();
		}
	});

	test("renders a missing read as pending without an update cell", async () => {
		const setup = await renderPage({
			width: 60,
			providers: [FUTURE],
			quotaByProvider: {},
		});
		try {
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Future Provider");
			expect(frame).toContain("Not loaded yet. Refresh to load.");
			expect(frame).not.toContain("Updated");
			expect(frame).not.toContain("Last attempt");
		} finally {
			await setup.dispose();
		}
	});

	test("keeps the empty page branch", async () => {
		const setup = await renderPage({
			width: 60,
			providers: [],
			quotaByProvider: {},
		});
		try {
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Provider usage");
			expect(frame).toContain("No connected providers.");
		} finally {
			await setup.dispose();
		}
	});

	test("at 180 columns frames OPENAI and OLLAMA side by side above a full-width ZEN card when input interleaves ZEN", async () => {
		const fixtures = pageFixtures();
		// ZEN is source-less, so the page intentionally groups it last while
		// preserving the input order within each group. Listing it between the
		// available providers must not disturb OpenAI-then-Ollama side by side.
		const setup = await renderPage({
			width: 180,
			...fixtures,
			providers: [OPENAI, ZEN, OLLAMA],
		});
		try {
			const rows = charRows(setup.captureCharFrame());
			expect(rows.every((line) => line.length <= 180)).toBe(true);

			const openai = cardFrame(rows, "OpenAI");
			const ollama = cardFrame(rows, "Ollama Cloud");
			const zen = cardFrame(rows, "OpenCode / Zen");

			expect(openai.top).toBe(ollama.top);
			expect(openai.bottom).toBe(ollama.bottom);
			expect(openai.right).toBeLessThan(ollama.left);
			expect(ollama.left).toBeGreaterThan(openai.left);

			const openaiWidth = openai.right - openai.left;
			const ollamaWidth = ollama.right - ollama.left;
			expect(openaiWidth).toBeGreaterThan(20);
			expect(Math.abs(openaiWidth - ollamaWidth)).toBeLessThanOrEqual(1);

			const openaiName = textInFrame(rows, openai, "OpenAI");
			const ollamaName = textInFrame(rows, ollama, "Ollama Cloud");
			expect(openaiName.row).toBe(ollamaName.row);
			expect(openaiName.row - openai.top).toBe(ollamaName.row - ollama.top);

			// No page-only update row: the first painted body row after padding
			// is the widget's bar row for both cards.
			expect(frameContent(rows, openai)).toContain(squash("5h"));
			expect(frameContent(rows, ollama)).toContain(squash(percent(16.5)));
			expect(frameContent(rows, openai)).not.toContain("Updated");
			expect(frameContent(rows, ollama)).not.toContain("Total credits");

			expect(zen.top).toBeGreaterThan(openai.bottom);
			expect(zen.top).toBeGreaterThan(ollama.bottom);
			expect(zen.left).toBe(openai.left);
			expect(zen.right).toBe(ollama.right);
			expect(zen.right - zen.left).toBeGreaterThan(openaiWidth);
			expect(zen.right - zen.left).toBeGreaterThan(ollamaWidth);

			const unavailable = textInFrame(rows, zen, "Quota not applicable");
			expect(unavailable.row).toBeGreaterThan(zen.top);
		} finally {
			await setup.dispose();
		}
	});

	test("at 240 columns bounds the page at 180 columns and keeps at most two card columns", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({
			width: 240,
			...fixtures,
			providers: [OPENAI, OLLAMA, FUTURE, ZEN],
		});
		try {
			const rows = charRows(setup.captureCharFrame());
			expect(rows.every((line) => line.length <= 240)).toBe(true);

			// The page caps itself at 180 columns; no painted row (cards, chrome,
			// or footer) may spill past that bound even on a wider terminal.
			expect(rows.every((line) => line.length <= 180)).toBe(true);

			const openai = cardFrame(rows, "OpenAI");
			const ollama = cardFrame(rows, "Ollama Cloud");
			const zen = cardFrame(rows, "OpenCode / Zen");

			expect(
				Math.max(openai.right, ollama.right, zen.right),
			).toBeLessThanOrEqual(179);

			// Two columns at most: OpenAI and Ollama share a row, then the
			// third quota card wraps instead of forming a third column.
			const future = cardFrame(rows, "Future Provider");
			expect(openai.top).toBe(ollama.top);
			expect(openai.right - openai.left + 1).toBe(56);
			expect(ollama.right - ollama.left + 1).toBe(56);
			expect(openai.right).toBeLessThan(ollama.left);
			expect(future.top).toBeGreaterThan(openai.bottom);
			expect(future.top).toBeGreaterThan(ollama.bottom);
			expect(future.left).toBe(openai.left);
			expect(future.right).toBe(openai.right);
			expect(zen.top).toBeGreaterThan(future.bottom);
			expect(zen.top).toBeGreaterThan(openai.bottom);
			expect(zen.top).toBeGreaterThan(ollama.bottom);
			expect(zen.left).toBe(openai.left);
			expect(zen.right).toBe(ollama.right);
			expect(zen.right - zen.left).toBeGreaterThan(openai.right - openai.left);
			expect(zen.right - zen.left).toBeGreaterThan(ollama.right - ollama.left);
		} finally {
			await setup.dispose();
		}
	});

	test("at 120 columns keeps OPENAI and OLLAMA side by side above a full-width ZEN card", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({ width: 120, ...fixtures });
		try {
			const rows = charRows(setup.captureCharFrame());
			expect(rows.every((line) => line.length <= 120)).toBe(true);

			const openai = cardFrame(rows, "OpenAI");
			const ollama = cardFrame(rows, "Ollama Cloud");
			const zen = cardFrame(rows, "OpenCode / Zen");

			// Medium width must still fit a two-column grid: side-by-side cards
			// share both their top and bottom edge.
			expect(openai.top).toBe(ollama.top);
			expect(openai.bottom).toBe(ollama.bottom);
			expect(openai.right).toBeLessThan(ollama.left);
			expect(ollama.left).toBeGreaterThan(openai.left);

			const openaiWidth = openai.right - openai.left;
			const ollamaWidth = ollama.right - ollama.left;
			expect(Math.abs(openaiWidth - ollamaWidth)).toBeLessThanOrEqual(1);

			// The source-less card spans the full grid below both columns.
			expect(zen.top).toBeGreaterThan(openai.bottom);
			expect(zen.top).toBeGreaterThan(ollama.bottom);
			expect(zen.left).toBe(openai.left);
			expect(zen.right).toBe(ollama.right);
			expect(zen.right - zen.left).toBeGreaterThan(openaiWidth);
			expect(zen.right - zen.left).toBeGreaterThan(ollamaWidth);

			// Provider names stay whole inside the narrower cards.
			for (const [label, frame] of [
				["OpenAI", openai],
				["Ollama Cloud", ollama],
			] as const) {
				const name = textInFrame(rows, frame, label);
				expect(name.col + label.length).toBeLessThan(frame.right);
			}

			// Values may wrap in the narrower cards, but every semantic token
			// remains painted inside its own card.
			const openaiContent = frameContent(rows, openai);
			expect(openaiContent).toContain(squash("5h"));
			expect(openaiContent).toContain(squash("7d"));
			expect(openaiContent).toContain(squash(percent(100)));
			expect(openaiContent).toContain(squash(percent(16)));
			expect(openaiContent).toContain(squash("resets 8h"));
			expect(openaiContent).toContain(squash("resets 2d 4h"));

			const ollamaContent = frameContent(rows, ollama);
			expect(ollamaContent).toContain(squash(percent(16.5)));
			expect(ollamaContent).toContain(
				squash(`${money(60 - 50.1)} / ${money(60)} used`),
			);
			expect(ollamaContent).toContain(squash(`+${money(4.27)} credits`));
			expect(ollamaContent).toContain(squash("resets 25d 15h"));
			expect(ollamaContent).not.toContain(squash("Total credits"));
		} finally {
			await setup.dispose();
		}
	});

	test("at 80 columns stacks framed cards, keeps provider names whole, then paints the footer", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({ width: 80, ...fixtures });
		try {
			const rows = charRows(setup.captureCharFrame());
			expect(rows.every((line) => line.length <= 80)).toBe(true);

			const openai = cardFrame(rows, "OpenAI");
			const ollama = cardFrame(rows, "Ollama Cloud");
			const zen = cardFrame(rows, "OpenCode / Zen");

			expect(openai.bottom).toBeLessThan(ollama.top);
			expect(ollama.bottom).toBeLessThan(zen.top);
			for (const frame of [openai, ollama]) {
				expect(frame.left).toBe(openai.left);
				expect(frame.right).toBe(openai.right);
				expect(frame.right - frame.left + 1).toBe(56);
			}
			expect(zen.left).toBe(openai.left);
			expect(zen.right).toBeGreaterThanOrEqual(openai.right);

			for (const [label, frame] of [
				["OpenAI", openai],
				["Ollama Cloud", ollama],
			] as const) {
				const name = textInFrame(rows, frame, label);
				expect(name.col + label.length).toBeLessThan(frame.right);
				expect(frameContent(rows, frame)).not.toContain("Updated");
			}

			// Card padding keeps painted content one cell clear of every border.
			for (const frame of [openai, ollama, zen]) {
				for (let row = frame.top + 1; row < frame.bottom; row += 1) {
					const line = rows[row] ?? "";
					expect(line[frame.left + 1]).toBe(" ");
					expect(line[frame.right - 1]).toBe(" ");
				}
			}

			const footer = textAt(rows, "[esc] back");
			expect(footer.row).toBeGreaterThan(zen.bottom);

			// The footer's top border is a full-width divider between the cards
			// and the key hints, not a continuation of any card frame.
			const dividerRow = rows.findIndex(
				(line, row) => row > zen.bottom && /^─+$/.test(line.trim()),
			);
			expect(dividerRow).toBeGreaterThan(zen.bottom);
			expect(dividerRow).toBeLessThan(footer.row);
			expect(rows[dividerRow]?.trim().length).toBe(zen.right - zen.left + 1);

			expect(rows.slice(footer.row).join("\n").replace(/\s+/g, "")).toContain(
				"[ctrl+r]refresh",
			);
		} finally {
			await setup.dispose();
		}
	});
});

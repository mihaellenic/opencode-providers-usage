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
	formatResetCompact,
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

// A fixed past year keeps the absolute reset deterministic while still
// exercising the formatter's non-current-year suffix.
const RESET = Date.UTC(2020, 9, 26, 14, 14);

function resetText(): string {
	return `· ${formatResetCompact(RESET, LOCALE, FIXED_NOW)}`;
}

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
		providers: [OPENAI, OLLAMA],
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
									resetsAt: RESET,
								},
								{
									kind: "window",
									id: "weekly",
									scope: "app",
									label: "Weekly window",
									windowSeconds: 604_800,
									remainingPercent: 84,
									resetsAt: RESET,
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
									resetsAt: RESET,
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
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function squash(value: string): string {
	return value.replace(/\s+/g, "");
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

describe("usage page card layout", () => {
	test("renders page chrome, per-provider cards, bars, resets, totals, and footer", async () => {
		const fixtures = pageFixtures();
		const setup = await renderPage({ width: 60, ...fixtures });
		try {
			const frame = setup.captureCharFrame();
			const lines = paintedLines(frame);

			expect(lines).toContain("Provider usage");
			expect(lines).toContain("Connected accounts · quota & balances");
			const openaiHeader = lines.find((line) => line.includes("OpenAI"));
			expect(openaiHeader).toBeDefined();
			expect(openaiHeader).toContain("Updated 30s ago");
			const ollamaHeader = lines.find((line) => line.includes("Ollama Cloud"));
			expect(ollamaHeader).toBeDefined();
			expect(ollamaHeader).toContain("Updated 30s ago");

			expect(frame).toContain("App · 5-hour window");
			expect(frame).toContain("App · Weekly window");
			expect(frame).toContain(percent(100));
			expect(frame).toContain(percent(16));
			expect(frame).toContain(resetText());
			expect(frame).toContain(`${money(60 - 50.1)} / ${money(60)} used`);
			expect(frame).toContain(`+${money(4.27)} credits`);
			const totalLine = lines.find((line) => line.includes("Total credits"));
			expect(totalLine).toBeDefined();
			expect(totalLine).toContain(money(54.37));
			expect(squash(frame)).toContain(squash("[esc] back   [ctrl+r] refresh"));

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
			expect(spanFor(spans, "Updated 30s ago").fg.equals(THEME.success)).toBe(
				true,
			);
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

			const frame = squash(rawLines.join("\n"));
			for (const token of [
				"Provider usage",
				"Connected accounts · quota & balances",
				"OpenAI",
				"Updated 30s ago",
				"App · 5-hour window",
				"App · Weekly window",
				percent(100),
				percent(16),
				resetText(),
				"Ollama Cloud",
				percent(16.5),
				`${money(60 - 50.1)} / ${money(60)} used`,
				`+${money(4.27)} credits`,
				"Total credits",
				money(54.37),
				"[esc] back",
				"[ctrl+r] refresh",
			]) {
				expect(frame).toContain(squash(token));
			}
			expect(frame).toContain("━");
			expect(frame).toContain("─");
		} finally {
			await setup.dispose();
		}
	});

	test("reduces an unsupported provider card to its name and unavailable title", async () => {
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
			expect(frame).toContain("OpenCode / Zen");
			expect(frame).toContain("Quota unavailable");
			expect(frame).not.toContain("no quota source is validated");
			expect(frame).not.toContain("Last attempt");
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
});

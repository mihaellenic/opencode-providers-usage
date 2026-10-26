import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import { UsagePage } from "../../src/ui/UsagePage";

const WIDTH = 80;
const HEIGHT = 24;
const FIXED_NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const REAL_NOW = Date.now;
const PAGE_DOWN = "\x1b[6~";

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

// Four short cards are enough to make the page taller than the default 24-row
// terminal while keeping every card body to two painted rows.
const PROVIDERS: ProviderSummary[] = [
	{
		providerID: "alpha",
		name: "Alpha Provider",
		authMethod: "api-key",
		support: "supported",
		evidence: "documented-only",
	},
	{
		providerID: "bravo",
		name: "Bravo Provider",
		authMethod: "api-key",
		support: "supported",
		evidence: "documented-only",
	},
	{
		providerID: "charlie",
		name: "Charlie Provider",
		authMethod: "api-key",
		support: "supported",
		evidence: "documented-only",
	},
	{
		providerID: "delta",
		name: "Delta Provider",
		authMethod: "api-key",
		support: "supported",
		evidence: "documented-only",
	},
];

const LAST_PROVIDER = PROVIDERS[PROVIDERS.length - 1] as ProviderSummary;
const LAST_METRIC_LABEL = "30d · Delta monthly";
const FOOTER_HINT = "[esc] back";

function quotaFor(provider: ProviderSummary): QuotaRead {
	const index = PROVIDERS.indexOf(provider);
	const fetchedAt = FIXED_NOW - 30_000;
	return {
		state: "available",
		authSource: "opencode",
		sections: [
			{
				scope: "app",
				result: {
					state: "available",
					metrics: [
						{
							kind: "window",
							id: "monthly",
							scope: "app",
							label: `${provider.name.split(" ")[0]} monthly`,
							windowSeconds: 2_592_000,
							remainingPercent: 80 - index * 10,
						},
						{
							kind: "window",
							id: "weekly",
							scope: "app",
							label: `${provider.name.split(" ")[0]} weekly`,
							windowSeconds: 604_800,
							remainingPercent: 60 - index * 10,
						},
					],
					fetchedAt,
					expiresAt: fetchedAt + 120_000,
				},
			},
		],
	};
}

const QUOTA_BY_PROVIDER: Record<string, QuotaRead> = Object.fromEntries(
	PROVIDERS.map((provider) => [provider.providerID, quotaFor(provider)]),
);

function mockHostContext() {
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
	return {
		theme,
		keymap: {
			layer() {},
		},
	};
}

const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;
const ProviderHost = PluginContextProvider as unknown as (
	props: Record<string, unknown>,
) => unknown;

async function renderPage() {
	const context = mockHostContext();
	const setup = await testRender(
		() =>
			jsx(ProviderHost, {
				value: context as never,
				get children() {
					return jsx(UsagePageHost, {
						providers: PROVIDERS,
						quotaByProvider: QUOTA_BY_PROVIDER,
						refresh: () => {},
						back: () => {},
					});
				},
			}),
		{ width: WIDTH, height: HEIGHT },
	);
	await setup.renderOnce();
	return setup;
}

function rowsOf(frame: string): string[] {
	return frame.split("\n").map((line) => line.trimEnd());
}

function findRow(rows: string[], text: string): number {
	const row = rows.findIndex((line) => line.includes(text));
	if (row === -1) {
		throw new Error(
			`rendered frame has no row containing ${JSON.stringify(text)}:\n${rows.join("\n")}`,
		);
	}
	return row;
}

/**
 * The header is usable only when the title and subtitle are both painted in
 * full and on separate rows. When the page shrinks instead of scrolling, Yoga
 * collapses them onto the same row and the title is overwritten.
 */
function expectHeaderVisible(frame: string): void {
	const rows = rowsOf(frame);
	const title = findRow(rows, "Provider usage");
	const subtitle = findRow(rows, "Connected accounts · quota & balances");
	expect(subtitle).toBeGreaterThan(title);
	expect(rows[title]).not.toContain("Connected accounts");
	expect(rows[subtitle]).not.toContain("Provider usage");
}

describe("usage page scrolling at 80x24", () => {
	test("keeps the header fully visible without overlap", async () => {
		const setup = await renderPage();
		try {
			const frame = setup.captureCharFrame();
			expectHeaderVisible(frame);

			const rows = rowsOf(frame);
			const subtitle = findRow(rows, "Connected accounts · quota & balances");
			const alpha = findRow(rows, "Alpha Provider");
			expect(alpha).toBeGreaterThan(subtitle);
			expect(frame).not.toContain(LAST_PROVIDER.name);
			expect(frame).not.toContain(LAST_METRIC_LABEL);
			expect(frame).not.toContain(FOOTER_HINT);
		} finally {
			await setup.dispose();
		}
	});

	test("scrolls to the last provider and footer, then Home restores the top", async () => {
		const setup = await renderPage();
		try {
			const initial = setup.captureCharFrame();
			expectHeaderVisible(initial);
			expect(initial).not.toContain(LAST_PROVIDER.name);
			expect(initial).not.toContain(FOOTER_HINT);

			// PageDown is a real key event, not a direct scrollTop write.
			setup.mockInput.pressKey(PAGE_DOWN);
			await setup.flush();
			const afterPageDown = setup.captureCharFrame();
			expect(afterPageDown).not.toBe(initial);

			// End guarantees the bottom even if the implementation scrolls a
			// custom amount per PageDown.
			setup.mockInput.pressKey("END");
			await setup.flush();
			const bottom = setup.captureCharFrame();
			expect(bottom).toContain(LAST_PROVIDER.name);
			expect(bottom).toContain(LAST_METRIC_LABEL);
			expect(bottom).toContain(FOOTER_HINT);
			expect(bottom).toContain("[ctrl+r] refresh");

			const bottomRows = rowsOf(bottom);
			const lastProvider = findRow(bottomRows, LAST_PROVIDER.name);
			const footer = findRow(bottomRows, FOOTER_HINT);
			expect(footer).toBeGreaterThan(lastProvider);
			expect(bottom).not.toContain("Provider usage");

			setup.mockInput.pressKey("HOME");
			await setup.flush();
			const home = setup.captureCharFrame();
			expect(home).toBe(initial);
			expectHeaderVisible(home);
			expect(home).not.toContain(LAST_PROVIDER.name);
			expect(home).not.toContain(FOOTER_HINT);
		} finally {
			await setup.dispose();
		}
	});
});

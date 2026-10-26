import { describe, expect, test } from "bun:test";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import { defaultLocaleContext, formatCurrency } from "../../src/ui/format";
import { UsagePage } from "../../src/ui/UsagePage";

const LOCALE = defaultLocaleContext();

function money(value: number): string {
	return formatCurrency(value, LOCALE);
}

const OLLAMA: ProviderSummary = {
	providerID: "ollama",
	name: "Ollama Cloud",
	authMethod: "api-key",
	support: "supported",
	evidence: "live-validated",
};

const THEME = {
	base: RGBA.fromHex("#ffffff"),
	muted: RGBA.fromHex("#aaaaaa"),
	success: RGBA.fromHex("#a7d5b2"),
	warning: RGBA.fromHex("#ebc588"),
	error: RGBA.fromHex("#ff3355"),
	action: RGBA.fromHex("#c3a6ef"),
};

const BOX_DRAWING = /[│┃║┌┐└┘├┤┬┴┼╭╮╰╯─━]/gu;

const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;
const ProviderHost = PluginContextProvider as unknown as (
	props: Record<string, unknown>,
) => unknown;

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

function ollamaFixture(): QuotaRead {
	const fetchedAt = Date.now();
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
							remaining: 50.1,
							allowance: 60,
							used: 9.9,
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
	};
}

async function renderOllamaPage(width = 100, height = 40) {
	const setup = await testRender(
		() =>
			jsx(ProviderHost, {
				value: mockHostContext() as never,
				get children() {
					return jsx(UsagePageHost, {
						providers: [OLLAMA],
						quotaByProvider: { ollama: ollamaFixture() },
						refresh: () => {},
						back: () => {},
					});
				},
			}),
		{ width, height },
	);
	await setup.renderOnce();
	return setup;
}

function rowContaining(rows: string[], texts: string[]): number {
	const row = rows.findIndex((line) =>
		texts.every((text) => line.includes(text)),
	);
	if (row === -1) {
		throw new Error(
			`rendered frame has no row containing ${JSON.stringify(texts)}:\n${rows.join("\n")}`,
		);
	}
	return row;
}

function interiorText(line: string): string {
	return line.replace(BOX_DRAWING, "").trim();
}

function readingOrder(frame: string): string {
	return frame.replace(BOX_DRAWING, "").replace(/\s+/gu, "");
}

describe("usage page total credits spacing", () => {
	test("separates the money pair from the Total credits row with one blank interior row at 100 columns", async () => {
		const setup = await renderOllamaPage();
		try {
			const rows = setup
				.captureCharFrame()
				.split("\n")
				.map((line) => line.trimEnd());

			const pairRow = rowContaining(rows, [
				`${money(9.9)} / ${money(60)} used`,
				`+${money(4.27)} credits`,
			]);
			const totalRow = rowContaining(rows, ["Total credits", money(54.37)]);

			expect(totalRow).toBeGreaterThan(pairRow);
			expect(totalRow - pairRow).toBe(2);
			expect(interiorText(rows[pairRow + 1] ?? "")).toBe("");

			const totalLine = rows[totalRow] ?? "";
			const totalAmount = money(54.37);
			expect(totalLine).toContain("Total credits");
			expect(totalLine).toContain(totalAmount);
			expect(totalLine.indexOf(totalAmount)).toBeGreaterThan(
				totalLine.indexOf("Total credits"),
			);
		} finally {
			await setup.dispose();
		}
	});

	test("at 24 columns keeps Total credits wholly before its value in reading order", async () => {
		const setup = await renderOllamaPage(24, 60);
		try {
			const rows = setup
				.captureCharFrame()
				.split("\n")
				.map((line) => line.trimEnd());
			const total = money(54.37);
			const normalized = readingOrder(rows.join("\n"));

			expect(normalized).toContain(`Totalcredits${total}`);
			expect(normalized).not.toContain(`Total${total}credits`);
		} finally {
			await setup.dispose();
		}
	});
});

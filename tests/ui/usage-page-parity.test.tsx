import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import { renderSidebar, type SidebarTheme } from "../../src/ui/Sidebar";
import { buildSidebarModel } from "../../src/ui/sidebar-model";
import { UsagePage } from "../../src/ui/UsagePage";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const LOCALE = { locale: "en-US", timeZone: "UTC" };
const REAL_NOW = Date.now;

beforeAll(() => {
	Date.now = () => NOW;
});

afterAll(() => {
	Date.now = REAL_NOW;
});

const THEME: SidebarTheme = {
	base: RGBA.fromHex("#ffffff"),
	muted: RGBA.fromHex("#aaaaaa"),
	success: RGBA.fromHex("#a7d5b2"),
	warning: RGBA.fromHex("#ebc588"),
	error: RGBA.fromHex("#ff3355"),
	action: RGBA.fromHex("#c3a6ef"),
};

const OPENAI: ProviderSummary = {
	providerID: "openai",
	name: "OpenAI ChatGPT with Codex companion",
	integrationID: "openai",
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

const DISPLAY_NAMES = { openai: "OpenAI" };

// Includes page-only data (a shared-plan section and a configured cap) that the
// sidebar does not render. A parity card must drop it too.
function openaiRead(): QuotaRead {
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
							resetsAt: NOW + 2 * 86_400_000 + 4 * 3_600_000,
						},
						{
							kind: "window",
							id: "five-hour",
							scope: "app",
							label: "Current app limit",
							windowSeconds: 18_000,
							remainingPercent: 41,
							usedPercent: 59,
							resetsAt: NOW + 8 * 3_600_000,
						},
					],
					configuredAppCapPercent: 100,
					fetchedAt: NOW - 30_000,
					expiresAt: NOW + 60_000,
				},
			},
			{
				scope: "shared-plan",
				result: {
					state: "available",
					metrics: [
						{
							kind: "window",
							id: "shared-primary",
							scope: "shared-plan",
							label: "Primary",
							windowSeconds: 18_000,
							remainingPercent: 41,
							resetsAt: NOW + 8 * 3_600_000,
						},
					],
					fetchedAt: NOW - 30_000,
					expiresAt: NOW + 60_000,
				},
			},
		],
	};
}

// Includes the reported total pool that the sidebar folds into its pair row
// instead of rendering as its own line.
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
							resetsAt: NOW + 25 * 86_400_000 + 15 * 3_600_000,
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
					fetchedAt: NOW - 12_000,
					expiresAt: NOW + 60_000,
				},
			},
		],
	};
}

const UsagePageHost = UsagePage as unknown as (
	props: Record<string, unknown>,
) => unknown;
const ProviderHost = PluginContextProvider as unknown as (
	props: Record<string, unknown>,
) => unknown;

function mockHostContext() {
	return {
		theme: {
			text: {
				base: THEME.base,
				muted: THEME.muted,
				faint: THEME.muted,
				action: { primary: { base: THEME.action } },
				feedback: {
					error: { base: THEME.error, muted: THEME.error },
					warning: { base: THEME.warning, muted: THEME.warning },
					success: { base: THEME.success, muted: THEME.success },
					info: { base: THEME.action, muted: THEME.action },
				},
			},
		},
		keymap: { layer() {} },
	};
}

function rowsOf(frame: string): string[] {
	return frame.split("\n").map((line) => line.replace(/\s+$/u, ""));
}

type Rect = { top: number; bottom: number; left: number; right: number };

function cardFrame(rows: string[], label: string): Rect {
	let anchorRow = -1;
	let anchorCol = -1;
	for (let row = 0; row < rows.length; row += 1) {
		const col = (rows[row] ?? "").indexOf(label);
		if (col !== -1) {
			anchorRow = row;
			anchorCol = col;
			break;
		}
	}
	if (anchorRow === -1) throw new Error(`missing card label ${label}`);
	const line = rows[anchorRow] ?? "";
	const left = line.lastIndexOf("│", anchorCol - 1);
	const right = line.indexOf("│", anchorCol + label.length);
	if (left === -1 || right === -1) throw new Error(`unframed card ${label}`);

	let top = -1;
	for (let row = anchorRow; row >= 0; row -= 1) {
		if (rows[row]?.[left] === "┌" && rows[row]?.[right] === "┐") {
			top = row;
			break;
		}
	}
	let bottom = -1;
	for (let row = anchorRow; row < rows.length; row += 1) {
		if (rows[row]?.[left] === "└" && rows[row]?.[right] === "┘") {
			bottom = row;
			break;
		}
	}
	if (top === -1 || bottom === -1) throw new Error(`open card ${label}`);
	return { top, bottom, left, right };
}

function cardBody(rows: string[], label: string): string[] {
	const frame = cardFrame(rows, label);
	const body = rows
		.slice(frame.top + 1, frame.bottom)
		.map((line) => line.slice(frame.left + 1, frame.right))
		.map((line) => line.replace(/^ /u, "").replace(/\s+$/u, ""));
	while (body[0]?.trim() === "") body.shift();
	while (body[body.length - 1]?.trim() === "") body.pop();
	return body;
}

async function sidebarLines(model: ReturnType<typeof buildSidebarModel>) {
	const setup = await testRender(() => renderSidebar(model, THEME, () => {}), {
		width: 53,
		height: 20,
	});
	try {
		await setup.renderOnce();
		return rowsOf(setup.captureCharFrame())
			.map((line) => line.replace(/^ /u, ""))
			.filter((line) => line.length > 0);
	} finally {
		await setup.dispose();
	}
}

describe("usage page cards match the sidebar widgets exactly", () => {
	test("OpenAI card body equals its sidebar widget", async () => {
		const setup = await testRender(
			() =>
				jsx(ProviderHost, {
					value: mockHostContext() as never,
					get children() {
						return jsx(UsagePageHost, {
							providers: [OPENAI, OLLAMA],
							quotaByProvider: {
								openai: openaiRead(),
								ollama: ollamaRead(),
							},
							displayNames: DISPLAY_NAMES,
							refresh: () => {},
							back: () => {},
						});
					},
				}),
			{ width: 120, height: 40 },
		);
		try {
			await setup.renderOnce();
			const rows = rowsOf(setup.captureCharFrame());
			const page = cardBody(rows, "OpenAI");

			const widget = await sidebarLines(
				buildSidebarModel(OPENAI, openaiRead(), LOCALE, NOW, "OpenAI"),
			);
			expect(page).toEqual(widget);

			const all = page.join("\n");
			expect(all).not.toContain("Updated");
			expect(all).not.toContain("Configured app cap");
			expect(all).not.toContain("Shared plan");
			expect(all).not.toContain("resets Oct");
			expect(all).toContain("5h");
			expect(all).toContain("7d");
			expect(all).toContain("59%");
			expect(all).toContain("25%");
		} finally {
			await setup.dispose();
		}
	});

	test("Ollama card body equals its sidebar widget", async () => {
		const setup = await testRender(
			() =>
				jsx(ProviderHost, {
					value: mockHostContext() as never,
					get children() {
						return jsx(UsagePageHost, {
							providers: [OPENAI, OLLAMA],
							quotaByProvider: {
								openai: openaiRead(),
								ollama: ollamaRead(),
							},
							displayNames: DISPLAY_NAMES,
							refresh: () => {},
							back: () => {},
						});
					},
				}),
			{ width: 120, height: 40 },
		);
		try {
			await setup.renderOnce();
			const rows = rowsOf(setup.captureCharFrame());
			const page = cardBody(rows, "Ollama Cloud");

			const widget = await sidebarLines(
				buildSidebarModel(OLLAMA, ollamaRead(), LOCALE, NOW),
			);
			expect(page).toEqual(widget);

			const all = page.join("\n");
			expect(all).not.toContain("Updated");
			expect(all).not.toContain("Total credits");
			expect(all).not.toContain("resets Oct");
			expect(all).toContain("41.6%");
			expect(all).toContain("$24.97 / $60.00 used");
			expect(all).toContain("+$4.27 credits");
		} finally {
			await setup.dispose();
		}
	});
});

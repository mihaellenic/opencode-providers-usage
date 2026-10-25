import { describe, expect, test } from "bun:test";
import type {
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
} from "../../src/core/contracts";
import { formatSidebarRows, formatSidebarText } from "../../src/ui/format";

const NOW = Date.UTC(2026, 11, 31, 23, 55);
const LOCALE = { locale: "en-GB", timeZone: "UTC" };
const provider: ProviderSummary = {
	providerID: "fixture",
	name: "Fixture",
	authMethod: "oauth",
	support: "supported",
	evidence: "live-validated",
};

function read(
	sections: { scope: QuotaScope; metrics: QuotaMetric[] }[],
): QuotaRead {
	return {
		state: "available",
		authSource: "codex-companion",
		sections: sections.map(({ scope, metrics }) => ({
			scope,
			result: {
				state: "available",
				metrics,
				fetchedAt: NOW - 12_000,
				expiresAt: NOW + 60_000,
			},
		})),
	} as QuotaRead;
}

describe("formatSidebarText", () => {
	test("rows own the compact presentation and text only serializes their public fields", () => {
		const quota = read([
			{
				scope: "provider-balance",
				metrics: [
					{
						id: "credits",
						kind: "money",
						scope: "provider-balance",
						label: "Included credits",
						currency: "USD",
						remaining: 2,
						resetsAt: NOW + 86_400_000,
					},
				],
			},
			{
				scope: "shared-plan",
				metrics: [],
			},
			{
				scope: "app",
				metrics: [
					{
						id: "known",
						kind: "window",
						scope: "app",
						label: "Current app limit",
						windowSeconds: 604800,
						remainingPercent: 51,
					} as QuotaMetric,
				],
			},
		]);
		const rows = formatSidebarRows(provider, quota, LOCALE, NOW);
		expect(rows[0]).toMatchObject({
			id: "provider",
			label: "Fixture",
			value: "",
			tone: "normal",
		});
		expect(rows.map(({ scope }) => scope)).toEqual([
			undefined,
			"provider-balance",
			"shared-plan",
			"app",
		]);
		expect(rows.map(({ id }) => id)).toEqual([
			"provider",
			"0:provider-balance:credits",
			"1:shared-plan:empty",
			"2:app:known",
		]);
		expect(rows[1]).toMatchObject({
			label: "Included",
			scope: "provider-balance",
			tone: "normal",
		});
		expect(rows[1]?.value).toContain("resets");
		expect(rows[1]?.detail).toContain("full refill 2027-01-01");
		expect(rows[2]?.value).toContain("No quota values");
		expect(rows[3]?.label).toBe("App 7d");
		expect(rows[3]).toMatchObject({
			id: "2:app:known",
			scope: "app",
			tone: "normal",
		});
		expect(rows.some((row) => row.id.endsWith(":cap"))).toBe(false);
		expect(formatSidebarText(provider, quota, LOCALE, NOW)).toBe(
			rows
				.map((row) =>
					row.value.length === 0 ? row.label : `${row.label}: ${row.value}`,
				)
				.join("\n"),
		);
	});

	test("preserves unavailable section position and displays money and top-level retry resets", () => {
		const partial: QuotaRead = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW,
						retryAfterMs: 1001,
					},
				},
				{
					scope: "provider-balance",
					result: {
						state: "available",
						metrics: [
							{
								id: "custom",
								kind: "money",
								scope: "provider-balance",
								label: "Mystery wallet",
								currency: "USD",
								remaining: 0,
								resetsAt: NOW + 60_000,
							},
						],
						fetchedAt: NOW,
						expiresAt: NOW + 100_000,
					},
				},
			],
		};
		const rows = formatSidebarRows(provider, partial, LOCALE, NOW);
		expect(rows[1]?.id).toBe("0:app:status");
		expect(rows[1]?.value).toContain("retry after 2s");
		expect(rows[2]?.label).toBe("Mystery wallet");
		expect(rows[2]?.value).toContain("resets");
		expect(rows[2]?.detail).toContain("full refill");
		const unavailable: QuotaRead = {
			state: "unavailable",
			reason: "rate_limited",
			attemptedAt: NOW,
			retryAfterMs: 4500,
		};
		expect(
			formatSidebarRows(provider, unavailable, LOCALE, NOW)[1]?.value,
		).toContain("retry after 5s");
		expect(formatSidebarText(provider, unavailable, LOCALE, NOW)).toContain(
			"retry after 5s",
		);
	});

	test("explains no sections and keeps unknown provider and custom metric labels", () => {
		const empty: QuotaRead = {
			state: "available",
			authSource: "opencode",
			sections: [],
		};
		const rows = formatSidebarRows(provider, empty, LOCALE, NOW);
		expect(rows[1]?.value).toBe("No quota sections were reported.");
		expect(formatSidebarText(provider, empty, LOCALE, NOW)).toContain(
			"No quota sections were reported.",
		);
		const customProvider = { ...provider, name: "Provider: Alpha" };
		const customQuota = read([
			{
				scope: "provider-balance",
				metrics: [
					{
						id: "other",
						kind: "money",
						scope: "provider-balance",
						label: "Tokens remaining",
						currency: "USD",
						remaining: 0,
					},
				],
			},
		]);
		const customRows = formatSidebarRows(
			customProvider,
			customQuota,
			LOCALE,
			NOW,
		);
		expect(customRows[0]?.label).toBe("Provider: Alpha");
		expect(customRows[1]?.label).toBe("Tokens remaining");
		expect(
			formatSidebarText(customProvider, customQuota, LOCALE, NOW).split(
				"\n",
			)[0],
		).toBe("Provider: Alpha");
	});

	test("preserves inherited-property names as custom money labels in rows and text", () => {
		const labels = ["constructor", "toString", "__proto__"];
		const quota = read([
			{
				scope: "provider-balance",
				metrics: labels.map((label, index) => ({
					id: `custom-${index}`,
					kind: "money" as const,
					scope: "provider-balance" as const,
					label,
					currency: "USD" as const,
					remaining: index + 1,
				})),
			},
		]);
		const rows = formatSidebarRows(provider, quota, LOCALE, NOW);
		const moneyRows = rows.filter((row) => row.scope === "provider-balance");
		expect(moneyRows.map((row) => row.label)).toEqual(labels);
		for (const row of moneyRows) expect(typeof row.label).toBe("string");
		const text = formatSidebarText(provider, quota, LOCALE, NOW);
		const lines = text.split("\n");
		for (const label of labels) {
			expect(lines.some((line) => line.startsWith(`${label}:`))).toBe(true);
		}
	});

	test("formats reset year and clock using Stockholm local calendar time", () => {
		const now = Date.UTC(2026, 11, 31, 23, 30);
		const reset = Date.UTC(2026, 11, 31, 22, 10);
		const stockholm = { locale: "en-GB", timeZone: "Europe/Stockholm" };
		const quota = read([
			{
				scope: "app",
				metrics: [
					{
						id: "stockholm",
						kind: "window",
						scope: "app",
						label: "Custom limit",
						windowSeconds: 3600,
						remainingPercent: 50,
						resetsAt: reset,
					},
				],
			},
		]);
		const text = formatSidebarText(provider, quota, stockholm, now);
		expect(text).toContain("resets 31 Dec 23:10 · 2026");
	});

	test("omits reset year based on Los Angeles local year, not UTC year", () => {
		const now = Date.UTC(2027, 0, 1, 0, 30);
		const reset = Date.UTC(2027, 0, 1, 1, 45);
		const losAngeles = { locale: "en-GB", timeZone: "America/Los_Angeles" };
		const quota = read([
			{
				scope: "app",
				metrics: [
					{
						id: "los-angeles",
						kind: "window",
						scope: "app",
						label: "Custom limit",
						windowSeconds: 3600,
						remainingPercent: 50,
						resetsAt: reset,
					},
				],
			},
		]);
		const text = formatSidebarText(provider, quota, losAngeles, now);
		expect(text).toContain("resets 31 Dec 17:45");
		expect(text).not.toContain("resets 31 Dec 17:45 · 2027");
	});

	test("omits UTC year difference when Stockholm reset remains in the same local year", () => {
		const now = Date.UTC(2026, 11, 31, 23, 30);
		const reset = Date.UTC(2027, 0, 1, 0, 15);
		const stockholm = { locale: "en-GB", timeZone: "Europe/Stockholm" };
		const quota = read([
			{
				scope: "app",
				metrics: [
					{
						id: "same-local-year",
						kind: "window",
						scope: "app",
						label: "Custom limit",
						windowSeconds: 3600,
						remainingPercent: 50,
						resetsAt: reset,
					},
				],
			},
		]);
		const text = formatSidebarText(provider, quota, stockholm, now);
		expect(text).toContain("resets 1 Jan 01:15");
		expect(text).not.toContain("resets 1 Jan 01:15 · 2027");
	});

	test("keeps the expected five-row baseline and grows to every independent constraint", () => {
		const windows = (count: number): QuotaMetric[] =>
			Array.from(
				{ length: count },
				(_, index) =>
					({
						id: `window-${index}`,
						kind: "window",
						scope: "app",
						label: `Limit ${index}`,
						windowSeconds: (index + 1) * 3600,
						remainingPercent: 80,
					}) as QuotaMetric,
			);
		const four = formatSidebarText(
			provider,
			read([{ scope: "app", metrics: windows(4) }]),
			LOCALE,
			NOW,
		);
		const eight = formatSidebarText(
			provider,
			read([{ scope: "app", metrics: windows(8) }]),
			LOCALE,
			NOW,
		);
		expect(four.split("\n")).toHaveLength(5);
		expect(eight.split("\n")).toHaveLength(9);
		expect(eight).toContain("App 8h · Limit 7");
	});

	test("formats independent windows, distinct balances, and concise truthful rows", () => {
		const quota = read([
			{
				scope: "provider-balance",
				metrics: [
					{
						id: "included",
						kind: "money",
						scope: "provider-balance",
						label: "Included credits",
						currency: "USD",
						remaining: 0,
						used: 3,
					},
					{
						id: "purchased",
						kind: "money",
						scope: "provider-balance",
						label: "Purchased credits",
						currency: "USD",
						remaining: 4,
					},
					{
						id: "total",
						kind: "money",
						scope: "provider-balance",
						label: "Total credits",
						currency: "USD",
						remaining: 4,
					},
				],
			},
			{
				scope: "app",
				metrics: [
					{
						id: "app",
						kind: "window",
						scope: "app",
						label: "Current app limit",
						windowSeconds: 604800,
						remainingPercent: 0,
						resetsAt: Date.UTC(2027, 0, 1, 1, 2, 3),
					},
					{
						id: "app-short",
						kind: "window",
						scope: "app",
						label: "Burst",
						windowSeconds: 3600,
						usedPercent: 33,
					},
				],
			},
			{
				scope: "shared-plan",
				metrics: [
					{
						id: "shared",
						kind: "window",
						scope: "shared-plan",
						label: "Primary",
						windowSeconds: 604800,
						usedPercent: 12,
					},
					{
						id: "shared-short",
						kind: "window",
						scope: "shared-plan",
						label: "Secondary",
						windowSeconds: 18000,
					},
				],
			},
		]);
		const text = formatSidebarText(provider, quota, LOCALE, NOW);
		const rows = text.split("\n");
		expect(rows).toHaveLength(8); // header + seven distinct metrics, no timestamp footer
		expect(rows[0]).toBe("Fixture");
		expect(text).toContain("Included: US$0.00 remaining");
		expect(text).toContain("Purchased: US$4.00 remaining");
		expect(text).toContain("Total: US$4.00 remaining");
		expect(text).toContain("App 7d: 0% remaining · resets 1 Jan 01:02 · 2027");
		expect(text).toContain("App 1h · Burst: 33% used");
		expect(text).toContain("Shared 7d: 12% used");
		expect(text).toContain("Shared 5h: Unknown (not reported)");
		expect(text).not.toContain("Updated");
		expect(text).not.toContain("supported");
		const sidebarRows = formatSidebarRows(provider, quota, LOCALE, NOW);
		expect(sidebarRows.filter((row) => row.scope !== undefined)).toHaveLength(
			7,
		);
		expect(sidebarRows[0]?.value).toBe("");
	});

	test("keeps same-duration metrics distinct and exposes failed-section retry delay", () => {
		const quota = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							{
								id: "one",
								kind: "window",
								scope: "app",
								label: "Current app limit",
								windowSeconds: 604800,
								remainingPercent: 50,
							},
							{
								id: "two",
								kind: "window",
								scope: "app",
								label: "Custom cap",
								windowSeconds: 604800,
								remainingPercent: 70,
							},
						],
						fetchedAt: NOW - 1000,
						expiresAt: NOW + 10000,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 5000,
						retryAfterMs: 2500,
					},
				},
			],
		} as QuotaRead;
		const text = formatSidebarText(provider, quota, LOCALE, NOW);
		expect(text).toContain("App 7d · Current app limit: 50% remaining");
		expect(text).toContain("App 7d · Custom cap: 70% remaining");
		expect(text).toContain("retry after 3s");
		expect(text).not.toContain("Updated");
		const rows = formatSidebarRows(provider, quota, LOCALE, NOW);
		expect(rows[1]?.label).toBe("App 7d · Current app limit");
		expect(rows[3]?.id).toBe("1:shared-plan:status");
	});

	test("keeps the exact Codex capability header as a bare name row", () => {
		const codex = { ...provider, name: "OpenAI ChatGPT with Codex companion" };
		const row = formatSidebarRows(codex, read([]), LOCALE, NOW)[0];
		expect(row).toMatchObject({
			label: "OpenAI · Codex quota",
			value: "",
			tone: "normal",
		});
		expect(formatSidebarText(codex, read([]), LOCALE, NOW).split("\n")[0]).toBe(
			"OpenAI · Codex quota",
		);
	});
});

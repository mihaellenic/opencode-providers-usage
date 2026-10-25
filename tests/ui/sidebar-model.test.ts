import { describe, expect, test } from "bun:test";
import type {
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
	SectionResult,
} from "../../src/core/contracts";
import {
	NOT_APPLICABLE_COPY,
	UNSUPPORTED_NO_SOURCE_COPY,
	unavailableCopy,
} from "../../src/ui/format";
import { buildSidebarModel } from "../../src/ui/sidebar-model";

const NOW = Date.UTC(2026, 11, 31, 20, 0);
const LOCALE = { locale: "en-US", timeZone: "UTC" };
const provider: ProviderSummary = {
	providerID: "fixture",
	name: "Fixture",
	authMethod: "oauth",
	support: "supported",
	evidence: "live-validated",
};

function available(
	scope: QuotaScope,
	metrics: QuotaMetric[],
	fetchedAt: number = NOW - 30_000,
) {
	return {
		scope,
		result: {
			state: "available" as const,
			metrics,
			fetchedAt,
			expiresAt: fetchedAt + 120_000,
		},
	};
}

function partial(
	sections: { scope: QuotaScope; result: SectionResult }[],
): QuotaRead {
	return {
		state: "partial",
		authSource: "codex-companion",
		sections,
	};
}

function windowMetric(
	overrides: Partial<Extract<QuotaMetric, { kind: "window" }>> & {
		id: string;
		scope: QuotaScope;
	},
): QuotaMetric {
	return {
		kind: "window",
		label: "Current app limit",
		windowSeconds: 604_800,
		...overrides,
	};
}

function moneyMetric(
	overrides: Partial<Extract<QuotaMetric, { kind: "money" }>> & {
		id: string;
		label: string;
		remaining: number;
	},
): QuotaMetric {
	return {
		kind: "money",
		scope: "provider-balance",
		currency: "USD",
		...overrides,
	};
}

describe("buildSidebarModel", () => {
	test("renders the approved two-window shape without invented account labels", () => {
		const model = buildSidebarModel(
			{ ...provider, name: "OpenAI ChatGPT with Codex companion" },
			{
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "five-hour",
							scope: "app",
							windowSeconds: 18_000,
							remainingPercent: 97,
							resetsAt: Date.UTC(2026, 11, 31, 21, 17),
						}),
					]),
					available("shared-plan", [
						windowMetric({
							id: "week",
							scope: "shared-plan",
							label: "Shared plan primary limit",
							remainingPercent: 9,
							resetsAt: Date.UTC(2027, 0, 5, 1, 16),
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);

		expect(model.provider).toBe("OpenAI · Codex quota");
		expect(model.lines).toEqual([
			{
				id: "0:app:five-hour",
				kind: "window",
				label: "App 5h",
				value: { text: "97% left", tone: "success" },
				reset: "Resets 21:17",
			},
			{
				id: "1:shared-plan:week",
				kind: "window",
				label: "Shared 7d",
				value: { text: "9% left", tone: "warning" },
				reset: "Jan 5, 01:16 · 2027",
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("Account-wide");
		expect(serialized).not.toContain("ChatGPT Plus");
		expect(serialized).not.toContain("ago");
	});

	test("renders a used bar and folds purchased credits into the stat row", () => {
		const model = buildSidebarModel(
			{ ...provider, name: "Ollama Cloud" },
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 50.1,
							allowance: 60,
							used: 9.9,
							resetsAt: NOW + 21 * 86_400_000,
						}),
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
						}),
						moneyMetric({
							id: "total",
							label: "Total credits",
							remaining: 54.37,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);

		expect(model.provider).toBe("Ollama Cloud");
		expect(model.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "bar",
				fill: (60 - 50.1) / 60,
				percent: { text: "16.5%", tone: "normal" },
				reset: "resets 21d",
			},
			{
				id: "0:provider-balance:included:stats",
				kind: "pair",
				left: { text: "$9.90 / $60.00 used", tone: "normal" },
				right: { text: "+$4.27 credits", tone: "normal" },
				metricIDs: ["included", "purchased", "total"],
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("% left");
		expect(serialized).not.toContain("of $60.00");
		expect(serialized).not.toContain("Purchased $");
		expect(serialized).not.toContain("Total $");
		expect(serialized).not.toContain("no refill");
		expect(serialized).not.toContain("ago");
	});

	test("preserves four independent app/shared constraints and distinguishes collisions", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "generic",
							scope: "app",
							remainingPercent: 50,
						}),
						windowMetric({
							id: "custom",
							scope: "app",
							label: "Custom cap",
							remainingPercent: 70,
						}),
						windowMetric({
							id: "burst-one",
							scope: "app",
							label: "Burst",
							windowSeconds: 3600,
							remainingPercent: 80,
						}),
						windowMetric({
							id: "burst-two",
							scope: "app",
							label: "Burst",
							windowSeconds: 3600,
							remainingPercent: 90,
						}),
					]),
					available("shared-plan", [
						windowMetric({
							id: "primary",
							scope: "shared-plan",
							label: "Primary",
							windowSeconds: 18_000,
							remainingPercent: 40,
						}),
						windowMetric({
							id: "secondary",
							scope: "shared-plan",
							label: "Secondary",
							windowSeconds: 18_000,
							remainingPercent: 30,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);

		const windows = model.lines.filter((line) => line.kind === "window");
		expect(windows.map((line) => line.id)).toEqual([
			"0:app:generic",
			"0:app:custom",
			"0:app:burst-one",
			"0:app:burst-two",
			"1:shared-plan:primary",
			"1:shared-plan:secondary",
		]);
		expect(windows.map((line) => line.label)).toEqual([
			"App 7d · Current app limit",
			"App 7d · Custom cap",
			"App 1h · Burst",
			"App 1h · Burst · burst-two",
			"Shared 5h · Primary",
			"Shared 5h · Secondary",
		]);
		expect(new Set(windows.map((line) => line.label)).size).toBe(6);
	});

	test("keeps inherited-property names and arbitrary labels intact", () => {
		const labels = ["constructor", "toString", "__proto__"];
		const model = buildSidebarModel(
			{ ...provider, name: "__proto__ Provider" },
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available(
						"provider-balance",
						labels.map((label, index) =>
							moneyMetric({
								id: `custom-${index}`,
								label,
								remaining: index + 1,
							}),
						),
					),
				],
			},
			LOCALE,
			NOW,
		);

		expect(model.provider).toBe("__proto__ Provider");
		expect(model.lines).toEqual(
			labels.map((label, index) => ({
				id: `0:provider-balance:custom-${index}`,
				kind: "credit",
				label,
				value: {
					text: `$${(index + 1).toFixed(2)} remaining`,
					tone: "normal",
				},
			})),
		);
	});

	test("keeps used-only, zero, warning, success, and unknown window values truthful", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "used-only",
							scope: "app",
							usedPercent: 10,
						}),
						windowMetric({
							id: "zero",
							scope: "app",
							remainingPercent: 0,
						}),
						windowMetric({
							id: "warning-edge",
							scope: "app",
							remainingPercent: 20,
						}),
						windowMetric({
							id: "healthy",
							scope: "app",
							remainingPercent: 21,
						}),
						windowMetric({ id: "unknown", scope: "app" }),
					]),
				],
			},
			LOCALE,
			NOW,
		);

		const windows = model.lines.filter((line) => line.kind === "window");
		expect(windows.map((line) => line.value)).toEqual([
			{ text: "10% used", tone: "normal" },
			{ text: "0% left", tone: "error" },
			{ text: "20% left", tone: "warning" },
			{ text: "21% left", tone: "success" },
			{ text: "Unknown (not reported)", tone: "muted" },
		]);
		for (const line of windows) {
			expect(line.reset).toBeUndefined();
		}
	});

	test("never computes a percentage or total from absent or zero allowance", () => {
		const noAllowance = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 2.5,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(noAllowance.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "credit",
				label: "Included",
				value: { text: "$2.50 remaining", tone: "normal" },
			},
		]);
		expect(noAllowance.lines[0]).not.toHaveProperty("detail");
		expect(JSON.stringify(noAllowance)).not.toContain("% left");
		expect(JSON.stringify(noAllowance)).not.toContain("no allowance");
		expect(JSON.stringify(noAllowance)).not.toContain("no refill");
		expect(JSON.stringify(noAllowance)).not.toContain("used");

		const zeroAllowance = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 0,
							allowance: 0,
						}),
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(zeroAllowance.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "credit",
				label: "Included",
				value: { text: "$0.00 remaining", tone: "error" },
			},
			{
				id: "0:provider-balance:purchased",
				kind: "credit",
				label: "Purchased",
				value: { text: "$4.27 remaining", tone: "normal" },
			},
		]);
		expect(JSON.stringify(zeroAllowance)).not.toContain("% left");
		expect(JSON.stringify(zeroAllowance)).not.toContain("Total $0.00");
		expect(JSON.stringify(zeroAllowance)).not.toContain("no refill");
		expect(JSON.stringify(zeroAllowance)).not.toContain("allowance $0.00");
	});

	test("renders a used-based bar and stat row from a reported allowance", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 5,
							allowance: 10,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(model.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "bar",
				fill: 0.5,
				percent: { text: "50%", tone: "normal" },
			},
			{
				id: "0:provider-balance:included:stats",
				kind: "pair",
				left: { text: "$5.00 / $10.00 used", tone: "normal" },
				metricIDs: ["included"],
			},
		]);
		expect(JSON.stringify(model)).not.toContain("% left");
	});

	test("tones only the percent at used thresholds", () => {
		function included(
			remaining: number,
			allowance: number,
			resetsAt?: number,
		): QuotaRead {
			return {
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining,
							allowance,
							...(resetsAt === undefined ? {} : { resetsAt }),
						}),
					]),
				],
			};
		}

		const untouched = buildSidebarModel(
			provider,
			included(10, 10),
			LOCALE,
			NOW,
		);
		expect(untouched.lines[0]).toEqual({
			id: "0:provider-balance:included",
			kind: "bar",
			fill: 0,
			percent: { text: "0%", tone: "normal" },
		});
		expect(untouched.lines[1]).toMatchObject({
			left: { text: "$0.00 / $10.00 used", tone: "normal" },
			metricIDs: ["included"],
		});

		const belowThreshold = buildSidebarModel(
			provider,
			included(2.1, 10),
			LOCALE,
			NOW,
		);
		expect(belowThreshold.lines[0]).toMatchObject({
			percent: { text: "79%", tone: "normal" },
		});
		expect(belowThreshold.lines[1]).toMatchObject({
			left: { text: "$7.90 / $10.00 used", tone: "normal" },
		});

		const warning = buildSidebarModel(provider, included(2, 10), LOCALE, NOW);
		expect(warning.lines[0]).toMatchObject({
			fill: 0.8,
			percent: { text: "80%", tone: "warning" },
		});
		expect(warning.lines[1]).toMatchObject({
			left: { text: "$8.00 / $10.00 used", tone: "normal" },
		});

		const exhausted = buildSidebarModel(provider, included(0, 10), LOCALE, NOW);
		expect(exhausted.lines[0]).toMatchObject({
			fill: 1,
			percent: { text: "100%", tone: "error" },
		});
		expect(exhausted.lines[1]).toMatchObject({
			left: { text: "$10.00 / $10.00 used", tone: "normal" },
		});

		const withReset = buildSidebarModel(
			provider,
			included(2, 10, NOW + 2 * 86_400_000),
			LOCALE,
			NOW,
		);
		expect(withReset.lines[0]).toMatchObject({
			reset: "resets 2d",
			percent: { tone: "warning" },
		});
	});

	test("formats the bar reset countdown with two-unit precision", () => {
		function resetAt(offsetMs: number | undefined): QuotaRead {
			return {
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 5,
							allowance: 10,
							...(offsetMs === undefined ? {} : { resetsAt: NOW + offsetMs }),
						}),
					]),
				],
			};
		}

		const day = 86_400_000;
		const hour = 3_600_000;
		const minute = 60_000;

		expect(
			buildSidebarModel(provider, resetAt(25 * day + 15 * hour), LOCALE, NOW)
				.lines[0],
		).toMatchObject({ reset: "resets 25d 15h" });
		expect(
			buildSidebarModel(
				provider,
				resetAt(25 * day + 15 * hour + 30 * minute),
				LOCALE,
				NOW,
			).lines[0],
		).toMatchObject({ reset: "resets 25d 16h" });
		expect(
			buildSidebarModel(provider, resetAt(15 * hour + 30 * minute), LOCALE, NOW)
				.lines[0],
		).toMatchObject({ reset: "resets 15h 30m" });
		expect(
			buildSidebarModel(provider, resetAt(30 * minute), LOCALE, NOW).lines[0],
		).toMatchObject({ reset: "resets 30m" });
		expect(
			buildSidebarModel(provider, resetAt(45_000), LOCALE, NOW).lines[0],
		).toMatchObject({ reset: "resets 45s" });
		expect(
			buildSidebarModel(provider, resetAt(0), LOCALE, NOW).lines[0],
		).toMatchObject({ reset: "resets now" });
		expect(
			buildSidebarModel(provider, resetAt(-minute), LOCALE, NOW).lines[0],
		).toMatchObject({ reset: "resets now" });
		expect(
			buildSidebarModel(provider, resetAt(undefined), LOCALE, NOW).lines[0],
		).not.toHaveProperty("reset");
	});

	test("keeps reset-bearing and non-adjacent money metrics on their own ordered rows", () => {
		const resetBearing = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
							resetsAt: NOW + 2 * 3_600_000,
						}),
						moneyMetric({
							id: "total",
							label: "Total credits",
							remaining: 54.37,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(resetBearing.lines).toEqual([
			{
				id: "0:provider-balance:purchased",
				kind: "credit",
				label: "Purchased",
				value: { text: "$4.27 remaining", tone: "normal" },
				detail: "refills in 2h",
			},
			{
				id: "0:provider-balance:total",
				kind: "credit",
				label: "Total",
				value: { text: "$54.37 remaining", tone: "normal" },
			},
		]);

		const nonAdjacent = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
						}),
						moneyMetric({
							id: "bonus",
							label: "Bonus credits",
							remaining: 1,
							allowance: 2,
							used: 1,
						}),
						moneyMetric({
							id: "total",
							label: "Total credits",
							remaining: 54.37,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(nonAdjacent.lines).toEqual([
			{
				id: "0:provider-balance:purchased",
				kind: "credit",
				label: "Purchased",
				value: { text: "$4.27 remaining", tone: "normal" },
			},
			{
				id: "0:provider-balance:bonus",
				kind: "credit",
				label: "Bonus credits",
				value: { text: "$1.00 remaining", tone: "normal" },
				detail: "allowance $2.00 · $1.00 used",
			},
			{
				id: "0:provider-balance:total",
				kind: "credit",
				label: "Total",
				value: { text: "$54.37 remaining", tone: "normal" },
			},
		]);
		expect(JSON.stringify(nonAdjacent)).toContain("$1.00 used");
		expect(JSON.stringify(nonAdjacent)).not.toContain("no refill");
		expect(JSON.stringify(nonAdjacent)).not.toContain("no allowance");
	});

	test("preserves reported used when it is not redundant with remaining and allowance", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "custom-used-only",
							label: "Bonus credits",
							remaining: 1,
							used: 1,
						}),
						moneyMetric({
							id: "included-used-only",
							label: "Included credits",
							remaining: 2.5,
							used: 0.5,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(model.lines).toEqual([
			{
				id: "0:provider-balance:custom-used-only",
				kind: "credit",
				label: "Bonus credits",
				value: { text: "$1.00 remaining", tone: "normal" },
				detail: "$1.00 used",
			},
			{
				id: "0:provider-balance:included-used-only",
				kind: "credit",
				label: "Included",
				value: { text: "$2.50 remaining", tone: "normal" },
				detail: "$0.50 used",
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("% left");
		expect(serialized).not.toContain("no allowance");
		expect(serialized).not.toContain("no refill");
	});

	test("keeps known credit pools separate when optional metadata would be hidden", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
							allowance: 10,
							used: 5.73,
						}),
						moneyMetric({
							id: "total",
							label: "Total credits",
							remaining: 54.37,
							used: 5.63,
						}),
					]),
				],
			},
			LOCALE,
			NOW,
		);
		expect(model.lines).toEqual([
			{
				id: "0:provider-balance:purchased",
				kind: "credit",
				label: "Purchased",
				value: { text: "$4.27 remaining", tone: "normal" },
				detail: "allowance $10.00 · $5.73 used",
			},
			{
				id: "0:provider-balance:total",
				kind: "credit",
				label: "Total",
				value: { text: "$54.37 remaining", tone: "normal" },
				detail: "$5.63 used",
			},
		]);
		expect(model.lines.some((line) => line.kind === "pair")).toBe(false);
		expect(JSON.stringify(model)).not.toContain("no refill");
	});

	test("explains empty available sections and an empty section list", () => {
		const emptySection = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [available("app", [])],
			},
			LOCALE,
			NOW,
		);
		expect(emptySection.lines).toEqual([
			{
				id: "0:app:empty",
				kind: "status",
				text: "App: No quota values were reported for this scope.",
				tone: "warning",
			},
		]);

		const emptyRead = buildSidebarModel(
			provider,
			{ state: "available", authSource: "opencode", sections: [] },
			LOCALE,
			NOW,
		);
		expect(emptyRead.lines).toEqual([
			{
				id: "quota:empty",
				kind: "status",
				text: "No quota sections were reported.",
				tone: "warning",
			},
		]);
		expect(emptyRead).not.toHaveProperty("footer");
	});

	test("retains valid rows, failed scopes, retry delays, and source order in a partial read", () => {
		const model = buildSidebarModel(
			provider,
			partial([
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "valid",
								scope: "app",
								remainingPercent: 75,
							}),
						],
						fetchedAt: NOW - 1000,
						expiresAt: NOW + 60_000,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 5000,
						retryAfterMs: 4500,
					},
				},
			]),
			LOCALE,
			NOW,
		);

		expect(model.lines[0]).toEqual({
			id: "0:app:valid",
			kind: "window",
			label: "App 7d",
			value: { text: "75% left", tone: "success" },
		});
		expect(model.lines[1]).toEqual({
			id: "1:shared-plan:status",
			kind: "status",
			text: `Shared: ${unavailableCopy("unavailable", "rate_limited")} · retry after 5s`,
			tone: "error",
		});
		expect(JSON.stringify(model)).not.toContain("ago");
	});

	test("preserves source section order when a failure precedes a valid section", () => {
		const model = buildSidebarModel(
			provider,
			partial([
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "timeout",
						attemptedAt: NOW - 2000,
					},
				},
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "valid",
								scope: "app",
								remainingPercent: 75,
							}),
						],
						fetchedAt: NOW - 2000,
						expiresAt: NOW + 60_000,
					},
				},
			]),
			LOCALE,
			NOW,
		);
		expect(model.lines.map((line) => line.id)).toEqual([
			"0:shared-plan:status",
			"1:app:valid",
		]);
		expect(JSON.stringify(model)).not.toContain("ago");
	});

	test("shows the short unavailable title, exact copy, and retry delay without a footer", () => {
		const model = buildSidebarModel(
			provider,
			{
				state: "unavailable",
				reason: "rate_limited",
				attemptedAt: NOW - 5 * 60_000,
				retryAfterMs: 4500,
			},
			LOCALE,
			NOW,
		);
		expect(model.lines).toEqual([
			{
				id: "quota:title",
				kind: "status",
				text: "Quota unavailable",
				tone: "error",
			},
			{
				id: "quota:status",
				kind: "status",
				text: `${unavailableCopy("unavailable", "rate_limited")} · retry after 5s`,
				tone: "error",
			},
		]);
		expect(model).not.toHaveProperty("footer");
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("last attempt");
		expect(serialized).not.toContain("0%");
		expect(serialized).not.toContain("unlimited");
	});

	test("never presents unsupported or not-applicable quota as zero or unlimited", () => {
		const unsupported = buildSidebarModel(
			provider,
			{
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW - 30_000,
			},
			LOCALE,
			NOW,
		);
		expect(unsupported.lines).toEqual([
			{
				id: "quota:title",
				kind: "status",
				text: "Quota unavailable",
				tone: "warning",
			},
			{
				id: "quota:status",
				kind: "status",
				text: UNSUPPORTED_NO_SOURCE_COPY,
				tone: "warning",
			},
		]);
		expect(JSON.stringify(unsupported)).not.toContain("0%");
		expect(JSON.stringify(unsupported)).not.toContain("unlimited");

		const notApplicable = buildSidebarModel(
			provider,
			{
				state: "not-applicable",
				reason: "no_validated_quota_source",
				attemptedAt: NOW - 30_000,
			},
			LOCALE,
			NOW,
		);
		expect(notApplicable.lines).toEqual([
			{
				id: "quota:title",
				kind: "status",
				text: "Quota not applicable",
				tone: "warning",
			},
			{
				id: "quota:status",
				kind: "status",
				text: NOT_APPLICABLE_COPY,
				tone: "warning",
			},
		]);
	});

	test("compares reset dates and years in the configured local calendar", () => {
		const stockholm = { locale: "en-GB", timeZone: "Europe/Stockholm" };

		const sameLocalDate = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("app", [
						windowMetric({
							id: "stockholm-same-day",
							scope: "app",
							remainingPercent: 50,
							resetsAt: Date.UTC(2026, 11, 31, 21, 17),
						}),
					]),
				],
			},
			stockholm,
			Date.UTC(2026, 11, 31, 20, 0),
		);
		const sameDay = sameLocalDate.lines[0];
		expect(sameDay?.kind).toBe("window");
		if (sameDay?.kind === "window") {
			expect(sameDay.reset).toBe("Resets 22:17");
		}

		const differentLocalDate = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("app", [
						windowMetric({
							id: "stockholm-previous-day",
							scope: "app",
							remainingPercent: 50,
							resetsAt: Date.UTC(2026, 11, 31, 22, 10),
						}),
					]),
				],
			},
			stockholm,
			Date.UTC(2026, 11, 31, 23, 30),
		);
		expect(differentLocalDate.lines[0]).toMatchObject({
			reset: "31 Dec, 23:10 · 2026",
		});

		const sameLocalYear = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("app", [
						windowMetric({
							id: "stockholm-same-year",
							scope: "app",
							remainingPercent: 50,
							resetsAt: Date.UTC(2027, 0, 1, 0, 15),
						}),
					]),
				],
			},
			stockholm,
			Date.UTC(2026, 11, 31, 23, 30),
		);
		expect(sameLocalYear.lines[0]).toMatchObject({ reset: "Resets 01:15" });

		const losAngeles = { locale: "en-GB", timeZone: "America/Los_Angeles" };
		const sameLosAngelesDate = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available("app", [
						windowMetric({
							id: "los-angeles",
							scope: "app",
							remainingPercent: 50,
							resetsAt: Date.UTC(2027, 0, 1, 1, 45),
						}),
					]),
				],
			},
			losAngeles,
			Date.UTC(2027, 0, 1, 0, 30),
		);
		expect(sameLosAngelesDate.lines[0]).toMatchObject({
			reset: "Resets 17:45",
		});

		const nextLocalYearNow = Date.UTC(2026, 11, 31, 11, 0);
		const nextLocalYear = buildSidebarModel(
			provider,
			{
				state: "available",
				authSource: "opencode",
				sections: [
					available(
						"app",
						[
							windowMetric({
								id: "next-year",
								scope: "app",
								remainingPercent: 50,
								resetsAt: Date.UTC(2026, 11, 31, 23, 15),
							}),
						],
						nextLocalYearNow - 30_000,
					),
				],
			},
			stockholm,
			nextLocalYearNow,
		);
		expect(nextLocalYear.lines[0]).toMatchObject({
			reset: "1 Jan, 00:15 · 2027",
		});
		expect(nextLocalYear.lines).toHaveLength(1);
	});
});

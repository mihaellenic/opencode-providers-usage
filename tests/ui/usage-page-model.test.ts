import { describe, expect, test } from "bun:test";
import type {
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
	SectionResult,
} from "../../src/core/contracts";
import {
	formatPercent,
	formatResetCompact,
	NOT_APPLICABLE_COPY,
	SCOPE_LABELS,
	unavailableCopy,
} from "../../src/ui/format";
import { buildUsagePageModel } from "../../src/ui/usage-page-model";

const NOW = Date.UTC(2026, 11, 31, 20, 0);
const LOCALE = { locale: "en-US", timeZone: "UTC" };
const SAME_YEAR_RESET = Date.UTC(2026, 11, 31, 22, 0);
const NEXT_YEAR_RESET = Date.UTC(2027, 0, 2, 10, 16);

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

const FUTURE: ProviderSummary = {
	providerID: "future-provider",
	name: "Future Provider",
	authMethod: "api-key",
	support: "supported",
	evidence: "documented-only",
};

const UNSUPPORTED: ProviderSummary = {
	providerID: "zen",
	name: "OpenCode / Zen",
	authMethod: "api-key",
	support: "unsupported",
	evidence: "unverified",
};

function available(
	scope: QuotaScope,
	metrics: QuotaMetric[],
	options: {
		fetchedAt?: number;
		configuredAppCapPercent?: number;
	} = {},
) {
	const fetchedAt = options.fetchedAt ?? NOW - 30_000;
	return {
		scope,
		result: {
			state: "available" as const,
			metrics,
			fetchedAt,
			expiresAt: fetchedAt + 120_000,
			...(options.configuredAppCapPercent === undefined
				? {}
				: { configuredAppCapPercent: options.configuredAppCapPercent }),
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

function build(
	providers: ProviderSummary[],
	quotaByProvider: Record<string, QuotaRead>,
) {
	return buildUsagePageModel({
		providers,
		quotaByProvider,
		locale: LOCALE,
		now: NOW,
	});
}

describe("buildUsagePageModel", () => {
	test("renders window bars with full scope-qualified labels, used percents, tones, and absolute resets", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "healthy",
							scope: "app",
							label: "Weekly window",
							remainingPercent: 97,
							resetsAt: SAME_YEAR_RESET,
						}),
						windowMetric({
							id: "warning",
							scope: "app",
							label: "Five-hour window",
							windowSeconds: 18_000,
							remainingPercent: 9,
						}),
						windowMetric({
							id: "exhausted",
							scope: "app",
							label: "Zero window",
							windowSeconds: 3_600,
							remainingPercent: 0,
						}),
						windowMetric({
							id: "used-only",
							scope: "app",
							label: "Used only",
							windowSeconds: 600,
							usedPercent: 59,
						}),
						windowMetric({
							id: "unknown",
							scope: "app",
							label: "No data",
							windowSeconds: 300,
						}),
					]),
				],
			},
		});

		expect(model.title).toBe("Provider usage");
		expect(model.subtitle).toBe("Connected accounts · quota & balances");
		expect(model.cards).toHaveLength(1);
		const card = model.cards[0];
		expect(card?.id).toBe("openai");
		expect(card?.name).toBe("OpenAI");
		expect(card?.updated).toEqual({ text: "Updated 30s ago", tone: "success" });
		expect(card?.lines).toEqual([
			{
				id: "0:app:healthy",
				kind: "window",
				label: "App · Weekly window",
				value: { text: "3%", tone: "normal" },
				fill: 0.03,
				reset: "resets Dec 31 22:00",
			},
			{
				id: "0:app:warning",
				kind: "window",
				label: "App · Five-hour window",
				value: { text: "91%", tone: "warning" },
				fill: 0.91,
			},
			{
				id: "0:app:exhausted",
				kind: "window",
				label: "App · Zero window",
				value: { text: "100%", tone: "error" },
				fill: 1,
			},
			{
				id: "0:app:used-only",
				kind: "window",
				label: "App · Used only",
				value: { text: "59%", tone: "normal" },
				fill: 0.59,
			},
			{
				id: "0:app:unknown",
				kind: "window",
				label: "App · No data",
				value: { text: "Unknown (not reported)", tone: "muted" },
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("remaining");
		expect(serialized).not.toContain("% left");
		expect(serialized).not.toContain("resets 2h");
	});

	test("appends the year to absolute resets only when it differs from the current local year", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 50.1,
							allowance: 60,
							resetsAt: NEXT_YEAR_RESET,
						}),
					]),
				],
			},
		});
		const bar = model.cards[0]?.lines[0];
		expect(bar?.kind).toBe("bar");
		expect(bar).toMatchObject({
			reset: formatResetCompact(NEXT_YEAR_RESET, LOCALE, NOW),
		});
		expect(bar).toMatchObject({ reset: "resets Jan 2 10:16 · 2027" });
	});

	test("renders a positive-allowance bar and pair plus the explicit total credits row", () => {
		const model = build([OLLAMA], {
			ollama: {
				state: "available",
				authSource: "opencode",
				sections: [
					available(
						"provider-balance",
						[
							moneyMetric({
								id: "included",
								label: "Included credits",
								remaining: 50.1,
								allowance: 60,
								used: 9.9,
								resetsAt: SAME_YEAR_RESET,
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
						],
						{ fetchedAt: NOW - 30_000 },
					),
				],
			},
		});

		expect(model.cards[0]?.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "bar",
				fill: (60 - 50.1) / 60,
				percent: { text: "16.5%", tone: "normal" },
				reset: "resets Dec 31 22:00",
			},
			{
				id: "0:provider-balance:included:stats",
				kind: "pair",
				left: { text: "$9.90 / $60.00 used", tone: "normal" },
				right: { text: "+$4.27 credits", tone: "normal" },
				metricIDs: ["included", "purchased", "total"],
			},
			{
				id: "0:provider-balance:total",
				kind: "credit",
				label: "Total credits",
				value: { text: "$54.37", tone: "normal" },
			},
		]);
		for (const line of model.cards[0]?.lines ?? []) {
			expect(line).not.toHaveProperty("detail");
		}
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("% left");
		expect(serialized).not.toContain("Purchased $");
		expect(serialized).not.toContain("Total $");
	});

	test("carries used thresholds on the money percent while the pair stays neutral", () => {
		function included(remaining: number, allowance: number): QuotaRead {
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
						}),
					]),
				],
			};
		}

		const warning = build([OLLAMA], { ollama: included(10, 100) });
		expect(warning.cards[0]?.lines[0]).toMatchObject({
			kind: "bar",
			percent: { text: "90%", tone: "warning" },
		});
		expect(warning.cards[0]?.lines[1]).toMatchObject({
			kind: "pair",
			left: { text: "$90.00 / $100.00 used", tone: "normal" },
		});

		const exhausted = build([OLLAMA], { ollama: included(0, 100) });
		expect(exhausted.cards[0]?.lines[0]).toMatchObject({
			kind: "bar",
			percent: { text: "100%", tone: "error" },
		});
		expect(exhausted.cards[0]?.lines[1]).toMatchObject({
			kind: "pair",
			left: { text: "$100.00 / $100.00 used", tone: "normal" },
		});
	});

	test("renders money without a positive allowance and standalone pools as sidebar credit lines", () => {
		const model = build([OLLAMA], {
			ollama: {
				state: "available",
				authSource: "opencode",
				sections: [
					available("provider-balance", [
						moneyMetric({
							id: "included",
							label: "Included credits",
							remaining: 2.5,
							used: 1,
							resetsAt: NOW + 86_400_000,
						}),
						moneyMetric({
							id: "purchased",
							label: "Purchased credits",
							remaining: 4.27,
						}),
						moneyMetric({
							id: "custom",
							label: "Credits",
							remaining: 0,
						}),
						moneyMetric({
							id: "total",
							label: "Total credits",
							remaining: 6.77,
						}),
					]),
				],
			},
		});

		expect(model.cards[0]?.lines).toEqual([
			{
				id: "0:provider-balance:included",
				kind: "credit",
				label: "Included",
				value: { text: "$2.50 remaining", tone: "normal" },
				detail: "$1.00 used · refills in 24h",
			},
			{
				id: "0:provider-balance:purchased",
				kind: "credit",
				label: "Purchased",
				value: { text: "$4.27 remaining", tone: "normal" },
			},
			{
				id: "0:provider-balance:custom",
				kind: "credit",
				label: "Credits",
				value: { text: "$0.00 remaining", tone: "error" },
			},
			{
				id: "0:provider-balance:total",
				kind: "credit",
				label: "Total",
				value: { text: "$6.77 remaining", tone: "normal" },
			},
		]);
		expect(JSON.stringify(model)).not.toContain("unlimited");
		expect(JSON.stringify(model)).not.toContain("no allowance");
	});

	test("surfaces a configured app cap as a credit line that never reads as remaining", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [
					available(
						"app",
						[
							windowMetric({
								id: "week",
								scope: "app",
								remainingPercent: 90,
							}),
						],
						{ configuredAppCapPercent: 100 },
					),
				],
			},
		});

		expect(model.cards[0]?.lines.at(-1)).toEqual({
			id: "0:app:cap",
			kind: "credit",
			label: "Configured app cap",
			value: {
				text: `${formatPercent(100, LOCALE)}% allowed`,
				tone: "normal",
			},
			detail:
				"Configured app cap reported by the provider; never remaining quota.",
		});
	});

	test("keeps a configured app cap when the scope reports no metrics", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [available("app", [], { configuredAppCapPercent: 100 })],
			},
		});

		expect(model.cards[0]?.lines).toEqual([
			{
				id: "0:app:empty",
				kind: "status",
				text: `${SCOPE_LABELS.app}: No quota values were reported for this scope.`,
				tone: "warning",
			},
			{
				id: "0:app:cap",
				kind: "credit",
				label: "Configured app cap",
				value: {
					text: `${formatPercent(100, LOCALE)}% allowed`,
					tone: "normal",
				},
				detail:
					"Configured app cap reported by the provider; never remaining quota.",
			},
		]);
	});

	test("keeps shared-plan windows, source order, custom names, and collision suffixes", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "week",
							scope: "app",
							label: "Weekly window",
							remainingPercent: 75,
						}),
						windowMetric({
							id: "five-hour",
							scope: "app",
							label: "Five-hour window",
							windowSeconds: 18_000,
							remainingPercent: 41,
						}),
						windowMetric({
							id: "burst-one",
							scope: "app",
							label: "Burst",
							windowSeconds: 3_600,
							remainingPercent: 80,
						}),
						windowMetric({
							id: "burst-two",
							scope: "app",
							label: "Burst",
							windowSeconds: 3_600,
							remainingPercent: 90,
						}),
						windowMetric({
							id: "custom",
							scope: "app",
							label: "Custom daily window",
							windowSeconds: 86_400,
							remainingPercent: 70,
						}),
					]),
					available("shared-plan", [
						windowMetric({
							id: "primary",
							scope: "shared-plan",
							label: "Primary",
							remainingPercent: 91,
						}),
					]),
				],
			},
		});

		const windows = (model.cards[0]?.lines ?? []).filter(
			(line) => line.kind === "window",
		);
		expect(windows.map((line) => line.id)).toEqual([
			"0:app:week",
			"0:app:five-hour",
			"0:app:burst-one",
			"0:app:burst-two",
			"0:app:custom",
			"1:shared-plan:primary",
		]);
		expect(windows.map((line) => line.label)).toEqual([
			"App · Weekly window",
			"App · Five-hour window",
			"App · Burst",
			"App · Burst · burst-two",
			"App · Custom daily window",
			"Shared plan · Primary",
		]);
	});

	test("keeps fresh scopes beside per-scope unavailable explanations and retry delays", () => {
		const model = build([OPENAI], {
			openai: partial([
				available(
					"app",
					[
						windowMetric({
							id: "valid",
							scope: "app",
							remainingPercent: 75,
						}),
					],
					{ fetchedAt: NOW - 1_000 },
				),
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 5_000,
						retryAfterMs: 4_500,
					},
				},
				{
					scope: "provider-balance",
					result: {
						state: "not-applicable",
						reason: "no_quota",
						attemptedAt: NOW - 9_000,
					},
				},
				{
					scope: "app",
					result: {
						state: "unsupported",
						reason: "no_validated_quota_source",
						attemptedAt: NOW - 9_500,
					},
				},
			]),
		});

		const card = model.cards[0];
		expect(card?.updated).toEqual({ text: "Updated 1s ago", tone: "success" });
		expect(card?.lines).toEqual([
			{
				id: "0:app:valid",
				kind: "window",
				label: "App · Current app limit",
				value: { text: "25%", tone: "normal" },
				fill: 0.25,
			},
			{
				id: "1:shared-plan:status",
				kind: "status",
				text: `${SCOPE_LABELS["shared-plan"]}: ${unavailableCopy("unavailable", "rate_limited")} · retry after 5s`,
				tone: "error",
			},
			{
				id: "2:provider-balance:status",
				kind: "status",
				text: `${SCOPE_LABELS["provider-balance"]}: ${unavailableCopy("not-applicable", "no_quota")}`,
				tone: "warning",
			},
			{
				id: "3:app:status",
				kind: "status",
				text: `${SCOPE_LABELS.app}: ${unavailableCopy("unsupported", "no_validated_quota_source")}`,
				tone: "warning",
			},
		]);
	});

	test("renders the whole-read unavailable title rule with explanation and retry delay", () => {
		const unavailable = build([OPENAI], {
			openai: {
				state: "unavailable",
				reason: "rate_limited",
				attemptedAt: NOW - 5 * 60_000,
				retryAfterMs: 4_500,
			},
		});
		expect(unavailable.cards[0]?.updated).toEqual({
			text: "Last attempt 5m ago",
			tone: "warning",
		});
		expect(unavailable.cards[0]?.lines).toEqual([
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

		const unsupported = build([UNSUPPORTED], {
			zen: {
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW - 30_000,
			},
		});
		expect(unsupported.cards[0]?.updated).toBeUndefined();
		expect(unsupported.cards[0]?.lines).toEqual([
			{
				id: "quota:title",
				kind: "status",
				text: "Quota unavailable",
				tone: "warning",
			},
		]);

		const notApplicable = build([UNSUPPORTED], {
			zen: {
				state: "not-applicable",
				reason: "no_quota",
				attemptedAt: NOW - 30_000,
			},
		});
		expect(notApplicable.cards[0]?.updated).toBeUndefined();
		expect(notApplicable.cards[0]?.lines).toEqual([
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

	test("renders a missing read as a warning without inventing an update age", () => {
		const model = build([FUTURE], {});
		expect(model.cards[0]?.updated).toBeUndefined();
		expect(model.cards[0]?.lines).toEqual([
			{
				id: "quota:pending",
				kind: "status",
				text: "Not loaded yet. Refresh to load.",
				tone: "warning",
			},
		]);
		expect(JSON.stringify(model)).not.toContain("Updated never");
	});

	test("explains empty scopes and an empty section list", () => {
		const emptySection = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [available("app", [])],
			},
		});
		expect(emptySection.cards[0]?.lines).toEqual([
			{
				id: "0:app:empty",
				kind: "status",
				text: `${SCOPE_LABELS.app}: No quota values were reported for this scope.`,
				tone: "warning",
			},
		]);

		const emptyRead = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [],
			},
		});
		expect(emptyRead.cards[0]?.updated).toBeUndefined();
		expect(emptyRead.cards[0]?.lines).toEqual([
			{
				id: "quota:empty",
				kind: "status",
				text: "No quota sections were reported.",
				tone: "warning",
			},
		]);
	});

	test("keeps freshness to updated or last attempt and omits it otherwise", () => {
		const attemptOnly = build([OPENAI], {
			openai: partial([
				{
					scope: "app",
					result: {
						state: "unavailable",
						reason: "timeout",
						attemptedAt: NOW - 5 * 60_000,
					},
				},
			]),
		});
		expect(attemptOnly.cards[0]?.updated).toEqual({
			text: "Last attempt 5m ago",
			tone: "warning",
		});

		const unsupported = build([UNSUPPORTED], {
			zen: {
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW - 30_000,
			},
		});
		expect(unsupported.cards[0]?.updated).toBeUndefined();
	});

	test("renders a provider declared after the model was written through the generic path", () => {
		const model = build([FUTURE], {
			"future-provider": {
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
		});
		expect(model.cards).toHaveLength(1);
		expect(model.cards[0]?.id).toBe("future-provider");
		expect(model.cards[0]?.name).toBe("Future Provider");
		expect(model.cards[0]?.lines[0]).toMatchObject({
			kind: "bar",
			fill: 0.5,
			percent: { text: "50%", tone: "normal" },
		});
	});

	test("adds no auth, support, account-wide, footnote, or per-metric detail rows", () => {
		const model = build([OPENAI], {
			openai: {
				state: "available",
				authSource: "codex-companion",
				sections: [
					available("app", [
						windowMetric({
							id: "week",
							scope: "app",
							remainingPercent: 75,
							resetsAt: SAME_YEAR_RESET,
						}),
					]),
				],
			},
		});
		const serialized = JSON.stringify(model);
		for (const forbidden of [
			"Auth source",
			"supported ·",
			"Account-wide",
			"Subscription allowance",
			"oauth · provider",
			"Fetched",
			"fetched",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});

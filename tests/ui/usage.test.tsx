import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type {
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
} from "../../src/core/contracts";
import {
	buildSidebarText,
	INVENTORY_FAILED_DETAIL,
	INVENTORY_FAILED_TITLE,
	INVENTORY_RETRY_HINT,
	inventoryRecoveryCommands,
	quotaInventory,
	sidebarFallbackModel,
} from "../../src/tui";
import {
	AUTH_UNAVAILABLE_COPY,
	defaultLocaleContext,
	formatPercent,
	formatQuotaRows,
	formatResetCompact,
	NATIVE_ONLY_COPY,
	REJECTED_AUTH_COPY,
	revalidateQuota,
	UNAVAILABLE_NO_CURRENT_COPY,
	UNSUPPORTED_NO_SOURCE_COPY,
} from "../../src/ui/format";
import { sidebarQuotaPresentation } from "../../src/ui/quota-presentation";
import { Sidebar } from "../../src/ui/Sidebar";
import { buildSidebarModel } from "../../src/ui/sidebar-model";
import { UsagePage } from "../../src/ui/UsagePage";
import { buildUsagePageModel } from "../../src/ui/usage-page-model";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const LOCALE = { locale: "en-GB", timeZone: "UTC" };
const APP_RESET = Date.UTC(2026, 9, 30, 14, 0, 0);
const PLAN_RESET = Date.UTC(2026, 9, 31, 9, 30, 0);
const SECONDARY_RESET = Date.UTC(2026, 9, 24, 18, 0, 0);

function windowMetric(
	overrides: Partial<Extract<QuotaMetric, { kind: "window" }>> & {
		id: string;
	},
): QuotaMetric {
	return {
		kind: "window",
		scope: "shared-plan",
		label: "Weekly",
		windowSeconds: 604_800,
		...overrides,
	};
}

function moneyMetric(
	overrides: Partial<Extract<QuotaMetric, { kind: "money" }>> & { id: string },
): QuotaMetric {
	return {
		kind: "money",
		scope: "provider-balance",
		label: "Credits",
		currency: "USD",
		remaining: 0,
		...overrides,
	};
}

function available(
	sections: {
		scope: QuotaScope;
		metrics?: QuotaMetric[];
		state?: "available";
		configuredAppCapPercent?: number;
	}[],
	options: { fetchedAt?: number; expiresAt?: number } = {},
): QuotaRead {
	const fetchedAt = options.fetchedAt ?? NOW - 12_000;
	const expiresAt = options.expiresAt ?? NOW + 48_000;
	return {
		state: "available",
		authSource: "codex-companion",
		sections: sections.map((section) => ({
			scope: section.scope,
			result: {
				state: "available",
				metrics: section.metrics ?? [],
				fetchedAt,
				expiresAt,
				...(section.configuredAppCapPercent === undefined
					? {}
					: { configuredAppCapPercent: section.configuredAppCapPercent }),
			},
		})),
	};
}

function metricRows(rows: ReturnType<typeof formatQuotaRows>) {
	return rows.filter(
		(row) => row.scope !== undefined && !row.id.endsWith(":cap"),
	);
}

const FUTURE_PROVIDER: ProviderSummary = {
	providerID: "future-provider",
	name: "Future Provider",
	authMethod: "api-key",
	support: "supported",
	evidence: "documented-only",
};

const OPENAI_PROVIDER: ProviderSummary = {
	providerID: "openai",
	name: "OpenAI",
	integrationID: "openai",
	authMethod: "oauth",
	support: "requires-companion",
	evidence: "live-validated",
};

type CapturedCommand = {
	id?: string;
	bind?: string;
	run?: () => void | false | Promise<void>;
};

type CapturedLayer = { commands?: readonly CapturedCommand[] };

// The narrow props of the components do not match the host's
// `Record<string, unknown>` JSX component signature; these casts are only for
// calling the host renderer from the test.
const SidebarHost = Sidebar as unknown as (
	props: Record<string, unknown>,
) => unknown;
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
			base: "#ffffff",
			muted: "#aaaaaa",
			faint: "#666666",
			action: {
				primary: { base: "#c3a6ef" },
			},
			feedback: {
				error: { base: "#ff0000", muted: "#aa0000" },
				warning: { base: "#ffaa00", muted: "#aa7700" },
				success: { base: "#00ff00", muted: "#00aa00" },
				info: { base: "#00aaff", muted: "#0077aa" },
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

function futureQuota(): QuotaRead {
	return available([
		{
			scope: "provider-balance",
			metrics: [
				windowMetric({
					id: "month",
					scope: "provider-balance",
					label: "Monthly allowance",
					windowSeconds: 2_592_000,
					remainingPercent: 55,
					usedPercent: 45,
					resetsAt: PLAN_RESET,
				}),
			],
		},
	]);
}

describe("quota presentation values", () => {
	test("retained sidebar figures do not replace page failure state or freshness", () => {
		const lastKnown = available(
			[
				{
					scope: "app",
					metrics: [
						windowMetric({ id: "old", scope: "app", remainingPercent: 42 }),
					],
				},
			],
			{ fetchedAt: NOW - 3_600_000, expiresAt: NOW - 3_510_000 },
		);
		if (!("sections" in lastKnown)) throw new Error("expected history fixture");
		const quota: QuotaRead = {
			state: "unavailable",
			reason: "network_error",
			attemptedAt: NOW - 2_000,
		};
		const display = sidebarQuotaPresentation({
			quota,
			presentation: { revision: 2, lastKnown, failedSince: NOW - 180_000 },
			now: NOW,
		});
		expect(display.quota).toBe(lastKnown);
		expect(display.mightBeStale).toBe(true);
		const model = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: { openai: revalidateQuota(quota, NOW) },
			locale: LOCALE,
			now: NOW,
		});
		const serialized = JSON.stringify(model);
		expect(serialized).toContain("provider could not be reached");
		expect(model.cards[0]?.updated).toEqual({
			text: "Last attempt 2s ago",
			tone: "warning",
		});
		expect(serialized).not.toContain("42%");
		expect(serialized).not.toContain("remainingPercent");
		expect(serialized).not.toContain("Data might be stale");
	});
	test("labels_remaining_versus_used_consistently", () => {
		const read = available([
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "week",
						remainingPercent: 37,
						usedPercent: 63,
						resetsAt: PLAN_RESET,
					}),
				],
			},
		]);
		const row = metricRows(formatQuotaRows(read, LOCALE))[0];
		expect(row?.value).toContain("37% remaining");
		expect(row?.value).not.toContain("63% remaining");
		expect(row?.detail).toContain("63% used");

		const usedOnly = available([
			{
				scope: "app",
				metrics: [
					windowMetric({
						id: "used-only",
						scope: "app",
						usedPercent: 42,
					}),
				],
			},
		]);
		const usedRow = metricRows(formatQuotaRows(usedOnly, LOCALE))[0];
		expect(usedRow?.value.startsWith("42% used")).toBe(true);
	});

	test("distinguishes_zero_remaining_from_missing_values", () => {
		const read = available([
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "zero",
						remainingPercent: 0,
						usedPercent: 100,
					}),
					windowMetric({ id: "missing", label: "Primary" }),
					moneyMetric({ id: "empty-pool", remaining: 0 }),
				],
			},
		]);
		const rows = formatQuotaRows(read, { locale: "en-US", timeZone: "UTC" });
		const zero = rows.find((row) => row.id.includes("zero"));
		const missing = rows.find((row) => row.id.includes("missing"));
		const empty = rows.find((row) => row.id.includes("empty-pool"));

		expect(zero?.value.startsWith("0% remaining")).toBe(true);
		expect(zero?.tone).toBe("error");
		expect(missing?.value).toBe("Unknown (not reported)");
		expect(missing?.value).not.toContain("0%");
		expect(missing?.detail).toContain("not reported");
		expect(empty?.value.startsWith("$0.00 remaining")).toBe(true);
		expect(empty?.tone).toBe("error");
	});

	test("keeps_separate_credit_pools", () => {
		const read = available([
			{
				scope: "provider-balance",
				metrics: [
					moneyMetric({
						id: "included",
						label: "Included credits",
						remaining: 40,
						allowance: 60,
						used: 20,
						resetsAt: PLAN_RESET,
					}),
					moneyMetric({
						id: "purchased",
						label: "Purchased credits",
						remaining: 5,
					}),
					moneyMetric({
						id: "total",
						label: "Total credits",
						remaining: 45,
					}),
				],
			},
		]);
		const rows = formatQuotaRows(read, { locale: "en-US", timeZone: "UTC" });
		const included = rows.find((row) => row.id.includes("included"));
		const purchased = rows.find((row) => row.id.includes("purchased"));
		const total = rows.find((row) => row.id.includes("total"));

		expect(included?.label).toContain("Included credits");
		expect(included?.value.startsWith("$40.00 remaining")).toBe(true);
		expect(included?.detail).toContain("$20.00 used");
		expect(included?.detail).toContain("$60.00");
		expect(purchased?.value.startsWith("$5.00 remaining")).toBe(true);
		expect(purchased?.detail).not.toContain("used");
		expect(purchased?.detail).not.toContain("allowance");
		expect(total?.value.startsWith("$45.00 remaining")).toBe(true);
		expect(total?.detail).not.toContain("allowance");
	});

	test("keeps_app_and_shared_plan_weeks_separate", () => {
		const read = available([
			{
				scope: "app",
				configuredAppCapPercent: 100,
				metrics: [
					windowMetric({
						id: "app-week",
						scope: "app",
						remainingPercent: 90,
						usedPercent: 10,
						resetsAt: APP_RESET,
					}),
				],
			},
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "primary",
						label: "Primary window",
						remainingPercent: 80,
						usedPercent: 20,
						resetsAt: PLAN_RESET,
					}),
					windowMetric({
						id: "secondary",
						label: "Secondary window",
						windowSeconds: 18_000,
						remainingPercent: 70,
						usedPercent: 30,
						resetsAt: SECONDARY_RESET,
					}),
				],
			},
		]);
		const rows = formatQuotaRows(read, LOCALE);
		const metrics = metricRows(rows);
		expect(metrics.map((row) => row.scope)).toEqual([
			"app",
			"shared-plan",
			"shared-plan",
		]);
		expect(metrics[0]?.value).toContain("90% remaining");
		expect(metrics[1]?.value).toContain("80% remaining");
		expect(metrics[2]?.value).toContain("70% remaining");
		expect(metrics[0]?.detail).toContain("2026-10-30 14:00:00 UTC");
		expect(metrics[1]?.detail).toContain("2026-10-31 09:30:00 UTC");
		expect(metrics[2]?.detail).toContain("2026-10-24 18:00:00 UTC");

		const cap = rows.find((row) => row.id.endsWith(":cap"));
		expect(cap?.value).toBe("100% allowed");
		expect(cap?.detail).toContain("never remaining quota");
		expect(rows.some((row) => row.value.includes("100% remaining"))).toBe(
			false,
		);
	});

	test("formats_resets_in_identified_timezone_with_full_timestamp_details", () => {
		const read = available([
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "reset",
						remainingPercent: 55,
						usedPercent: 45,
						resetsAt: PLAN_RESET,
					}),
				],
			},
		]);
		const row = metricRows(formatQuotaRows(read, LOCALE))[0];
		expect(row?.value).toContain("31 Oct 2026");
		expect(row?.value).toContain("UTC");
		expect(row?.detail).toContain("2026-10-31 09:30:00 UTC");
		expect(row?.detail).toContain("window 7 d");

		const noReset = available([
			{
				scope: "shared-plan",
				metrics: [windowMetric({ id: "no-reset", remainingPercent: 55 })],
			},
		]);
		const noResetRow = metricRows(formatQuotaRows(noReset, LOCALE))[0];
		expect(noResetRow?.value).not.toContain("resets");
		expect(noResetRow?.detail).toContain("no reset reported");
	});

	test("page_freshness_is_updated_or_last_attempt_without_fabricating_never", () => {
		const read = available([
			{ scope: "shared-plan", metrics: [windowMetric({ id: "week" })] },
		]);
		const model = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: { openai: read },
			locale: LOCALE,
			now: NOW,
		});
		expect(model.cards[0]?.updated).toEqual({
			text: "Updated 12s ago",
			tone: "success",
		});

		const partial: QuotaRead = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				{
					scope: "shared-plan",
					result: {
						state: "available",
						metrics: [windowMetric({ id: "fresh" })],
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
					},
				},
				{
					scope: "app",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 2_000,
					},
				},
			],
		};
		expect(
			buildUsagePageModel({
				providers: [OPENAI_PROVIDER],
				quotaByProvider: { openai: partial },
				locale: LOCALE,
				now: NOW,
			}).cards[0]?.updated,
		).toEqual({ text: "Updated 12s ago", tone: "success" });

		const attemptOnly = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: {
				openai: {
					state: "partial",
					authSource: "codex-companion",
					sections: [
						{
							scope: "app",
							result: {
								state: "unavailable",
								reason: "rate_limited",
								attemptedAt: NOW - 2_000,
							},
						},
					],
				},
			},
			locale: LOCALE,
			now: NOW,
		});
		expect(attemptOnly.cards[0]?.updated).toEqual({
			text: "Last attempt 2s ago",
			tone: "warning",
		});

		const unsupported = buildUsagePageModel({
			providers: [FUTURE_PROVIDER],
			quotaByProvider: {
				"future-provider": {
					state: "unsupported",
					reason: "no_validated_quota_source",
					attemptedAt: NOW - 2_000,
				},
			},
			locale: LOCALE,
			now: NOW,
		});
		expect(unsupported.cards[0]?.updated).toBeUndefined();
	});
});

describe("unavailable state copy", () => {
	test("auth_unavailable_copy_names_the_chatgpt_codex_app_on_this_machine", () => {
		for (const reason of [
			"companion_missing",
			"companion_expired",
			"app_registration_mismatch",
			"invalid_companion",
		]) {
			const rows = formatQuotaRows(
				{ state: "auth-required", reason, attemptedAt: NOW },
				LOCALE,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.value).toBe(AUTH_UNAVAILABLE_COPY);
			expect(rows[0]?.tone).toBe("error");
		}
		expect(AUTH_UNAVAILABLE_COPY).toContain(
			"ChatGPT/Codex app on this machine",
		);
	});

	test("native_only_openai_copy_is_exact_and_does_not_request_a_new_api_key", () => {
		const rows = formatQuotaRows(
			{
				state: "unavailable",
				reason: "companion_disabled",
				attemptedAt: NOW,
			},
			LOCALE,
		);
		expect(rows[0]?.value).toBe(NATIVE_ONLY_COPY);
		expect(rows[0]?.value).toBe(
			"Quota unavailable: the Codex companion is turned off in this OpenCode configuration. Remove the codexCompanion opt-out to read the existing ChatGPT/Codex login.",
		);
		expect(rows[0]?.value.toLowerCase()).not.toContain("new api key");
	});

	test("unsupported_auth_copy_points_at_connect_without_blaming_the_method", () => {
		const rows = formatQuotaRows(
			{
				state: "auth-required",
				reason: "unsupported_auth_method",
				attemptedAt: NOW,
			},
			LOCALE,
		);
		expect(rows[0]?.value).toBe(REJECTED_AUTH_COPY);
		expect(rows[0]?.value).toContain("/connect");
		expect(rows[0]?.value.toLowerCase()).toContain("rejected");
		expect(rows[0]?.value.toLowerCase()).not.toContain("method is unsupported");
		expect(rows[0]?.value.toLowerCase()).not.toContain("unsupported method");
	});

	test("state_field_separates_unsupported_from_expired_or_stale", () => {
		const unsupported = formatQuotaRows(
			{
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW,
			},
			LOCALE,
		);
		const stale = formatQuotaRows(
			{
				state: "unavailable",
				reason: "no_validated_quota_source",
				attemptedAt: NOW,
			},
			LOCALE,
		);
		expect(unsupported[0]?.value).toBe(UNSUPPORTED_NO_SOURCE_COPY);
		expect(unsupported[0]?.value).not.toContain("expired");
		expect(stale[0]?.value).toBe(UNAVAILABLE_NO_CURRENT_COPY);
		expect(stale[0]?.value).toContain("expired");
		expect(unsupported[0]?.value).not.toBe(stale[0]?.value);
	});
});

describe("page constraints and narrow terminals", () => {
	test("page_model_never_drops_a_constraint_or_state", () => {
		const metrics = Array.from({ length: 8 }, (_, index) =>
			windowMetric({
				id: `window-${index}`,
				label: `Window ${index + 1}`,
				remainingPercent: 90 - index,
				usedPercent: 10 + index,
				resetsAt: PLAN_RESET + index * 60_000,
			}),
		);
		const read: QuotaRead = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [metrics[0] as QuotaMetric],
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
						configuredAppCapPercent: 100,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "available",
						metrics: metrics.slice(1),
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 5_000,
						retryAfterMs: 60_000,
					},
				},
			],
		};
		const model = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: { openai: read },
			locale: LOCALE,
			now: NOW,
		});
		const lines = model.cards[0]?.lines ?? [];
		expect(lines).toHaveLength(10);
		expect(lines.filter((line) => line.kind === "window")).toHaveLength(8);
		expect(model.cards[0]?.updated).toEqual({
			text: "Updated 12s ago",
			tone: "success",
		});
		const serialized = JSON.stringify(model);
		for (let index = 1; index <= 8; index += 1) {
			expect(serialized).toContain(`Window ${index}`);
		}
		expect(serialized).toContain("rate limit");
		expect(serialized).toContain("100% allowed");
		expect(serialized).toContain("Configured app cap");
		expect(serialized).not.toContain("remainingPercent");
	});

	test("renders_unregistered_at_construction_provider_from_declarations", () => {
		const quota = available([
			{
				scope: "provider-balance",
				metrics: [
					windowMetric({
						id: "month",
						scope: "provider-balance",
						label: "Monthly allowance",
						windowSeconds: 2_592_000,
						remainingPercent: 55,
						usedPercent: 45,
						resetsAt: PLAN_RESET,
					}),
				],
			},
		]);
		const model = buildUsagePageModel({
			providers: [FUTURE_PROVIDER],
			quotaByProvider: { "future-provider": quota },
			locale: LOCALE,
			now: NOW,
		});
		expect(model.cards).toHaveLength(1);
		expect(model.cards[0]?.id).toBe("future-provider");
		expect(model.cards[0]?.name).toBe("Future Provider");
		expect(model.cards[0]?.updated).toEqual({
			text: "Updated 12s ago",
			tone: "success",
		});
		expect(model.cards[0]?.lines).toEqual([
			{
				id: "0:provider-balance:month",
				kind: "window",
				label: "Provider balance · Monthly allowance",
				value: { text: "45%", tone: "normal" },
				fill: 0.45,
				reset: formatResetCompact(PLAN_RESET, LOCALE, NOW),
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("supported");
		expect(serialized).not.toContain("documented-only");
		expect(serialized).not.toContain("Auth source");
		expect(serialized).not.toContain("remainingPercent");

		const uiSource = [
			"format.ts",
			"Sidebar.tsx",
			"UsagePage.tsx",
			"usage-page-model.ts",
			"bar-row.tsx",
			"theme.ts",
			"sidebar-model.ts",
		]
			.map((file) =>
				readFileSync(new URL(`../../src/ui/${file}`, import.meta.url), "utf8"),
			)
			.join("\n");
		expect(uiSource).not.toContain("future-provider");
		expect(uiSource).not.toMatch(/providerID\s*===/);
		expect(uiSource).not.toMatch(/provider\.name\s*===/);
	});

	test("sidebar_stays_compact_without_dropping_constraints", () => {
		const read = available([
			{
				scope: "app",
				configuredAppCapPercent: 100,
				metrics: [
					windowMetric({
						id: "app-week",
						scope: "app",
						label: "Current app limit",
						remainingPercent: 90,
						usedPercent: 10,
						resetsAt: APP_RESET,
					}),
				],
			},
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "primary",
						label: "Primary",
						remainingPercent: 80,
						usedPercent: 20,
						resetsAt: PLAN_RESET,
					}),
					windowMetric({
						id: "secondary",
						label: "Secondary",
						windowSeconds: 18_000,
						remainingPercent: 70,
						usedPercent: 30,
						resetsAt: SECONDARY_RESET,
					}),
					windowMetric({
						id: "custom",
						label: "Custom daily window",
						windowSeconds: 86_400,
						remainingPercent: 60,
						usedPercent: 40,
					}),
				],
			},
		]);
		const text = buildSidebarText({
			selection: { providerID: "openai", label: "OpenAI" },
			provider: OPENAI_PROVIDER,
			quota: read,
			loading: false,
			locale: LOCALE,
			now: NOW,
		});
		expect(text).not.toBeNull();
		const lines = text?.split("\n") ?? [];
		// Header + four independently reported windows, no timestamp footer.
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe("OpenAI");
		expect(lines.filter((line) => line.includes("% remaining"))).toHaveLength(
			4,
		);
		expect(text).not.toContain("100% allowed");
		expect(text).not.toContain("Updated");

		const many = available([
			{
				scope: "shared-plan",
				metrics: Array.from({ length: 8 }, (_, index) =>
					windowMetric({
						id: `window-${index}`,
						label: `Window ${index + 1}`,
						remainingPercent: 50 - index,
					}),
				),
			},
		]);
		const manyText = buildSidebarText({
			selection: { providerID: "openai", label: "OpenAI" },
			provider: OPENAI_PROVIDER,
			quota: many,
			loading: false,
			locale: LOCALE,
			now: NOW,
		});
		const manyLines = manyText?.split("\n") ?? [];
		// Header + eight independent constraints; never truncated or footed.
		expect(manyLines).toHaveLength(9);
		expect(
			manyLines.filter((line) => line.includes("% remaining")),
		).toHaveLength(8);
	});

	test("revalidates_expired_sections_before_rendering", () => {
		const read: QuotaRead = {
			state: "available",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "expired-app",
								scope: "app",
								remainingPercent: 90,
								usedPercent: 10,
								resetsAt: APP_RESET,
							}),
						],
						fetchedAt: NOW - 80_000,
						expiresAt: NOW - 1,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "fresh-plan",
								remainingPercent: 80,
								usedPercent: 20,
								resetsAt: PLAN_RESET,
							}),
						],
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
					},
				},
			],
		};
		const revalidated = revalidateQuota(read, NOW);
		expect(revalidated.state).toBe("partial");
		if (!("sections" in revalidated)) {
			throw new Error("expected sections");
		}
		expect(revalidated.sections[0]?.result.state).toBe("unavailable");
		expect(revalidated.sections[1]?.result.state).toBe("available");

		const model = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: { openai: revalidated },
			locale: LOCALE,
			now: NOW,
		});
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("90%");
		expect(serialized).not.toContain("10%");
		expect(serialized).toContain(UNAVAILABLE_NO_CURRENT_COPY);
		expect(serialized).toContain("20%");
		expect(model.cards[0]?.updated).toEqual({
			text: "Updated 12s ago",
			tone: "success",
		});

		const allExpired = revalidateQuota(
			available(
				[
					{
						scope: "shared-plan",
						metrics: [windowMetric({ id: "stale", remainingPercent: 90 })],
					},
				],
				{ expiresAt: NOW - 1 },
			),
			NOW,
		);
		expect(allExpired.state).toBe("partial");
		const staleModel = buildUsagePageModel({
			providers: [OPENAI_PROVIDER],
			quotaByProvider: { openai: allExpired },
			locale: LOCALE,
			now: NOW,
		});
		const staleSerialized = JSON.stringify(staleModel);
		expect(staleSerialized).not.toContain("90%");
		expect(staleSerialized).toContain(UNAVAILABLE_NO_CURRENT_COPY);
	});
});

describe("host-rendered wrappers", () => {
	test("usage_page_renders_declaration_driven_rows_and_keyboard_actions", async () => {
		const { context, layers } = mockHostContext();
		const refreshes: string[] = [];
		let backs = 0;
		const setup = await testRender(
			() =>
				jsx(ProviderHost, {
					value: context as never,
					get children() {
						return jsx(UsagePageHost, {
							providers: [FUTURE_PROVIDER],
							quotaByProvider: { "future-provider": futureQuota() },
							refresh: (providerID: string) => refreshes.push(providerID),
							back: () => {
								backs += 1;
							},
						});
					},
				}),
			{ width: 80, height: 40 },
		);
		const pageLocale = defaultLocaleContext();
		const pageReset = formatResetCompact(
			PLAN_RESET,
			pageLocale,
			Date.now(),
		).replace(/\s+/g, "");
		const pagePercent45 = `${formatPercent(45, pageLocale)}%`;
		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame().replace(/\s+/g, "");
			expect(frame).toContain("Providerusage");
			expect(frame).toContain("Connectedaccounts·quota&balances");
			expect(frame).toContain("FutureProvider");
			expect(frame).toContain("Updated");
			expect(frame).toContain("Providerbalance·Monthlyallowance");
			expect(frame).toContain(pagePercent45);
			expect(frame).toContain(pageReset);
			expect(frame).toContain("[esc]back[ctrl+r]refresh");
			expect(frame).not.toContain("supported·documented-only");
			expect(frame).not.toContain("Authsource");

			const commands = layers[0]?.commands ?? [];
			const back = commands.find(
				(command) => command.id === "provider-quota.page.back",
			);
			const refresh = commands.find(
				(command) => command.id === "provider-quota.page.refresh",
			);
			expect(back?.bind).toBe("escape");
			expect(refresh?.bind).toBe("ctrl+r");
			await back?.run?.();
			await refresh?.run?.();
			expect(backs).toBe(1);
			expect(refreshes).toEqual(["future-provider"]);

			setup.resize(32, 60);
			await setup.renderOnce();
			const narrowFrame = setup.captureCharFrame();
			const narrow = narrowFrame.replace(/\s+/g, "");
			expect(narrow).toContain("FutureProvider");
			expect(narrow).toContain("Providerbalance");
			expect(narrow).toContain("Monthly");
			expect(narrow).toContain("allowance");
			expect(narrow).toContain(pagePercent45);
			expect(narrow).toContain(pageReset);
			expect(
				narrowFrame
					.split("\n")
					.map((line) => line.trimEnd())
					.every((line) => line.length <= 32),
			).toBe(true);
		} finally {
			await setup.dispose();
		}
	});

	test("sidebar_wrapper_renders_static_tree_and_opens_usage_without_fetching", async () => {
		const { context } = mockHostContext();
		const read: QuotaRead = {
			state: "partial",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "app-week",
								scope: "app",
								label: "Current app limit",
								remainingPercent: 90,
								usedPercent: 10,
								resetsAt: APP_RESET,
							}),
						],
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
					},
				},
				{
					scope: "shared-plan",
					result: {
						state: "available",
						metrics: [
							windowMetric({
								id: "secondary",
								label: "Secondary",
								windowSeconds: 18_000,
								remainingPercent: 70,
								usedPercent: 30,
								resetsAt: SECONDARY_RESET,
							}),
						],
						fetchedAt: NOW - 12_000,
						expiresAt: NOW + 48_000,
					},
				},
				{
					scope: "app",
					result: {
						state: "unavailable",
						reason: "rate_limited",
						attemptedAt: NOW - 5_000,
						retryAfterMs: 60_000,
					},
				},
			],
		};
		const model = buildSidebarModel(OPENAI_PROVIDER, read, LOCALE, NOW);
		let opened = 0;
		const setup = await testRender(
			() =>
				jsx(SidebarHost, {
					model,
					theme: context.theme,
					openUsage: () => {
						opened += 1;
					},
				}),
			{ width: 60, height: 30 },
		);
		const capturedLines = (frame: string): string[] =>
			frame
				.split("\n")
				.map((line) => line.trimEnd())
				.filter((line) => line.length > 0);
		try {
			await setup.renderOnce();
			const wideFrame = setup.captureCharFrame();
			const wideLines = capturedLines(wideFrame);
			// The block starts with the provider-name title, not one joined
			// diagnostic string.
			expect(wideLines[0]?.startsWith(" OpenAI")).toBe(true);
			expect(wideLines[0]?.endsWith("OpenAI")).toBe(true);
			expect(wideLines.every((line) => line.length <= 60)).toBe(true);
			const wide = wideLines.join(" ");
			expect(wide).toContain("7d");
			expect(wide).toContain("10%");
			expect(wide).toContain("resets 6d 2h");
			expect(wide).not.toContain("Shared");
			expect(wide).not.toContain("70%");
			expect(wide.replace(/\s+/g, "")).toContain(
				"Quotaunavailable:theproviderratelimit".replace(/\s+/g, ""),
			);
			expect(wide).not.toContain("updated");
			expect(wide).not.toContain("View all providers");
			expect(wide).not.toContain("requires companion");
			expect(wide).not.toContain("live-validated");

			// The whole card is the click target, including body rows.
			await setup.mockMouse.click(3, 1);
			await setup.renderOnce();
			expect(opened).toBe(1);

			setup.resize(24, 30);
			await setup.renderOnce();
			const narrowLines = capturedLines(setup.captureCharFrame());
			expect(narrowLines[0]?.startsWith(" OpenAI")).toBe(true);
			expect(narrowLines.every((line) => line.length <= 24)).toBe(true);
			expect(narrowLines.length).toBeGreaterThan(wideLines.length);
			const narrow = narrowLines.join(" ");
			expect(narrow).toContain("7d");
			expect(narrow).toContain("10%");
			expect(narrow.replace(/\s+/g, "")).toContain("resets6d2h");
			expect(narrow).not.toContain("Shared");
			expect(narrow).not.toContain("70%");
			expect(narrow).not.toContain("updated");
			expect(narrow).not.toContain("View all providers");
		} finally {
			await setup.dispose();
		}
	});

	test("sidebar_text_uses_compact_presentation_and_keeps_pinned_states", () => {
		const read = available([
			{
				scope: "app",
				configuredAppCapPercent: 100,
				metrics: [
					windowMetric({
						id: "app-week",
						scope: "app",
						label: "Current app limit",
						remainingPercent: 90,
						usedPercent: 10,
						resetsAt: APP_RESET,
					}),
				],
			},
			{
				scope: "shared-plan",
				metrics: [
					windowMetric({
						id: "secondary",
						label: "Secondary",
						windowSeconds: 18_000,
						remainingPercent: 70,
						usedPercent: 30,
						resetsAt: SECONDARY_RESET,
					}),
				],
			},
		]);
		const rows = buildSidebarText({
			selection: { providerID: "openai", label: "OpenAI" },
			provider: OPENAI_PROVIDER,
			quota: read,
			loading: false,
			locale: LOCALE,
			now: NOW,
		});
		expect(rows).not.toBeNull();
		const lines = rows?.split("\n") ?? [];
		// One header name, no trailing colon, no healthy support diagnostics.
		expect(lines[0]).toBe("OpenAI");
		expect(lines[0]).not.toContain(":");
		expect(rows).not.toContain("requires companion");
		expect(rows).not.toContain("live-validated");
		// Window rows keep their reported duration and visible reset.
		const appRow = lines.find((line) => line.startsWith("App 7d: "));
		expect(appRow).toBeDefined();
		expect(appRow).toContain("90% remaining");
		expect(appRow).toContain(" · resets ");
		expect(appRow).toMatch(/resets .*14:00/);
		const sharedRow = lines.find((line) => line.startsWith("Shared 5h: "));
		expect(sharedRow).toBeDefined();
		expect(sharedRow).toContain("70% remaining");
		expect(sharedRow).toMatch(/resets .*18:00/);
		// Healthy support rows and configured caps stay on /usage, and the
		// sidebar never carries full timestamp details.
		expect(rows).not.toContain("100% allowed");
		expect(rows).not.toContain("2026-");
		// The old timestamp footer is gone from both text and rendered forms.
		expect(rows).not.toContain("Updated");
		expect(lines.at(-1)).toContain("Shared 5h:");

		expect(
			buildSidebarText({
				selection: undefined,
				provider: undefined,
				quota: undefined,
				loading: false,
				locale: LOCALE,
			}),
		).toBeNull();
		expect(
			buildSidebarText({
				selection: { label: "No provider selected" },
				provider: undefined,
				quota: undefined,
				loading: false,
				locale: LOCALE,
			}),
		).toBe("No provider selected");
		expect(
			buildSidebarText({
				selection: { providerID: "openai", label: "OpenAI" },
				provider: undefined,
				quota: undefined,
				loading: true,
				locale: LOCALE,
			}),
		).toBe("OpenAI: checking quota");
		expect(
			buildSidebarText({
				selection: { providerID: "openai", label: "OpenAI" },
				provider: undefined,
				quota: undefined,
				loading: false,
				locale: LOCALE,
			}),
		).toBe("OpenAI: quota unavailable");
	});

	test("sidebar_header_names_the_codex_quota_source_without_healthy_diagnostics", () => {
		const companionProvider: ProviderSummary = {
			providerID: "openai",
			name: "OpenAI ChatGPT with Codex companion",
			integrationID: "openai",
			authMethod: "oauth",
			support: "requires-companion",
			evidence: "live-validated",
		};
		const companion = buildSidebarText({
			selection: { providerID: "openai", label: companionProvider.name },
			provider: companionProvider,
			quota: {
				state: "auth-required",
				reason: "companion_expired",
				attemptedAt: NOW,
			},
			loading: false,
			locale: LOCALE,
			now: NOW,
		});
		expect(companion?.split("\n")[0]).toBe("OpenAI · Codex quota");
		expect(companion).not.toContain("requires companion");
		expect(companion).not.toContain("live-validated");
		expect(companion).toContain(AUTH_UNAVAILABLE_COPY);

		const future = buildSidebarText({
			selection: { providerID: "future-provider", label: FUTURE_PROVIDER.name },
			provider: FUTURE_PROVIDER,
			quota: {
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW,
			},
			loading: false,
			locale: LOCALE,
			now: NOW,
		});
		expect(future?.split("\n")[0]).toBe("Future Provider");
	});

	test("unselected_and_pending_states_keep_explicit_structured_messages", () => {
		expect(
			sidebarFallbackModel({ selection: undefined, loading: false }),
		).toBeNull();
		const unselected = sidebarFallbackModel({
			selection: { label: "No provider selected" },
			loading: false,
		});
		expect(unselected?.provider).toBe("No provider selected");
		expect(unselected?.lines).toEqual([
			{
				id: "selection",
				kind: "status",
				text: "Select a provider to see its quota.",
				tone: "muted",
			},
		]);

		const loading = sidebarFallbackModel({
			selection: { providerID: "openai", label: "OpenAI" },
			loading: true,
		});
		expect(loading?.lines).toEqual([
			{
				id: "quota:pending",
				kind: "status",
				text: "Checking quota…",
				tone: "muted",
			},
		]);

		const missing = sidebarFallbackModel({
			selection: { providerID: "openai", label: "OpenAI" },
			loading: false,
		});
		expect(missing?.lines).toEqual([
			{
				id: "quota:pending",
				kind: "status",
				text: "Quota unavailable: no current result was returned.",
				tone: "error",
			},
		]);
	});

	test("host_children_are_static_leaves_and_slot_render_reads_only_the_model", () => {
		for (const file of [
			"src/tui.tsx",
			"src/ui/Sidebar.tsx",
			"src/ui/UsagePage.tsx",
			"src/ui/usage-page-model.ts",
			"src/ui/bar-row.tsx",
			"src/ui/theme.ts",
			"src/ui/sidebar-model.ts",
		]) {
			const source = readFileSync(
				new URL(`../../${file}`, import.meta.url),
				"utf8",
			);
			expect(source).not.toMatch(/children:\s*\(\s*\)\s*=>/);
			expect(source).not.toMatch(/children:\s*function/);
		}

		const tui = readFileSync(
			new URL("../../src/tui.tsx", import.meta.url),
			"utf8",
		);
		expect(tui).not.toContain("QuotaSidebar");
		// Compatibility helper remains exported, but the live slot does not use
		// the joined text path.
		expect(tui).toContain("export function buildSidebarText");
		expect(tui).toContain("createSignal<SidebarModel | null>");
		expect(tui).toContain("createSignal<SidebarTheme>(");
		expect(tui).toContain("createEffect(() => {");
		expect(tui).toContain(
			"setSidebarTheme(resolveSidebarTheme(context.theme))",
		);
		const slotStart = tui.indexOf('append: "sidebar.footer"');
		expect(slotStart).toBeGreaterThanOrEqual(0);
		const renderStart = tui.indexOf("render: () => {", slotStart);
		const renderEnd = tui.indexOf("\n\t\t\t},", renderStart);
		expect(renderStart).toBeGreaterThanOrEqual(0);
		expect(renderEnd).toBeGreaterThan(renderStart);
		const slotRender = tui.slice(renderStart, renderEnd);
		expect(slotRender).toContain("const model = sidebarModel()");
		expect(slotRender).toContain(
			"renderSidebar(model, sidebarTheme(), openUsage)",
		);
		expect(slotRender).not.toContain("currentSelection");
		expect(slotRender).not.toContain("sidebarDriver");
		expect(slotRender).not.toContain("buildSidebarText");
		expect(slotRender).not.toContain("context.");
		expect(slotRender).not.toContain("context.theme");
		expect(slotRender).not.toContain("resolveSidebarTheme");

		const sidebar = readFileSync(
			new URL("../../src/ui/Sidebar.tsx", import.meta.url),
			"utf8",
		);
		expect(sidebar).toContain("export function renderSidebar");
		expect(sidebar).toContain("resolveSidebarTheme(props.theme)");
		expect(sidebar).toContain("onMouseDown: openUsage");
		expect(sidebar).toMatch(/paddingLeft: 1,\s*onMouseDown: openUsage/);
		expect(sidebar).not.toContain("View all providers");
		expect(sidebar).not.toContain('border: ["left"]');
		expect(sidebar).not.toContain('key: "open-usage"');
		expect(sidebar).not.toContain("createEffect");
		expect(sidebar).not.toContain("createMemo");
		expect(sidebar).not.toContain("usePlugin");
		const renderBody = sidebar.slice(
			sidebar.indexOf("export function renderSidebar"),
			sidebar.indexOf("/** Component wrapper"),
		);
		expect(renderBody).not.toContain("context.");
		expect(renderBody).not.toContain("theme.text");
		expect(renderBody).not.toContain("resolveSidebarTheme");
	});

	test("inventory_failure_is_truthful_and_retryable", () => {
		const ready = {
			version: 2,
			providers: [{ provider: FUTURE_PROVIDER, quota: futureQuota() }],
		};
		expect(quotaInventory(undefined, undefined)).toEqual({
			state: "loading",
		});
		expect(quotaInventory(null, undefined)).toEqual({ state: "failed" });
		expect(quotaInventory(undefined, new Error("inventory down"))).toEqual({
			state: "failed",
		});
		expect(quotaInventory(ready, undefined)).toEqual({
			state: "ready",
			result: ready,
		});

		expect(INVENTORY_FAILED_TITLE).toBe("Provider inventory unavailable");
		expect(INVENTORY_FAILED_DETAIL).toBe(
			"Quota could not be read from the server. No figures are shown.",
		);
		expect(INVENTORY_RETRY_HINT).toContain("ctrl+r");
		expect(INVENTORY_RETRY_HINT).toContain("esc");

		const calls: string[] = [];
		const commands = inventoryRecoveryCommands({
			retry: () => calls.push("retry"),
			back: () => calls.push("back"),
		});
		const retry = commands.find(
			(command) => command.id === "provider-quota.recovery.retry",
		);
		const back = commands.find(
			(command) => command.id === "provider-quota.recovery.back",
		);
		expect(retry?.bind).toBe("ctrl+r");
		expect(back?.bind).toBe("escape");
		retry?.run();
		back?.run();
		expect(calls).toEqual(["retry", "back"]);
	});
});

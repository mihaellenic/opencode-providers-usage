import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type {
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
} from "../../src/core/contracts";
import { unavailableCopy } from "../../src/ui/format";
import { buildSidebarModel } from "../../src/ui/sidebar-model";
import { buildUsagePageModel } from "../../src/ui/usage-page-model";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const LOCALE = { locale: "en-US", timeZone: "UTC" };

const OPENAI: ProviderSummary = {
	providerID: "openai",
	name: "OpenAI ChatGPT with Codex companion",
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

function available(
	sections: {
		scope: "app" | "shared-plan" | "provider-balance";
		metrics: QuotaMetric[];
		configuredAppCapPercent?: number;
	}[],
): QuotaRead {
	return {
		state: "available",
		authSource: "codex-companion",
		sections: sections.map((section) => ({
			scope: section.scope,
			result: {
				state: "available" as const,
				metrics: section.metrics,
				fetchedAt: NOW - 30_000,
				expiresAt: NOW + 60_000,
				...(section.configuredAppCapPercent === undefined
					? {}
					: { configuredAppCapPercent: section.configuredAppCapPercent }),
			},
		})),
	};
}

function build(
	providers: ProviderSummary[],
	quotaByProvider: Record<string, QuotaRead>,
	displayNames?: Record<string, string>,
	claudeUsage?: ClaudeUsage | null,
) {
	return buildUsagePageModel({
		providers,
		quotaByProvider,
		displayNames,
		claudeUsage,
		locale: LOCALE,
		now: NOW,
	});
}

const CLAUDE_USAGE: ClaudeUsage = {
	session: {
		usedPercent: 37,
		resetsAt: NOW + 11 * 3_600_000 + 7 * 60_000,
	},
	week: {
		usedPercent: 64,
		resetsAt: NOW + 4 * 86_400_000 + 2 * 3_600_000,
	},
};

describe("buildUsagePageModel", () => {
	test("reuses the sidebar widget rows and drops page-only data", () => {
		const read = available([
			{
				scope: "app",
				configuredAppCapPercent: 100,
				metrics: [
					{
						kind: "window",
						id: "weekly",
						scope: "app",
						label: "Current app limit",
						windowSeconds: 604_800,
						remainingPercent: 75,
						resetsAt: NOW + 2 * 86_400_000 + 4 * 3_600_000,
					},
					{
						kind: "window",
						id: "five-hour",
						scope: "app",
						label: "Current app limit",
						windowSeconds: 18_000,
						remainingPercent: 41,
						resetsAt: NOW + 8 * 3_600_000,
					},
				],
			},
			{
				scope: "shared-plan",
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
			},
		]);
		const model = build([OPENAI], { openai: read }, { openai: "OpenAI" });
		const widget = buildSidebarModel(OPENAI, read, LOCALE, NOW, "OpenAI");

		expect(model.cards).toEqual([
			{ id: "openai", name: "OpenAI", lines: widget.lines },
		]);
		expect(model.cards[0]).not.toHaveProperty("updated");
		const serialized = JSON.stringify(model);
		expect(serialized).toContain("5h");
		expect(serialized).toContain("7d");
		expect(serialized).toContain("resets 8h");
		expect(serialized).not.toContain("Configured app cap");
		expect(serialized).not.toContain("Shared plan");
		expect(serialized).not.toContain("Updated");
		expect(serialized).not.toContain("remainingPercent");
	});

	test("folds the total pool into the sidebar pair without a total row", () => {
		const read = available([
			{
				scope: "provider-balance",
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
			},
		]);
		const model = build([OLLAMA], { ollama: read });
		const widget = buildSidebarModel(OLLAMA, read, LOCALE, NOW);

		expect(model.cards[0]?.lines).toEqual(widget.lines);
		expect(model.cards[0]?.lines).toHaveLength(2);
		expect(JSON.stringify(model)).not.toContain("Total credits");
	});

	test("renders a missing read as pending with the resolved name", () => {
		const model = build([FUTURE], {}, { "future-provider": "Future" });
		expect(model.cards).toEqual([
			{
				id: "future-provider",
				name: "Future",
				lines: [
					{
						id: "quota:pending",
						kind: "status",
						text: "Not loaded yet. Refresh to load.",
						tone: "warning",
					},
				],
			},
		]);
	});

	test("falls back to the summary name when the host label is absent or the id", () => {
		const read = available([{ scope: "app", metrics: [] }]);
		for (const displayNames of [
			undefined,
			{ openai: "" },
			{ openai: "openai" },
		]) {
			const model = build([OPENAI], { openai: read }, displayNames);
			expect(model.cards[0]?.name).toBe("OpenAI ChatGPT with Codex companion");
		}
	});

	test("passes through whole-read and per-scope unavailable copy", () => {
		const unsupported = build([FUTURE], {
			"future-provider": {
				state: "unsupported",
				reason: "no_validated_quota_source",
				attemptedAt: NOW - 2_000,
			},
		});
		expect(unsupported.cards[0]?.lines).toEqual([
			{
				id: "quota:title",
				kind: "status",
				text: "Quota unavailable",
				tone: "warning",
			},
		]);

		const unavailable = build([OPENAI], {
			openai: {
				state: "unavailable",
				reason: "rate_limited",
				attemptedAt: NOW - 2_000,
				retryAfterMs: 4_500,
			},
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

		const partial = build([OPENAI], {
			openai: {
				state: "partial",
				authSource: "codex-companion",
				sections: [
					{
						scope: "app",
						result: {
							state: "unavailable",
							reason: "rate_limited",
							attemptedAt: NOW - 5_000,
							retryAfterMs: 4_500,
						},
					},
					{
						scope: "shared-plan",
						result: {
							state: "available",
							metrics: [],
							fetchedAt: NOW - 12_000,
							expiresAt: NOW + 48_000,
						},
					},
				],
			},
		});
		expect(partial.cards[0]?.lines).toEqual([
			{
				id: "0:app:status",
				kind: "status",
				text: `App: ${unavailableCopy("unavailable", "rate_limited")} · retry after 5s`,
				tone: "error",
			},
		]);
	});
});

describe("buildUsagePageModel Claude Code card", () => {
	test("omits the card when Claude usage is absent", () => {
		expect(build([], {}, undefined, null).cards).toEqual([]);
		expect(build([], {}, undefined, undefined).cards).toEqual([]);
	});

	test("renders only the session and week windows as an OpenAI-style card", () => {
		const model = build([], {}, undefined, CLAUDE_USAGE);

		expect(model.cards).toEqual([
			{
				id: "claude-code",
				name: "Claude Code",
				lines: [
					{
						id: "0:app:session",
						kind: "window",
						label: "5h · Session",
						value: { text: "37%", tone: "normal" },
						fill: 0.37,
						reset: "resets 11h 7m",
					},
					{
						id: "0:app:week",
						kind: "window",
						label: "7d · Week",
						value: { text: "64%", tone: "normal" },
						fill: 0.64,
						reset: "resets 4d 2h",
					},
				],
			},
		]);
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("Opus");
		expect(serialized).not.toContain("Sonnet");
		expect(serialized).not.toContain("model-specific");
	});

	test("keeps OpenAI-style threshold tones for high usage", () => {
		const model = build([], {}, undefined, {
			session: { usedPercent: 85, resetsAt: NOW + 3_600_000 },
			week: { usedPercent: 100, resetsAt: NOW + 86_400_000 },
		});

		expect(model.cards[0]?.lines).toEqual([
			{
				id: "0:app:session",
				kind: "window",
				label: "5h · Session",
				value: { text: "85%", tone: "warning" },
				fill: 0.85,
				reset: "resets 1h",
			},
			{
				id: "0:app:week",
				kind: "window",
				label: "7d · Week",
				value: { text: "100%", tone: "error" },
				fill: 1,
				reset: "resets 1d",
			},
		]);
	});

	test("appends the card without changing connected-provider cards", () => {
		const read = available([{ scope: "app", metrics: [] }]);
		const model = build([OPENAI], { openai: read }, undefined, CLAUDE_USAGE);
		const widget = buildSidebarModel(OPENAI, read, LOCALE, NOW);

		expect(model.cards).toHaveLength(2);
		expect(model.cards[0]).toEqual({
			id: "openai",
			name: OPENAI.name,
			lines: widget.lines,
		});
		expect(model.cards[1]?.id).toBe("claude-code");
		expect(model.cards[1]?.name).toBe("Claude Code");
	});
});

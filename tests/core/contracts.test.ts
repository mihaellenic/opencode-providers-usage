import { describe, expect, test } from "bun:test";
import {
	isQuotaPresentation,
	isQuotaRead,
	type QuotaPresentation,
	type QuotaRead,
} from "../../src/core/contracts";

const REASON_CODES = [
	"companion_disabled",
	"companion_missing",
	"companion_expired",
	"unsupported_companion_storage",
	"invalid_companion",
	"app_registration_mismatch",
	"invalid_native_registration",
	"invalid_response",
	"rate_limited",
	"timeout",
	"network_error",
	"unsupported_auth_method",
	"no_validated_quota_source",
] as const;

describe("limitReached contract", () => {
	function planRead(extra: Record<string, unknown>): unknown {
		return {
			state: "available",
			authSource: "codex-companion",
			sections: [
				{
					scope: "shared-plan",
					result: {
						state: "available",
						metrics: [
							{
								kind: "window",
								id: "plan",
								scope: "shared-plan",
								label: "Shared plan primary limit",
								windowSeconds: 18_000,
								usedPercent: 100,
							},
						],
						fetchedAt: 1,
						expiresAt: 2,
						...extra,
					},
				},
			],
		};
	}

	test.each([
		[{}, true],
		[{ limitReached: true }, true],
		[{ limitReached: false }, true],
		[{ limitReached: "true" }, false],
		[{ limitReached: 1 }, false],
		[{ limitReached: null }, false],
		[{ unknownKey: true }, false],
	])("limit_reached extra %p accepted=%p", (extra, accepted) => {
		expect(isQuotaRead(planRead(extra))).toBe(accepted);
	});
});

describe("quota contracts", () => {
	test.each(REASON_CODES)("accepts unavailable reason %s", (reason) => {
		expect(isQuotaRead({ state: "unavailable", reason, attemptedAt: 0 })).toBe(
			true,
		);
	});

	test("rejects_secret_fields_and_accepts_scoped_quota", () => {
		expect(
			isQuotaRead({
				state: "unavailable",
				reason: "timeout",
				attemptedAt: 0,
				accessToken: "SECRET",
			}),
		).toBe(false);

		const valid: QuotaRead = {
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
								id: "app-primary",
								scope: "app",
								label: "App limit",
								windowSeconds: 18_000,
								usedPercent: 20,
								remainingPercent: 80,
								resetsAt: 1_800_000_000_000,
							},
						],
						fetchedAt: 1_799_999_000_000,
						expiresAt: 1_799_999_060_000,
						configuredAppCapPercent: 100,
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
								label: "Shared plan",
								windowSeconds: 604_800,
								remainingPercent: 45,
								resetsAt: 1_800_000_000_000,
							},
						],
						fetchedAt: 1_799_999_000_000,
						expiresAt: 1_799_999_060_000,
					},
				},
			],
		};

		expect(isQuotaRead(valid)).toBe(true);

		expect(
			isQuotaRead({
				state: "unavailable",
				reason: "something_went_wrong",
				attemptedAt: 0,
			}),
		).toBe(false);

		expect(
			isQuotaRead({
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
									id: "app-primary",
									scope: "app",
									label: "App limit",
									windowSeconds: 18_000,
									accessToken: "SECRET",
								},
							],
							fetchedAt: 1_799_999_000_000,
							expiresAt: 1_799_999_060_000,
						},
					},
				],
			}),
		).toBe(false);

		expect(
			isQuotaRead({
				state: "available",
				authSource: "opencode",
				sections: [
					{
						scope: "app",
						result: {
							state: "unavailable",
							reason: "timeout",
							attemptedAt: 0,
							accountID: "ACCOUNT",
						},
					},
				],
			}),
		).toBe(false);
	});
});

const COMPLETE_HISTORY: Extract<QuotaRead, { state: "available" | "partial" }> =
	{
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
							remaining: 40,
						},
					],
					fetchedAt: 1_799_999_000_000,
					expiresAt: 1_799_999_060_000,
				},
			},
		],
	};

describe("quota presentation contract", () => {
	test("accepts_only_complete_available_history", () => {
		const valid: QuotaPresentation = {
			revision: 3,
			lastKnown: COMPLETE_HISTORY,
			failedSince: 1_800_000_000_000,
		};
		expect(isQuotaPresentation(valid)).toBe(true);
		expect(isQuotaPresentation({ revision: 0 })).toBe(true);

		expect(
			isQuotaPresentation({
				revision: 3,
				lastKnown: { ...COMPLETE_HISTORY, state: "partial" },
			}),
		).toBe(false);

		expect(
			isQuotaPresentation({
				revision: 3,
				lastKnown: {
					state: "available",
					authSource: "opencode",
					sections: [
						COMPLETE_HISTORY.sections[0],
						{
							scope: "shared-plan",
							result: {
								state: "unavailable",
								reason: "network_error",
								attemptedAt: 1_800_000_000_000,
							},
						},
					],
				},
			}),
		).toBe(false);

		expect(
			isQuotaPresentation({
				revision: 3,
				lastKnown: {
					state: "unavailable",
					reason: "timeout",
					attemptedAt: 1_800_000_000_000,
				},
			}),
		).toBe(false);
	});

	test("rejects_secret_fields_and_invalid_revisions", () => {
		expect(
			isQuotaPresentation({
				revision: 1,
				lastKnown: { ...COMPLETE_HISTORY, accessToken: "SECRET" },
			}),
		).toBe(false);

		expect(
			isQuotaPresentation({
				revision: 1,
				lastKnown: {
					...COMPLETE_HISTORY,
					sections: [
						{
							scope: "provider-balance",
							result: {
								...(COMPLETE_HISTORY.sections[0]?.result as object),
								accountID: "ACCOUNT",
							},
						},
					],
				},
			}),
		).toBe(false);

		expect(
			isQuotaPresentation({
				revision: 1,
				lastKnown: COMPLETE_HISTORY,
				identityKey: "credential-derived",
			}),
		).toBe(false);
	});

	test.each([
		[{ revision: -1 }],
		[{ revision: 1.5 }],
		[{ revision: Number.NaN }],
		[{ revision: "1" }],
		[{ revision: 1, failedSince: -1 }],
		[{ revision: 1, failedSince: "now" }],
	])("rejects invalid presentation %p", (value) => {
		expect(isQuotaPresentation(value)).toBe(false);
	});
});

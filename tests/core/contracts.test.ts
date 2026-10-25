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

describe("quota contracts", () => {
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

		for (const reason of REASON_CODES) {
			expect(
				isQuotaRead({ state: "unavailable", reason, attemptedAt: 0 }),
			).toBe(true);
		}

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

		for (const revision of [-1, 1.5, Number.NaN, "1"]) {
			expect(isQuotaPresentation({ revision })).toBe(false);
		}
		expect(isQuotaPresentation({ revision: 1, failedSince: -1 })).toBe(false);
		expect(isQuotaPresentation({ revision: 1, failedSince: "now" })).toBe(
			false,
		);
	});
});

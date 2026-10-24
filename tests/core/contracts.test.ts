import { describe, expect, test } from "bun:test";
import { isQuotaRead, type QuotaRead } from "../../src/core/contracts";

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

import { describe, expect, test } from "bun:test";
import type { QuotaRead } from "../../src/core/contracts";
import { revalidateQuota } from "../../src/ui/format";
import { sidebarQuotaPresentation } from "../../src/ui/quota-presentation";

const START = 1_800_000_000_000;
const failure: QuotaRead = {
	state: "unavailable",
	reason: "network_error",
	attemptedAt: START + 1_700_000,
};
function history(
	fetchedAt = START,
): Extract<QuotaRead, { state: "available" | "partial" }> {
	return {
		state: "available",
		authSource: "opencode",
		sections: [
			{
				scope: "app",
				result: {
					state: "available",
					fetchedAt,
					expiresAt: fetchedAt + 90_000,
					metrics: [
						{
							kind: "window",
							id: "window",
							scope: "app",
							label: "Window",
							windowSeconds: 3_600,
							remainingPercent: 40,
							resetsAt: fetchedAt + 60_000,
						},
					],
				},
			},
		],
	};
}

describe("sidebar historical presentation", () => {
	test("idle expiry and passed reset retain exact figures without warning or timer", () => {
		const lastKnown = history();
		const before = JSON.stringify(lastKnown);
		const result = sidebarQuotaPresentation({
			quota: failure,
			presentation: { revision: 1, lastKnown },
			now: START + 3_600_000,
		});
		expect(result).toEqual({ quota: lastKnown, mightBeStale: false });
		expect(result.quota).toBe(lastKnown);
		expect(JSON.stringify(lastKnown)).toBe(before);
	});

	test.each([
		[1_800_000, 180_000, false],
		[1_800_001, 179_999, false],
		[1_800_001, 180_000, true],
		[3_600_000, 180_000, true],
	])(
		"age %i, continuous failure %i => warning %s",
		(age, failedFor, expected) => {
			const now = START + age;
			const result = sidebarQuotaPresentation({
				quota: failure,
				presentation: {
					revision: 2,
					lastKnown: history(),
					failedSince: now - failedFor,
				},
				now,
			});
			expect(result.mightBeStale).toBe(expected);
			if (!expected) expect(result.nextChangeAt).toBeGreaterThan(now);
			else expect(result.nextChangeAt).toBeUndefined();
		},
	);

	test("uses oldest section and the later of both deadlines, including failedSince zero", () => {
		const lastKnown = history();
		lastKnown.sections.push(...history(START + 100_000).sections);
		expect(
			sidebarQuotaPresentation({
				quota: failure,
				presentation: {
					revision: 2,
					lastKnown,
					failedSince: START + 1_700_000,
				},
				now: START + 1_750_000,
			}).nextChangeAt,
		).toBe(START + 1_880_000);
		expect(
			sidebarQuotaPresentation({
				quota: failure,
				presentation: { revision: 2, lastKnown: history(0), failedSince: 0 },
				now: 1_800_001,
			}).mightBeStale,
		).toBe(true);
	});

	test("partial failure keeps complete history; recovery and a subsequent failure reset timing", () => {
		const lastKnown = history();
		const partial: QuotaRead = {
			...history(START + 1_900_000),
			state: "partial",
		};
		const failed = sidebarQuotaPresentation({
			quota: partial,
			presentation: { revision: 3, lastKnown, failedSince: START },
			now: START + 1_900_000,
		});
		expect(failed.quota).toBe(lastKnown);
		expect(failed.mightBeStale).toBe(true);
		const recovered = history(START + 1_900_000);
		expect(
			sidebarQuotaPresentation({
				quota: recovered,
				presentation: { revision: 4, lastKnown: recovered },
				now: START + 1_900_000,
			}).mightBeStale,
		).toBe(false);
		expect(
			sidebarQuotaPresentation({
				quota: failure,
				presentation: {
					revision: 5,
					lastKnown: recovered,
					failedSince: START + 3_800_000,
				},
				now: START + 3_900_000,
			}).mightBeStale,
		).toBe(false);
	});

	test("no history/metadata remains strict; invalidation never falls back to client history", () => {
		const expired = sidebarQuotaPresentation({
			quota: history(),
			now: START + 3_600_000,
		}).quota;
		expect(expired).toEqual(revalidateQuota(history(), START + 3_600_000));
		expect(JSON.stringify(expired)).not.toContain("remainingPercent");
		const reset = sidebarQuotaPresentation({
			quota: failure,
			presentation: { revision: 9 },
			now: START + 3_600_000,
		});
		expect(reset).toEqual({ quota: failure, mightBeStale: false });
	});
});

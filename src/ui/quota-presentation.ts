import type { QuotaPresentation, QuotaRead } from "../core/contracts";
import { revalidateQuota } from "./format";

/** Only the sidebar may present server-owned, deliberately historical figures. */
export function sidebarQuotaPresentation(input: {
	quota: QuotaRead;
	presentation?: QuotaPresentation;
	now: number;
}): { quota: QuotaRead; mightBeStale: boolean; nextChangeAt?: number } {
	const history = input.presentation?.lastKnown;
	if (history === undefined) {
		return {
			quota: revalidateQuota(input.quota, input.now),
			mightBeStale: false,
		};
	}
	const failedSince = input.presentation?.failedSince;
	const timestamps = history.sections.flatMap((section) =>
		section.result.state === "available" ? [section.result.fetchedAt] : [],
	);
	if (failedSince === undefined || timestamps.length === 0) {
		return { quota: history, mightBeStale: false };
	}
	const deadline = Math.max(
		Math.min(...timestamps) + 1_800_001,
		failedSince + 180_000,
	);
	return {
		quota: history,
		mightBeStale: input.now >= deadline,
		...(input.now < deadline ? { nextChangeAt: deadline } : {}),
	};
}

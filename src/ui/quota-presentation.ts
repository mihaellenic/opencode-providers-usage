import type { QuotaPresentation, QuotaRead } from "../core/contracts";
import {
	nextQuotaExpiry,
	nextQuotaReset,
	revalidateQuota,
	withdrawPassedResets,
} from "./format";

/**
 * Only the sidebar may present server-owned, deliberately historical figures.
 * Every path drops figures of a window that has already reset. `nextChangeAt`
 * is the next display deadline; `refreshAt` is the next reset, the one
 * deadline where a fetch (not just a repaint) is warranted.
 */
export function sidebarQuotaPresentation(input: {
	quota: QuotaRead;
	presentation?: QuotaPresentation;
	now: number;
}): {
	quota: QuotaRead;
	mightBeStale: boolean;
	nextChangeAt?: number;
	refreshAt?: number;
} {
	const history = input.presentation?.lastKnown;
	if (history === undefined) {
		return {
			quota: revalidateQuota(input.quota, input.now),
			mightBeStale: false,
			...deadlines(
				[nextQuotaExpiry(input.quota, input.now)],
				input.quota,
				input.now,
			),
		};
	}
	const quota = withdrawPassedResets(history, input.now);
	const failedSince = input.presentation?.failedSince;
	const timestamps = history.sections.flatMap((section) =>
		section.result.state === "available" ? [section.result.fetchedAt] : [],
	);
	if (failedSince === undefined || timestamps.length === 0) {
		return { quota, mightBeStale: false, ...deadlines([], history, input.now) };
	}
	const deadline = Math.max(
		Math.min(...timestamps) + 1_800_001,
		failedSince + 180_000,
	);
	return {
		quota,
		mightBeStale: input.now >= deadline,
		...deadlines(input.now < deadline ? [deadline] : [], history, input.now),
	};
}

function deadlines(
	display: (number | undefined)[],
	source: QuotaRead,
	now: number,
): { nextChangeAt?: number; refreshAt?: number } {
	const refreshAt = nextQuotaReset(source, now);
	const all = [...display, refreshAt].filter(
		(at): at is number => at !== undefined,
	);
	return {
		...(all.length === 0 ? {} : { nextChangeAt: Math.min(...all) }),
		...(refreshAt === undefined ? {} : { refreshAt }),
	};
}

import type {
	LocaleContext,
	ProviderSummary,
	QuotaRead,
} from "../core/contracts";
import {
	buildSidebarModel,
	resolveProviderName,
	type SidebarLine,
} from "./sidebar-model";

export type UsagePageCard = {
	id: string;
	name: string;
	lines: SidebarLine[];
};

export type UsagePageModel = {
	title: string;
	subtitle: string;
	cards: UsagePageCard[];
};

const TITLE = "Provider usage";
const SUBTITLE = "Connected accounts · quota & balances";

const PENDING: SidebarLine = {
	id: "quota:pending",
	kind: "status",
	text: "Not loaded yet. Refresh to load.",
	tone: "warning",
};

/**
 * Pure card view model for the full usage page. Each card is exactly the
 * sidebar widget for that provider: same header name, same rows, same tones,
 * same compact durations and reset countdowns. The page adds no rows of its
 * own. No host state is read and no freshness check is performed here: the
 * upstream page view applies `revalidateQuota` before passing reads in.
 */
export function buildUsagePageModel(input: {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
	locale: LocaleContext;
	now?: number;
	displayNames?: Record<string, string>;
}): UsagePageModel {
	const now = input.now ?? Date.now();
	return {
		title: TITLE,
		subtitle: SUBTITLE,
		cards: input.providers.map((provider) => {
			const read = input.quotaByProvider[provider.providerID];
			const displayName = input.displayNames?.[provider.providerID];
			if (read === undefined) {
				return {
					id: provider.providerID,
					name: resolveProviderName(provider, displayName),
					lines: [PENDING],
				};
			}
			const widget = buildSidebarModel(
				provider,
				read,
				input.locale,
				now,
				displayName,
			);
			return {
				id: provider.providerID,
				name: widget.provider,
				lines: widget.lines,
			};
		}),
	};
}

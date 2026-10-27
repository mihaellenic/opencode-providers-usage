import type { ClaudeUsage } from "../claude-code/usage";
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

const CLAUDE_CARD_ID = "claude-code";
const CLAUDE_CARD_NAME = "Claude Code";

/**
 * Page-only card from the local Claude Code CLI. It is intentionally not a
 * connected provider: it has its own identity and never enters the provider
 * inventory or sidebar.
 *
 * The two verified windows are projected through `buildSidebarModel` so the
 * card gets exactly the OpenAI-style window bars, used-percentage thresholds,
 * compact durations and reset countdowns. The synthetic read is never exposed;
 * only the resulting plain lines leave this function.
 */
function claudeUsageCard(
	usage: ClaudeUsage,
	locale: LocaleContext,
	now: number,
): UsagePageCard {
	const provider: ProviderSummary = {
		providerID: CLAUDE_CARD_ID,
		name: CLAUDE_CARD_NAME,
		authMethod: "oauth",
		support: "supported",
		evidence: "live-validated",
	};
	const read: QuotaRead = {
		state: "available",
		// QuotaRead only models OpenCode's two sources. This value is internal
		// to the projection and is discarded before the card is returned.
		authSource: "opencode",
		sections: [
			{
				scope: "app",
				result: {
					state: "available",
					metrics: [
						{
							kind: "window",
							id: "session",
							scope: "app",
							label: "Session",
							windowSeconds: 18_000,
							usedPercent: usage.session.usedPercent,
							remainingPercent: 100 - usage.session.usedPercent,
							resetsAt: usage.session.resetsAt,
						},
						{
							kind: "window",
							id: "week",
							scope: "app",
							label: "Week",
							windowSeconds: 604_800,
							usedPercent: usage.week.usedPercent,
							remainingPercent: 100 - usage.week.usedPercent,
							resetsAt: usage.week.resetsAt,
						},
					],
					fetchedAt: now,
					expiresAt: now,
				},
			},
		],
	};
	const widget = buildSidebarModel(
		provider,
		read,
		locale,
		now,
		CLAUDE_CARD_NAME,
	);
	return { id: CLAUDE_CARD_ID, name: CLAUDE_CARD_NAME, lines: widget.lines };
}

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
	claudeUsage?: ClaudeUsage | null;
}): UsagePageModel {
	const now = input.now ?? Date.now();
	const cards: UsagePageCard[] = input.providers.map((provider) => {
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
	});
	if (input.claudeUsage != null) {
		cards.push(claudeUsageCard(input.claudeUsage, input.locale, now));
	}
	return {
		title: TITLE,
		subtitle: SUBTITLE,
		cards,
	};
}

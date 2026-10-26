import type {
	LocaleContext,
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
	SectionResult,
	UnavailableState,
} from "../core/contracts";
import {
	ageText,
	formatCurrency,
	formatPercent,
	formatResetCompact,
	latestAttemptTime,
	latestFetchedTime,
	SCOPE_LABELS,
	unavailableCopy,
} from "./format";
import type { SidebarCell, SidebarLine, SidebarTone } from "./sidebar-model";

export type UsagePageCard = {
	id: string;
	name: string;
	updated?: SidebarCell;
	lines: SidebarLine[];
};

export type UsagePageModel = {
	title: string;
	subtitle: string;
	cards: UsagePageCard[];
};

const TITLE = "Provider usage";
const SUBTITLE = "Connected accounts · quota & balances";
const CAP_DETAIL =
	"Configured app cap reported by the provider; never remaining quota.";

const CREDIT_NAMES = new Map([
	["Included credits", "Included"],
	["Purchased credits", "Purchased"],
	["Total credits", "Total"],
]);

const INCLUDED_LABEL = "Included credits";
const PURCHASED_LABEL = "Purchased credits";
const TOTAL_LABEL = "Total credits";

type AvailableSection = Extract<SectionResult, { state: "available" }>;
type SectionsRead = Extract<QuotaRead, { state: "available" | "partial" }>;
type MoneyMetric = Extract<QuotaMetric, { kind: "money" }>;

function statusTone(state: UnavailableState): SidebarTone {
	return state === "unsupported" || state === "not-applicable"
		? "warning"
		: "error";
}

function retrySuffix(retryAfterMs: number | undefined): string {
	return retryAfterMs === undefined
		? ""
		: ` · retry after ${Math.ceil(retryAfterMs / 1000)}s`;
}

function futureSpan(milliseconds: number): string {
	const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.ceil(minutes / 60);
	if (hours < 48) {
		return `${hours}h`;
	}
	const days = Math.ceil(hours / 24);
	if (days < 14) {
		return `${days}d`;
	}
	return `${Math.ceil(days / 7)}w`;
}

function refillText(
	resetsAt: number | undefined,
	now: number,
): string | undefined {
	if (resetsAt === undefined) {
		return undefined;
	}
	if (resetsAt <= now) {
		return "refill due";
	}
	return `refills in ${futureSpan(resetsAt - now)}`;
}

function windowDisplay(
	metric: Extract<QuotaMetric, { kind: "window" }>,
	locale: LocaleContext,
): { value: SidebarCell; fill?: number } {
	if (metric.remainingPercent !== undefined) {
		// Reported remaining is safe to invert into used.
		const usedPercent = 100 - metric.remainingPercent;
		return {
			value: {
				text: `${formatPercent(usedPercent, locale)}%`,
				tone:
					usedPercent >= 100
						? "error"
						: usedPercent >= 80
							? "warning"
							: "normal",
			},
			fill: Math.min(1, Math.max(0, usedPercent / 100)),
		};
	}
	if (metric.usedPercent !== undefined) {
		// Used-only input never proves how much remains. Show the reported usage
		// without inferring a remaining percentage or a healthy tone.
		return {
			value: {
				text: `${formatPercent(metric.usedPercent, locale)}%`,
				tone: "normal",
			},
			fill: Math.min(1, Math.max(0, metric.usedPercent / 100)),
		};
	}
	return { value: { text: "Unknown (not reported)", tone: "muted" } };
}

function moneyValue(metric: MoneyMetric, locale: LocaleContext): SidebarCell {
	return {
		text: `${formatCurrency(metric.remaining, locale)} remaining`,
		tone: metric.remaining === 0 ? "error" : "normal",
	};
}

function uniqueWindowLabel(
	base: string,
	metric: Extract<QuotaMetric, { kind: "window" }>,
	used: Set<string>,
): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let unique = `${base} · ${metric.id}`;
	let suffix = 2;
	while (used.has(unique)) {
		unique = `${base} · ${metric.id} #${suffix}`;
		suffix += 1;
	}
	used.add(unique);
	return unique;
}

function isPurchasedMetric(
	metric: QuotaMetric | undefined,
): metric is MoneyMetric {
	return (
		metric !== undefined &&
		metric.kind === "money" &&
		metric.label === PURCHASED_LABEL &&
		metric.resetsAt === undefined &&
		metric.allowance === undefined &&
		metric.used === undefined
	);
}

function isTotalMetric(metric: QuotaMetric | undefined): metric is MoneyMetric {
	return (
		metric !== undefined &&
		metric.kind === "money" &&
		metric.label === TOTAL_LABEL &&
		metric.resetsAt === undefined &&
		metric.allowance === undefined &&
		metric.used === undefined
	);
}

function isKnownPair(
	current: QuotaMetric,
	next: QuotaMetric | undefined,
): next is MoneyMetric {
	return isPurchasedMetric(current) && isTotalMetric(next);
}

function pairLine(
	purchased: MoneyMetric,
	total: MoneyMetric,
	sectionIndex: number,
	locale: LocaleContext,
): SidebarLine {
	const left = `${CREDIT_NAMES.get(purchased.label) ?? purchased.label} ${formatCurrency(purchased.remaining, locale)}`;
	const right = `${CREDIT_NAMES.get(total.label) ?? total.label} ${formatCurrency(total.remaining, locale)}`;
	return {
		id: `${sectionIndex}:${purchased.scope}:pair:${purchased.id}+${total.id}`,
		kind: "pair",
		left: {
			text: left,
			tone: purchased.remaining === 0 ? "error" : "normal",
		},
		right: {
			text: right,
			tone: total.remaining === 0 ? "error" : "normal",
		},
		metricIDs: [purchased.id, total.id],
	};
}

function otherCredit(
	metric: MoneyMetric,
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
): SidebarLine {
	const parts: string[] = [];
	if (metric.allowance !== undefined) {
		parts.push(`allowance ${formatCurrency(metric.allowance, locale)}`);
	}
	if (metric.used !== undefined) {
		parts.push(`${formatCurrency(metric.used, locale)} used`);
	}
	const refill = refillText(metric.resetsAt, now);
	if (refill !== undefined) {
		parts.push(refill);
	}
	const detail = parts.length === 0 ? undefined : parts.join(" · ");
	return {
		id: `${sectionIndex}:${metric.scope}:${metric.id}`,
		kind: "credit",
		label: CREDIT_NAMES.get(metric.label) ?? metric.label,
		value: moneyValue(metric, locale),
		...(detail === undefined ? {} : { detail }),
	};
}

function includedLines(
	metric: MoneyMetric,
	purchased: MoneyMetric | undefined,
	total: MoneyMetric | undefined,
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
): SidebarLine[] {
	const id = `${sectionIndex}:${metric.scope}:${metric.id}`;
	const label = CREDIT_NAMES.get(metric.label) ?? metric.label;
	const refill = refillText(metric.resetsAt, now);
	const allowance = metric.allowance;
	const positiveAllowance = allowance !== undefined && allowance > 0;

	if (positiveAllowance) {
		// Used is derivable only from a positive reported allowance. The values
		// are used-based so the bar and stat row agree; only the percentage
		// carries the threshold tone (the bar and amounts stay neutral).
		const used = allowance - metric.remaining;
		const usedPercent = (used / allowance) * 100;
		const tone: SidebarTone =
			usedPercent >= 100 ? "error" : usedPercent >= 80 ? "warning" : "normal";
		const reset =
			metric.resetsAt === undefined
				? undefined
				: formatResetCompact(metric.resetsAt, locale, now);
		const lines: SidebarLine[] = [
			{
				id,
				kind: "bar",
				fill: Math.min(1, Math.max(0, used / allowance)),
				percent: {
					text: `${formatPercent(usedPercent, locale)}%`,
					tone,
				},
				...(reset === undefined ? {} : { reset }),
			},
			{
				id: `${id}:stats`,
				kind: "pair",
				left: {
					text: `${formatCurrency(used, locale)} / ${formatCurrency(allowance, locale)} used`,
					tone: "normal",
				},
				...(purchased === undefined
					? {}
					: {
							right: {
								text: `+${formatCurrency(purchased.remaining, locale)} credits`,
								tone: "normal",
							},
						}),
				metricIDs: [
					metric.id,
					...(purchased === undefined ? [] : [purchased.id]),
					...(total === undefined ? [] : [total.id]),
				],
			},
		];
		if (total !== undefined) {
			// The sidebar folds this reported pool into the bar's metric IDs.
			// The page keeps the reported total visible as its own row.
			lines.push(explicitTotalLine(total, sectionIndex, locale));
		}
		return lines;
	}

	const parts: string[] = [];
	if (metric.used !== undefined) {
		// Without a positive allowance, used is not derivable from the figures
		// shown here, so it remains an independent reported value.
		parts.push(`${formatCurrency(metric.used, locale)} used`);
	}
	if (refill !== undefined) {
		parts.push(refill);
	}
	const detail = parts.length === 0 ? undefined : parts.join(" · ");
	return [
		{
			id,
			kind: "credit",
			label,
			value: moneyValue(metric, locale),
			...(detail === undefined ? {} : { detail }),
		},
	];
}

function explicitTotalLine(
	total: MoneyMetric,
	sectionIndex: number,
	locale: LocaleContext,
): SidebarLine {
	return {
		id: `${sectionIndex}:${total.scope}:${total.id}`,
		kind: "credit",
		label: TOTAL_LABEL,
		value: {
			text: formatCurrency(total.remaining, locale),
			tone: total.remaining === 0 ? "error" : "normal",
		},
	};
}

function availableLines(
	section: { scope: QuotaScope; result: AvailableSection },
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
	usedLabels: Set<string>,
): SidebarLine[] {
	const result = section.result;
	const lines: SidebarLine[] = [];
	if (result.metrics.length === 0) {
		lines.push({
			id: `${sectionIndex}:${section.scope}:empty`,
			kind: "status",
			text: `${SCOPE_LABELS[section.scope]}: No quota values were reported for this scope.`,
			tone: "warning",
		});
	}
	for (let index = 0; index < result.metrics.length; index += 1) {
		const metric = result.metrics[index];
		if (metric === undefined) {
			continue;
		}
		if (metric.kind === "window") {
			const display = windowDisplay(metric, locale);
			lines.push({
				id: `${sectionIndex}:${metric.scope}:${metric.id}`,
				kind: "window",
				label: uniqueWindowLabel(
					`${SCOPE_LABELS[metric.scope]} · ${metric.label}`,
					metric,
					usedLabels,
				),
				value: display.value,
				...(display.fill === undefined ? {} : { fill: display.fill }),
				...(metric.resetsAt === undefined
					? {}
					: { reset: formatResetCompact(metric.resetsAt, locale, now) }),
			});
			continue;
		}

		const next = result.metrics[index + 1];
		if (
			metric.kind === "money" &&
			metric.label === INCLUDED_LABEL &&
			metric.allowance !== undefined &&
			metric.allowance > 0
		) {
			const purchased = isPurchasedMetric(next) ? next : undefined;
			const after = result.metrics[index + 2];
			const total =
				purchased !== undefined && isTotalMetric(after) ? after : undefined;
			lines.push(
				...includedLines(metric, purchased, total, sectionIndex, locale, now),
			);
			if (total !== undefined) {
				index += 2;
			} else if (purchased !== undefined) {
				index += 1;
			}
			continue;
		}
		if (isKnownPair(metric, next)) {
			lines.push(pairLine(metric, next, sectionIndex, locale));
			index += 1;
			continue;
		}
		lines.push(
			...(metric.kind === "money" && metric.label === INCLUDED_LABEL
				? includedLines(metric, undefined, undefined, sectionIndex, locale, now)
				: metric.kind === "money"
					? [otherCredit(metric, sectionIndex, locale, now)]
					: []),
		);
	}

	if (result.configuredAppCapPercent !== undefined) {
		lines.push({
			id: `${sectionIndex}:${section.scope}:cap`,
			kind: "credit",
			label: "Configured app cap",
			value: {
				text: `${formatPercent(result.configuredAppCapPercent, locale)}% allowed`,
				tone: "normal",
			},
			detail: CAP_DETAIL,
		});
	}
	return lines;
}

function wholeReadLines(
	read: Extract<QuotaRead, { state: UnavailableState }>,
): SidebarLine[] {
	const title =
		read.state === "not-applicable"
			? "Quota not applicable"
			: "Quota unavailable";
	const tone = statusTone(read.state);
	const lines: SidebarLine[] = [
		{ id: "quota:title", kind: "status", text: title, tone },
	];
	// The unsupported state is purely informational: the title already says
	// the quota is unavailable, so the card shows no second explanation line.
	// Every state with actionable guidance keeps its exact copy.
	if (read.state !== "unsupported") {
		lines.push({
			id: "quota:status",
			kind: "status",
			text: `${unavailableCopy(read.state, read.reason)}${retrySuffix(read.retryAfterMs)}`,
			tone,
		});
	}
	return lines;
}

function sectionLines(
	read: SectionsRead,
	locale: LocaleContext,
	now: number,
): SidebarLine[] {
	const lines: SidebarLine[] = [];
	const usedLabels = new Set<string>();
	read.sections.forEach((section, sectionIndex) => {
		const result = section.result;
		if (result.state !== "available") {
			lines.push({
				id: `${sectionIndex}:${section.scope}:status`,
				kind: "status",
				text: `${SCOPE_LABELS[section.scope]}: ${unavailableCopy(result.state, result.reason)}${retrySuffix(result.retryAfterMs)}`,
				tone: statusTone(result.state),
			});
			return;
		}
		lines.push(
			...availableLines(
				{ scope: section.scope, result },
				sectionIndex,
				locale,
				now,
				usedLabels,
			),
		);
	});
	if (read.sections.length === 0) {
		lines.push({
			id: "quota:empty",
			kind: "status",
			text: "No quota sections were reported.",
			tone: "warning",
		});
	}
	return lines;
}

function updatedCell(read: QuotaRead, now: number): SidebarCell | undefined {
	if (read.state === "unsupported" || read.state === "not-applicable") {
		return undefined;
	}
	const fetchedAt = latestFetchedTime(read);
	if (fetchedAt !== undefined) {
		return { text: `Updated ${ageText(now - fetchedAt)}`, tone: "success" };
	}
	const attemptedAt = latestAttemptTime(read);
	if (attemptedAt === undefined) {
		return undefined;
	}
	return {
		text: `Last attempt ${ageText(now - attemptedAt)}`,
		tone: "warning",
	};
}

/**
 * Pure card view model for the full usage page. Every card repeats the
 * sidebar widget rows for one connected provider, using the same vocabulary
 * and tone rules. The page additionally keeps shared-plan scopes, an explicit
 * reported total-credits row, configured caps, and update-age cells. No host
 * state is read and no freshness check is performed here: the upstream page
 * view applies `revalidateQuota` before passing reads in.
 */
export function buildUsagePageModel(input: {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
	locale: LocaleContext;
	now?: number;
}): UsagePageModel {
	const now = input.now ?? Date.now();
	return {
		title: TITLE,
		subtitle: SUBTITLE,
		cards: input.providers.map((provider) => {
			const read = input.quotaByProvider[provider.providerID];
			const updated = read === undefined ? undefined : updatedCell(read, now);
			const lines: SidebarLine[] =
				read === undefined
					? [
							{
								id: "quota:pending",
								kind: "status",
								text: "Not loaded yet. Refresh to load.",
								tone: "warning",
							},
						]
					: "sections" in read
						? sectionLines(read, input.locale, now)
						: wholeReadLines(read);
			return {
				id: provider.providerID,
				name: provider.name,
				...(updated === undefined ? {} : { updated }),
				lines,
			};
		}),
	};
}

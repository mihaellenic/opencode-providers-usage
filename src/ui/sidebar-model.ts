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
	dateParts,
	durationText,
	formatCurrency,
	formatPercent,
	latestAttemptTime,
	latestFetchedTime,
	unavailableCopy,
} from "./format";

export type SidebarTone = "normal" | "success" | "warning" | "error" | "muted";

export type SidebarCell = { text: string; tone: SidebarTone };

export type SidebarWindowLine = {
	id: string;
	kind: "window";
	label: string;
	value: SidebarCell;
	reset?: string;
};

export type SidebarCreditLine = {
	id: string;
	kind: "credit";
	label: string;
	value: SidebarCell;
	detail?: string;
};

export type SidebarPairLine = {
	id: string;
	kind: "pair";
	left: SidebarCell;
	right: SidebarCell;
	metricIDs: string[];
};

export type SidebarStatusLine = {
	id: string;
	kind: "status";
	text: string;
	tone: SidebarTone;
};

export type SidebarLine =
	| SidebarWindowLine
	| SidebarCreditLine
	| SidebarPairLine
	| SidebarStatusLine;

export type SidebarModel = {
	provider: string;
	lines: SidebarLine[];
	footer: string;
};

const PROVIDER_NAMES = new Map([
	["OpenAI ChatGPT with Codex companion", "OpenAI · Codex quota"],
]);

const SCOPE_NAMES: Record<QuotaScope, string> = {
	app: "App",
	"shared-plan": "Shared",
	"provider-balance": "Balance",
};

const CREDIT_NAMES = new Map([
	["Included credits", "Included"],
	["Purchased credits", "Purchased"],
	["Total credits", "Total"],
]);

const INCLUDED_LABEL = "Included credits";
const PURCHASED_LABEL = "Purchased credits";
const TOTAL_LABEL = "Total credits";

// Provider labels this plugin understands. A custom label is never hidden: it
// stays on its own visible row even when another window has the same duration.
const GENERIC_WINDOW_LABELS = new Set([
	"Current app limit",
	"Shared plan primary limit",
	"Shared plan secondary limit",
	"Primary",
	"Secondary",
]);

type AvailableSection = Extract<SectionResult, { state: "available" }>;
type SectionsRead = Extract<QuotaRead, { state: "available" | "partial" }>;

function statusTone(state: UnavailableState): SidebarTone {
	return state === "unsupported" || state === "not-applicable"
		? "warning"
		: "error";
}

function compactDuration(seconds: number): string {
	return durationText(seconds).replace(/\s+/g, "");
}

function windowCounts(read: SectionsRead) {
	const counts = new Map<string, number>();
	for (const section of read.sections) {
		if (section.result.state !== "available") {
			continue;
		}
		for (const metric of section.result.metrics) {
			if (metric.kind !== "window") {
				continue;
			}
			const key = `${section.scope}:${metric.windowSeconds}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}

function uniqueWindowLabel(
	base: string,
	metric: Extract<QuotaMetric, { kind: "window" }>,
	count: number,
	used: Set<string>,
): string {
	const candidate =
		count > 1 || !GENERIC_WINDOW_LABELS.has(metric.label)
			? `${base} · ${metric.label}`
			: base;
	if (!used.has(candidate)) {
		used.add(candidate);
		return candidate;
	}
	let unique = `${candidate} · ${metric.id}`;
	let suffix = 2;
	while (used.has(unique)) {
		unique = `${candidate} · ${metric.id} #${suffix}`;
		suffix += 1;
	}
	used.add(unique);
	return unique;
}

function resetText(
	timestamp: number,
	locale: LocaleContext,
	now: number,
): string {
	const reset = dateParts(timestamp, locale);
	const current = dateParts(now, locale);
	const sameLocalDate =
		reset.year === current.year &&
		reset.month === current.month &&
		reset.day === current.day;
	const clock = `${reset.hour}:${reset.minute}`;
	if (sameLocalDate) {
		return `Resets ${clock}`;
	}
	const date = new Intl.DateTimeFormat(locale.locale, {
		timeZone: locale.timeZone,
		calendar: "gregory",
		numberingSystem: "latn",
		month: "short",
		day: "numeric",
	}).format(timestamp);
	const year = reset.year === current.year ? "" : ` · ${reset.year}`;
	return `${date}, ${clock}${year}`;
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

function windowValue(
	metric: Extract<QuotaMetric, { kind: "window" }>,
	locale: LocaleContext,
): SidebarCell {
	if (metric.remainingPercent !== undefined) {
		const percent = metric.remainingPercent;
		return {
			text: `${formatPercent(percent, locale)}% left`,
			tone: percent === 0 ? "error" : percent <= 20 ? "warning" : "success",
		};
	}
	if (metric.usedPercent !== undefined) {
		// Used-only input never proves how much remains. Show the reported usage
		// without inferring a remaining percentage or a healthy tone.
		return {
			text: `${formatPercent(metric.usedPercent, locale)}% used`,
			tone: "normal",
		};
	}
	return { text: "Unknown (not reported)", tone: "muted" };
}

function moneyValue(
	metric: Extract<QuotaMetric, { kind: "money" }>,
	locale: LocaleContext,
): SidebarCell {
	return {
		text: `${formatCurrency(metric.remaining, locale)} remaining`,
		tone: metric.remaining === 0 ? "error" : "normal",
	};
}

function includedCredit(
	metric: Extract<QuotaMetric, { kind: "money" }>,
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
): SidebarCreditLine {
	const refill = refillText(metric.resetsAt, now);
	const allowance = metric.allowance;
	const positiveAllowance = allowance !== undefined && allowance > 0;
	const parts: string[] = [];
	if (positiveAllowance) {
		parts.push(
			`${formatCurrency(metric.remaining, locale)} of ${formatCurrency(allowance, locale)} left`,
		);
	} else if (metric.used !== undefined) {
		// Without a positive allowance, used is not derivable from the figures
		// shown here, so it remains an independent reported value.
		parts.push(`${formatCurrency(metric.used, locale)} used`);
	}
	if (refill !== undefined) {
		parts.push(refill);
	}
	const detail = parts.length === 0 ? undefined : parts.join(" · ");

	if (positiveAllowance) {
		const percent = (metric.remaining / allowance) * 100;
		return {
			id: `${sectionIndex}:${metric.scope}:${metric.id}`,
			kind: "credit",
			label: CREDIT_NAMES.get(metric.label) ?? metric.label,
			value: {
				text: `${formatPercent(percent, locale)}% left`,
				tone: percent === 0 ? "error" : percent <= 20 ? "warning" : "success",
			},
			...(detail === undefined ? {} : { detail }),
		};
	}
	return {
		id: `${sectionIndex}:${metric.scope}:${metric.id}`,
		kind: "credit",
		label: CREDIT_NAMES.get(metric.label) ?? metric.label,
		value: moneyValue(metric, locale),
		...(detail === undefined ? {} : { detail }),
	};
}

function otherCredit(
	metric: Extract<QuotaMetric, { kind: "money" }>,
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
): SidebarCreditLine {
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

function isKnownPair(
	current: QuotaMetric,
	next: QuotaMetric | undefined,
): next is Extract<QuotaMetric, { kind: "money" }> {
	return (
		current.kind === "money" &&
		current.label === PURCHASED_LABEL &&
		current.resetsAt === undefined &&
		current.allowance === undefined &&
		current.used === undefined &&
		next !== undefined &&
		next.kind === "money" &&
		next.label === TOTAL_LABEL &&
		next.resetsAt === undefined &&
		next.allowance === undefined &&
		next.used === undefined
	);
}

function pairLine(
	purchased: Extract<QuotaMetric, { kind: "money" }>,
	total: Extract<QuotaMetric, { kind: "money" }>,
	sectionIndex: number,
	locale: LocaleContext,
): SidebarPairLine {
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

function availableLines(
	section: SectionsRead["sections"][number],
	sectionIndex: number,
	locale: LocaleContext,
	now: number,
	counts: Map<string, number>,
	usedLabels: Set<string>,
): SidebarLine[] {
	if (section.result.state !== "available") {
		return [];
	}
	const result: AvailableSection = section.result;
	if (result.metrics.length === 0) {
		return [
			{
				id: `${sectionIndex}:${section.scope}:empty`,
				kind: "status",
				text: `${SCOPE_NAMES[section.scope]}: No quota values were reported for this scope.`,
				tone: "warning",
			},
		];
	}

	const lines: SidebarLine[] = [];
	for (let index = 0; index < result.metrics.length; index += 1) {
		const metric = result.metrics[index];
		if (metric === undefined) {
			continue;
		}
		if (metric.kind === "window") {
			const base = `${SCOPE_NAMES[section.scope]} ${compactDuration(metric.windowSeconds)}`;
			const count = counts.get(`${section.scope}:${metric.windowSeconds}`) ?? 1;
			lines.push({
				id: `${sectionIndex}:${metric.scope}:${metric.id}`,
				kind: "window",
				label: uniqueWindowLabel(base, metric, count, usedLabels),
				value: windowValue(metric, locale),
				...(metric.resetsAt === undefined
					? {}
					: { reset: resetText(metric.resetsAt, locale, now) }),
			});
			continue;
		}

		const next = result.metrics[index + 1];
		if (isKnownPair(metric, next)) {
			lines.push(pairLine(metric, next, sectionIndex, locale));
			index += 1;
			continue;
		}
		lines.push(
			metric.label === INCLUDED_LABEL
				? includedCredit(metric, sectionIndex, locale, now)
				: otherCredit(metric, sectionIndex, locale, now),
		);
	}
	return lines;
}

function retrySuffix(retryAfterMs: number | undefined): string {
	return retryAfterMs === undefined
		? ""
		: ` · retry after ${Math.ceil(retryAfterMs / 1000)}s`;
}

function footerText(
	read: QuotaRead,
	locale: LocaleContext,
	now: number,
): string {
	const fetched = latestFetchedTime(read);
	if (fetched !== undefined) {
		return `updated ${ageText(now - fetched)} · ${locale.timeZone}`;
	}
	const attempted = latestAttemptTime(read);
	if (attempted !== undefined) {
		return `last attempt ${ageText(now - attempted)} · ${locale.timeZone}`;
	}
	return `updated never · ${locale.timeZone}`;
}

/**
 * Pure structured sidebar view model. Every cell and status is derived from
 * reported quota fields; formatted display strings are never parsed back into
 * data. Source section/metric order is preserved, missing values stay absent,
 * and no allowance, total, or remaining value is inferred.
 *
 * Caller precondition: apply `revalidateQuota()` to quota snapshots before
 * rendering. `now` is a formatting and age reference only; this function does
 * not compare `expiresAt` and therefore does not enforce freshness. Runtime
 * expiry remains in the existing TUI path rather than moving into this model.
 */
export function buildSidebarModel(
	provider: ProviderSummary,
	read: QuotaRead,
	locale: LocaleContext,
	now: number,
): SidebarModel {
	const header = PROVIDER_NAMES.get(provider.name) ?? provider.name;
	const lines: SidebarLine[] = [];

	if (!("sections" in read)) {
		const title =
			read.state === "not-applicable"
				? "Quota not applicable"
				: "Quota unavailable";
		const tone = statusTone(read.state);
		lines.push({ id: "quota:title", kind: "status", text: title, tone });
		lines.push({
			id: "quota:status",
			kind: "status",
			text: `${unavailableCopy(read.state, read.reason)}${retrySuffix(read.retryAfterMs)}`,
			tone,
		});
		return { provider: header, lines, footer: footerText(read, locale, now) };
	}

	const counts = windowCounts(read);
	const usedLabels = new Set<string>();
	read.sections.forEach((section, sectionIndex) => {
		if (section.result.state !== "available") {
			lines.push({
				id: `${sectionIndex}:${section.scope}:status`,
				kind: "status",
				text: `${SCOPE_NAMES[section.scope]}: ${unavailableCopy(section.result.state, section.result.reason)}${retrySuffix(section.result.retryAfterMs)}`,
				tone: statusTone(section.result.state),
			});
			return;
		}
		lines.push(
			...availableLines(section, sectionIndex, locale, now, counts, usedLabels),
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

	return { provider: header, lines, footer: footerText(read, locale, now) };
}

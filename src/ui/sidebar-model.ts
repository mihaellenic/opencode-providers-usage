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
	durationText,
	formatCurrency,
	formatPercent,
	unavailableCopy,
} from "./format";

export type SidebarTone = "normal" | "success" | "warning" | "error" | "muted";

export type SidebarCell = { text: string; tone: SidebarTone };

export type SidebarWindowLine = {
	id: string;
	kind: "window";
	label: string;
	/** Percent used, or the unknown fallback when no percentage was reported. */
	value: SidebarCell;
	/** Used fraction for the compact bar; absent when no percentage is known. */
	fill?: number;
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
	right?: SidebarCell;
	metricIDs: string[];
};

export type SidebarBarLine = {
	id: string;
	kind: "bar";
	/** Used fraction of the reported allowance, clamped to 0..1 for drawing. */
	fill: number;
	percent: SidebarCell;
	reset?: string;
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
	| SidebarBarLine
	| SidebarStatusLine;

export type SidebarModel = {
	provider: string;
	lines: SidebarLine[];
};

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
type MoneyMetric = Extract<QuotaMetric, { kind: "money" }>;

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
		if (
			section.scope === "shared-plan" ||
			section.result.state !== "available"
		) {
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

/**
 * Two-unit countdown shared by the credit and window bar rows. Seconds/minutes
 * are rounded up once, then the first two units are shown. A day-scale
 * duration never reports a partial hour as `0h`; sub-hour durations fall back
 * to minutes or seconds. The countdown uses only the reported reset timestamp.
 */
function resetCountdown(milliseconds: number): string {
	const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	if (minutes < 1_440) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes - hours * 60;
		return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	}
	let days = Math.floor(minutes / 1_440);
	let hours = Math.ceil((minutes - days * 1_440) / 60);
	if (hours === 24) {
		days += 1;
		hours = 0;
	}
	return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

function resetCountdownText(
	resetsAt: number | undefined,
	now: number,
): string | undefined {
	if (resetsAt === undefined) {
		return undefined;
	}
	return resetsAt <= now
		? "resets now"
		: `resets ${resetCountdown(resetsAt - now)}`;
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

function moneyValue(
	metric: Extract<QuotaMetric, { kind: "money" }>,
	locale: LocaleContext,
): SidebarCell {
	return {
		text: `${formatCurrency(metric.remaining, locale)} remaining`,
		tone: metric.remaining === 0 ? "error" : "normal",
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
		const reset = resetCountdownText(metric.resetsAt, now);
		return [
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
	const windowDurations = new Map<string, number>();
	for (let index = 0; index < result.metrics.length; index += 1) {
		const metric = result.metrics[index];
		if (metric === undefined) {
			continue;
		}
		if (metric.kind === "window") {
			const id = `${sectionIndex}:${metric.scope}:${metric.id}`;
			const base = compactDuration(metric.windowSeconds);
			const count = counts.get(`${section.scope}:${metric.windowSeconds}`) ?? 1;
			const display = windowDisplay(metric, locale);
			const reset = resetCountdownText(metric.resetsAt, now);
			windowDurations.set(id, metric.windowSeconds);
			lines.push({
				id,
				kind: "window",
				label: uniqueWindowLabel(base, metric, count, usedLabels),
				value: display.value,
				...(display.fill === undefined ? {} : { fill: display.fill }),
				...(reset === undefined ? {} : { reset }),
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
			// The compact bar folds the purchased pool into its stat row and drops
			// the derived total row. Only the reported purchased metric sources the
			// right cell; the total is recognized and consumed but never displayed.
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
			...(metric.label === INCLUDED_LABEL
				? includedLines(metric, undefined, undefined, sectionIndex, locale, now)
				: [otherCredit(metric, sectionIndex, locale, now)]),
		);
	}

	// Window rows sort by duration ascending; equal durations keep their source
	// order (including the de-dup suffix assignment made above). Non-window lines
	// stay in their original slots.
	const windowSlots: number[] = [];
	const windowLines: SidebarWindowLine[] = [];
	lines.forEach((line, index) => {
		if (line.kind === "window") {
			windowSlots.push(index);
			windowLines.push(line);
		}
	});
	windowLines.sort(
		(left, right) =>
			(windowDurations.get(left.id) ?? 0) -
			(windowDurations.get(right.id) ?? 0),
	);
	windowSlots.forEach((slot, index) => {
		const line = windowLines[index];
		if (line !== undefined) {
			lines[slot] = line;
		}
	});
	return lines;
}

function retrySuffix(retryAfterMs: number | undefined): string {
	return retryAfterMs === undefined
		? ""
		: ` · retry after ${Math.ceil(retryAfterMs / 1000)}s`;
}

/**
 * Pure structured sidebar view model. Every cell and status is derived from
 * reported quota fields; formatted display strings are never parsed back into
 * data. Source section and non-window metric order is preserved, window rows
 * are stably sorted by duration ascending, missing values stay absent, and no
 * allowance, total, or remaining value is inferred.
 *
 * `displayName` is the caller-resolved host provider name. The model never
 * reads host state: when the name is absent, empty, or just the providerID, the
 * summary's declared name is used. `locale`/`now` are formatting references.
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
	displayName?: string,
): SidebarModel {
	const plainName = displayName?.trim();
	const header =
		plainName !== undefined &&
		plainName !== "" &&
		plainName !== provider.providerID
			? plainName
			: provider.name;
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
		return { provider: header, lines };
	}

	const counts = windowCounts(read);
	const usedLabels = new Set<string>();
	read.sections.forEach((section, sectionIndex) => {
		// The sidebar card surfaces app-scope windows; shared-plan stays on the
		// full usage page. This filter is local to the sidebar model.
		if (section.scope === "shared-plan") {
			return;
		}
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

	return { provider: header, lines };
}

import type {
	DisplayRow,
	LocaleContext,
	ProviderSummary,
	QuotaMetric,
	QuotaRead,
	QuotaScope,
	SectionResult,
	UnavailableState,
} from "../core/contracts";

export const AUTH_UNAVAILABLE_COPY =
	"Quota unavailable: sign in with the ChatGPT/Codex app on this machine (using the same account), then refresh.";
export const NATIVE_ONLY_COPY =
	"Quota unavailable: the Codex companion is turned off in this OpenCode configuration. Remove the codexCompanion opt-out to read the existing ChatGPT/Codex login.";
export const REJECTED_AUTH_COPY =
	"Quota unavailable: credentials were rejected, invalid, or expired. Re-authenticate via /connect, then refresh.";
export const UNSUPPORTED_NO_SOURCE_COPY =
	"Quota unavailable: no quota source is validated for this provider.";
export const UNAVAILABLE_NO_CURRENT_COPY =
	"Quota unavailable: no current validated quota. The last result expired or has not completed. Refresh to try again.";
export const NOT_APPLICABLE_COPY =
	"Quota not applicable: this provider has no cloud quota to report.";

export const SCOPE_LABELS: Record<QuotaScope, string> = {
	"provider-balance": "Provider balance",
	"shared-plan": "Shared plan",
	app: "App",
};

const REASON_COPY: Record<string, string> = {
	invalid_native_registration:
		"Quota unavailable: the current OpenCode OpenAI sign-in could not be matched. Re-authenticate via /connect, then refresh.",
	unsupported_companion_storage:
		"Quota unavailable: the ChatGPT/Codex login on this machine uses a storage mode this plugin does not support. Use the file-backed Codex login, then refresh.",
	rate_limited:
		"Quota unavailable: the provider rate limit is active. Try again after the retry window.",
	timeout:
		"Quota unavailable: the provider request timed out. Refresh to try again.",
	network_error:
		"Quota unavailable: the provider could not be reached. Refresh to try again.",
	invalid_response:
		"Quota unavailable: the provider returned an unusable response. Refresh to try again.",
};

/**
 * The `state` field is authoritative. `no_validated_quota_source` means
 * "never claimed" when unsupported and "expired/never completed" when
 * unavailable, so the two never share copy (ledger ruling 1).
 */
export function unavailableCopy(
	state: UnavailableState,
	reason: string,
): string {
	if (state === "unsupported") {
		return UNSUPPORTED_NO_SOURCE_COPY;
	}
	if (state === "not-applicable") {
		return NOT_APPLICABLE_COPY;
	}
	if (
		reason === "companion_missing" ||
		reason === "companion_expired" ||
		reason === "app_registration_mismatch" ||
		reason === "invalid_companion"
	) {
		return AUTH_UNAVAILABLE_COPY;
	}
	if (reason === "companion_disabled") {
		return NATIVE_ONLY_COPY;
	}
	if (reason === "unsupported_auth_method") {
		return REJECTED_AUTH_COPY;
	}
	if (reason === "no_validated_quota_source") {
		return UNAVAILABLE_NO_CURRENT_COPY;
	}
	const copy = REASON_COPY[reason];
	if (copy !== undefined) {
		return copy;
	}
	if (state === "auth-required") {
		return REJECTED_AUTH_COPY;
	}
	return "Quota unavailable: the provider could not be queried. Refresh to try again.";
}

function toneForState(state: UnavailableState): DisplayRow["tone"] {
	return state === "unsupported" || state === "not-applicable"
		? "warning"
		: "error";
}

export function formatPercent(value: number, locale: LocaleContext): string {
	return new Intl.NumberFormat(locale.locale, {
		maximumFractionDigits: 1,
	}).format(value);
}

export function formatCurrency(value: number, locale: LocaleContext): string {
	return new Intl.NumberFormat(locale.locale, {
		style: "currency",
		currency: "USD",
	}).format(value);
}

export function durationText(seconds: number): string {
	if (seconds < 60) {
		return `${seconds} s`;
	}
	if (seconds % 86_400 === 0) {
		return `${seconds / 86_400} d`;
	}
	if (seconds % 3_600 === 0) {
		return `${seconds / 3_600} h`;
	}
	if (seconds % 60 === 0) {
		return `${seconds / 60} min`;
	}
	return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function dateParts(
	timestamp: number,
	locale: LocaleContext,
): Record<string, string> {
	const parts = new Intl.DateTimeFormat(locale.locale, {
		timeZone: locale.timeZone,
		calendar: "gregory",
		numberingSystem: "latn",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(timestamp);
	const result: Record<string, string> = {};
	for (const part of parts) {
		if (part.type !== "literal") {
			result[part.type] = part.value;
		}
	}
	return result;
}

/** Full detail timestamp: always names the timezone and keeps seconds. */
export function formatFullTimestamp(
	timestamp: number,
	locale: LocaleContext,
): string {
	const parts = dateParts(timestamp, locale);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${locale.timeZone}`;
}

function formatResetShort(timestamp: number, locale: LocaleContext): string {
	const text = new Intl.DateTimeFormat(locale.locale, {
		timeZone: locale.timeZone,
		calendar: "gregory",
		numberingSystem: "latn",
		dateStyle: "medium",
		timeStyle: "short",
	}).format(timestamp);
	return `${text} (${locale.timeZone})`;
}

/**
 * Compact absolute reset used by the full usage page: `resets Oct 26 14:14`,
 * with the year appended only when it differs from the current local year.
 */
export function formatResetCompact(
	timestamp: number,
	locale: LocaleContext,
	now: number,
): string {
	const parts = dateParts(timestamp, locale);
	const currentYear = dateParts(now, locale).year;
	const date = new Intl.DateTimeFormat(locale.locale, {
		timeZone: locale.timeZone,
		calendar: "gregory",
		month: "short",
		day: "numeric",
	}).format(timestamp);
	return `resets ${date} ${parts.hour}:${parts.minute}${parts.year !== currentYear ? ` · ${parts.year}` : ""}`;
}

export function defaultLocaleContext(): LocaleContext {
	const resolved = new Intl.DateTimeFormat().resolvedOptions();
	return {
		locale: resolved.locale || "en",
		timeZone: resolved.timeZone || "UTC",
	};
}

function metricRow(
	metric: QuotaMetric,
	section: Extract<SectionResult, { state: "available" }>,
	sectionIndex: number,
	locale: LocaleContext,
): DisplayRow {
	const scopeLabel = SCOPE_LABELS[metric.scope];
	const fetched = formatFullTimestamp(section.fetchedAt, locale);
	const resets =
		metric.resetsAt === undefined
			? undefined
			: `resets ${formatResetShort(metric.resetsAt, locale)}`;

	if (metric.kind === "money") {
		const remaining = formatCurrency(metric.remaining, locale);
		const value =
			resets === undefined
				? `${remaining} remaining`
				: `${remaining} remaining · ${resets}`;
		const detail = [
			metric.allowance === undefined
				? undefined
				: `allowance ${formatCurrency(metric.allowance, locale)}`,
			metric.used === undefined
				? undefined
				: `${formatCurrency(metric.used, locale)} used`,
			metric.resetsAt === undefined
				? "no refill reported"
				: `full refill ${formatFullTimestamp(metric.resetsAt, locale)}`,
			`fetched ${fetched}`,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		return {
			id: `${sectionIndex}:${metric.scope}:${metric.id}`,
			label: `${scopeLabel} · ${metric.label}`,
			value,
			detail,
			scope: metric.scope,
			tone: metric.remaining === 0 ? "error" : "normal",
		};
	}

	const parts: string[] = [];
	if (metric.remainingPercent !== undefined) {
		parts.push(`${formatPercent(metric.remainingPercent, locale)}% remaining`);
	} else if (metric.usedPercent !== undefined) {
		parts.push(`${formatPercent(metric.usedPercent, locale)}% used`);
	} else {
		parts.push("Unknown (not reported)");
	}
	if (resets !== undefined) {
		parts.push(resets);
	}
	const detail = [
		metric.usedPercent === undefined || metric.remainingPercent === undefined
			? undefined
			: `${formatPercent(metric.usedPercent, locale)}% used`,
		metric.remainingPercent === undefined && metric.usedPercent === undefined
			? "value not reported"
			: undefined,
		`window ${durationText(metric.windowSeconds)}`,
		metric.resetsAt === undefined
			? "no reset reported"
			: `full reset ${formatFullTimestamp(metric.resetsAt, locale)}`,
		`fetched ${fetched}`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	const tone: DisplayRow["tone"] =
		metric.remainingPercent === 0
			? "error"
			: metric.remainingPercent !== undefined && metric.remainingPercent <= 20
				? "warning"
				: "normal";
	return {
		id: `${sectionIndex}:${metric.scope}:${metric.id}`,
		label: `${scopeLabel} · ${metric.label}`,
		value: parts.join(" · "),
		detail,
		scope: metric.scope,
		tone,
	};
}

function sectionStatusRow(
	scope: QuotaScope,
	sectionIndex: number,
	result: Extract<SectionResult, { state: UnavailableState }>,
	locale: LocaleContext,
): DisplayRow {
	return {
		id: `${sectionIndex}:${scope}:status`,
		label: `${SCOPE_LABELS[scope]} · status`,
		value: unavailableCopy(result.state, result.reason),
		detail:
			result.retryAfterMs === undefined
				? `attempted ${formatFullTimestamp(result.attemptedAt, locale)}`
				: `retry after ${Math.ceil(result.retryAfterMs / 1000)}s`,
		scope,
		tone: toneForState(result.state),
	};
}

/**
 * Pure view model: unit/scope/time formatting only. No network, no
 * credential resolution, no clock reads. Every reported section stays a row
 * (or several), so a narrow renderer can wrap but never silently drop a
 * constraint or its state.
 */
export function formatQuotaRows(
	read: QuotaRead,
	locale: LocaleContext,
): DisplayRow[] {
	if (!("sections" in read)) {
		return [
			{
				id: "quota:status",
				label: "Quota",
				value: unavailableCopy(read.state, read.reason),
				detail:
					read.retryAfterMs === undefined
						? undefined
						: `retry after ${Math.ceil(read.retryAfterMs / 1000)}s`,
				tone: toneForState(read.state),
			},
		];
	}

	const rows: DisplayRow[] = [];
	read.sections.forEach((section, sectionIndex) => {
		const result = section.result;
		if (result.state !== "available") {
			rows.push(sectionStatusRow(section.scope, sectionIndex, result, locale));
			return;
		}
		if (result.metrics.length === 0) {
			rows.push({
				id: `${sectionIndex}:${section.scope}:empty`,
				label: `${SCOPE_LABELS[section.scope]} · status`,
				value: "No quota values were reported for this scope.",
				detail: `fetched ${formatFullTimestamp(result.fetchedAt, locale)}`,
				scope: section.scope,
				tone: "warning",
			});
		}
		for (const metric of result.metrics) {
			rows.push(metricRow(metric, result, sectionIndex, locale));
		}
		if (result.configuredAppCapPercent !== undefined) {
			rows.push({
				id: `${sectionIndex}:${section.scope}:cap`,
				label: `${SCOPE_LABELS[section.scope]} · configured app cap`,
				value: `${formatPercent(result.configuredAppCapPercent, locale)}% allowed`,
				detail:
					"Configured app cap reported by the provider; never remaining quota.",
				scope: section.scope,
				tone: "normal",
			});
		}
	});
	if (rows.length === 0) {
		rows.push({
			id: "quota:status",
			label: "Quota",
			value: "No quota sections were reported.",
			tone: "warning",
		});
	}
	return rows;
}

export function latestFetchedTime(read: QuotaRead): number | undefined {
	if (!("sections" in read)) {
		return undefined;
	}
	let latest: number | undefined;
	for (const section of read.sections) {
		const result = section.result;
		if (result.state !== "available") {
			continue;
		}
		if (latest === undefined || result.fetchedAt > latest) {
			latest = result.fetchedAt;
		}
	}
	return latest;
}

export function latestAttemptTime(read: QuotaRead): number | undefined {
	if (!("sections" in read)) {
		return read.attemptedAt;
	}
	let latest: number | undefined;
	for (const section of read.sections) {
		const result = section.result;
		const time =
			result.state === "available" ? result.fetchedAt : result.attemptedAt;
		if (latest === undefined || time > latest) {
			latest = time;
		}
	}
	return latest;
}

export function ageText(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1000));
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest === 0 ? `${minutes}m ago` : `${minutes}m ${rest}s ago`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h ago` : `${hours}h ${rest}m ago`;
}

/**
 * Compact sidebar rows: one header and one row per reported quota constraint
 * (configured caps stay on the full page). Rows are never truncated to a hard
 * cap; extra constraints grow the list. The update timestamp is not repeated
 * here; it remains on the full usage page.
 */
export function formatSidebarRows(
	provider: ProviderSummary,
	read: QuotaRead,
	locale: LocaleContext,
	now: number = Date.now(),
): DisplayRow[] {
	const headerName =
		new Map([
			["OpenAI ChatGPT with Codex companion", "OpenAI · Codex quota"],
		]).get(provider.name) ?? provider.name;
	const header: DisplayRow = {
		id: "provider",
		label: headerName,
		value: "",
		tone: "normal",
	};
	const quotaRows: DisplayRow[] = [];
	if (!("sections" in read)) {
		const status = formatQuotaRows(read, locale)[0];
		if (status !== undefined) {
			quotaRows.push({
				...status,
				value:
					read.retryAfterMs === undefined
						? status.value
						: `${status.value} · retry after ${Math.ceil(read.retryAfterMs / 1000)}s`,
			});
		}
	} else {
		const metrics = read.sections.flatMap((section) =>
			section.result.state === "available"
				? section.result.metrics.map((metric) => ({
						scope: section.scope,
						metric,
					}))
				: [],
		);
		const windowCounts = new Map<string, number>();
		for (const { scope, metric } of metrics) {
			if (metric.kind !== "window") continue;
			const key = `${scope}:${metric.windowSeconds}`;
			windowCounts.set(key, (windowCounts.get(key) ?? 0) + 1);
		}
		const scopeNames: Record<QuotaScope, string> = {
			app: "App",
			"shared-plan": "Shared",
			"provider-balance": "Balance",
		};
		const moneyNames = new Map([
			["Included credits", "Included"],
			["Purchased credits", "Purchased"],
			["Total credits", "Total"],
		]);
		const genericWindowNames = new Set([
			"Current app limit",
			"Shared plan primary limit",
			"Shared plan secondary limit",
			"Primary",
			"Secondary",
		]);
		read.sections.forEach((section, sectionIndex) => {
			const result = section.result;
			if (result.state !== "available") {
				const row = sectionStatusRow(
					section.scope,
					sectionIndex,
					result,
					locale,
				);
				row.label = `${scopeNames[section.scope]} status`;
				if (result.retryAfterMs !== undefined) {
					row.value += ` · retry after ${Math.ceil(result.retryAfterMs / 1000)}s`;
				}
				quotaRows.push(row);
				return;
			}
			if (result.metrics.length === 0) {
				quotaRows.push({
					id: `${sectionIndex}:${section.scope}:empty`,
					label: `${scopeNames[section.scope]} status`,
					value: "No quota values were reported for this scope.",
					detail: `fetched ${formatFullTimestamp(result.fetchedAt, locale)}`,
					scope: section.scope,
					tone: "warning",
				});
			}
			for (const metric of result.metrics) {
				const row = metricRow(metric, result, sectionIndex, locale);
				if (metric.kind === "money") {
					row.label = moneyNames.get(metric.label) ?? metric.label;
					row.value = `${formatCurrency(metric.remaining, locale)} remaining`;
				} else {
					const duration = durationText(metric.windowSeconds).replace(" ", "");
					row.label = `${scopeNames[section.scope]} ${duration}`;
					if (
						(windowCounts.get(`${section.scope}:${metric.windowSeconds}`) ??
							0) > 1 ||
						!genericWindowNames.has(metric.label)
					) {
						row.label += ` · ${metric.label}`;
					}
					row.value =
						metric.remainingPercent !== undefined
							? `${formatPercent(metric.remainingPercent, locale)}% remaining`
							: metric.usedPercent !== undefined
								? `${formatPercent(metric.usedPercent, locale)}% used`
								: "Unknown (not reported)";
				}
				if (metric.resetsAt !== undefined) {
					row.value += ` · ${formatResetCompact(metric.resetsAt, locale, now)}`;
				}
				quotaRows.push(row);
			}
		});
		if (read.sections.length === 0) {
			quotaRows.push({
				id: "quota:status",
				label: "Quota",
				value: "No quota sections were reported.",
				tone: "warning",
			});
		}
	}
	return [header, ...quotaRows];
}

/** Plain-text sidebar presentation. This intentionally keeps each reported
 * metric separate; the dashboard's row compaction remains unchanged. */
export function formatSidebarText(
	provider: ProviderSummary,
	read: QuotaRead,
	locale: LocaleContext,
	now: number = Date.now(),
): string {
	const rows = formatSidebarRows(provider, read, locale, now);
	return rows
		.map((row) =>
			row.value.length === 0 ? row.label : `${row.label}: ${row.value}`,
		)
		.join("\n");
}

/**
 * Locally re-validates pushed/fetched snapshots (ledger ruling 2). Expired
 * sections stop rendering figures and become an unavailable state; still
 * fresh sections keep their values. Nothing is inferred and no section is
 * removed.
 */
export function revalidateQuota(read: QuotaRead, now: number): QuotaRead {
	if (!("sections" in read)) {
		return read;
	}
	let changed = false;
	const sections = read.sections.map((section) => {
		const result = section.result;
		if (
			result.state !== "available" ||
			Math.min(result.expiresAt, result.fetchedAt + 90_000) > now
		) {
			return section;
		}
		changed = true;
		return {
			scope: section.scope,
			result: {
				state: "unavailable" as const,
				reason: "no_validated_quota_source" as const,
				attemptedAt: result.fetchedAt,
			},
		};
	});
	if (!changed) {
		return read;
	}
	return {
		state: "partial",
		authSource: read.authSource,
		sections,
	};
}

/** First remaining currentness boundary; a display deadline, never a fetch. */
export function nextQuotaExpiry(
	read: QuotaRead,
	now: number,
): number | undefined {
	if (!("sections" in read)) return undefined;
	const deadlines = read.sections.flatMap((section) => {
		if (section.result.state !== "available") return [];
		const at = Math.min(
			section.result.expiresAt,
			section.result.fetchedAt + 90_000,
		);
		return at > now ? [at] : [];
	});
	return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

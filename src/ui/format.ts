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

export const EXPIRED_COMPANION_COPY =
	"Quota unavailable: Codex companion login expired. Renew that login in Codex, then refresh.";
export const NATIVE_ONLY_COPY =
	"Quota unavailable: the current OpenCode OpenAI sign-in alone cannot read quota. Enable the Codex companion option on the server to use that existing login.";
export const REJECTED_AUTH_COPY =
	"Quota unavailable: credentials were rejected, invalid, or expired. Re-authenticate via /connect, then refresh.";
export const UNSUPPORTED_NO_SOURCE_COPY =
	"Quota unavailable: no quota source is validated for this provider.";
export const UNAVAILABLE_NO_CURRENT_COPY =
	"Quota unavailable: no current validated quota. The last result expired or has not completed. Refresh to try again.";
export const NOT_APPLICABLE_COPY =
	"Quota not applicable: this provider has no cloud quota to report.";

const SCOPE_LABELS: Record<QuotaScope, string> = {
	"provider-balance": "Provider balance",
	"shared-plan": "Shared plan",
	app: "App",
};

const SUPPORT_LABELS: Record<ProviderSummary["support"], string> = {
	supported: "supported",
	unsupported: "unsupported",
	"not-applicable": "not applicable",
	"requires-companion": "requires companion",
};

const EVIDENCE_LABELS: Record<ProviderSummary["evidence"], string> = {
	"live-validated": "live-validated",
	"documented-only": "documented-only",
	unverified: "unverified",
};

const REASON_COPY: Record<string, string> = {
	companion_missing:
		"Quota unavailable: no Codex companion login was found. Sign in with Codex on the server, then refresh.",
	unsupported_companion_storage:
		"Quota unavailable: the Codex companion login uses a storage mode v1 does not support. Use the file-backed Codex login on the server.",
	invalid_companion:
		"Quota unavailable: the Codex companion login could not be read. Renew that login in Codex, then refresh.",
	app_registration_mismatch:
		"Quota unavailable: no unique Codex app matched the current OpenCode OpenAI sign-in. Sign in with the matching account in Codex, then refresh.",
	invalid_native_registration:
		"Quota unavailable: the current OpenCode OpenAI sign-in could not be matched. Re-authenticate via /connect, then refresh.",
	rate_limited:
		"Quota unavailable: the provider rate limit is active. Try again after the retry window.",
	timeout:
		"Quota unavailable: the provider request timed out. Refresh to try again.",
	network_error:
		"Quota unavailable: the provider could not be reached. Refresh to try again.",
	invalid_response:
		"Quota unavailable: the provider returned an unusable response. Refresh to try again.",
};

export function supportLabel(provider: ProviderSummary): string {
	return `${SUPPORT_LABELS[provider.support]} · ${EVIDENCE_LABELS[provider.evidence]}`;
}

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
	if (reason === "companion_expired") {
		return EXPIRED_COMPANION_COPY;
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

function scopedLabel(
	label: string,
): { scope: string; base: string } | undefined {
	const separator = label.indexOf(" · ");
	if (separator <= 0) {
		return undefined;
	}
	return {
		scope: label.slice(0, separator),
		base: label.slice(separator + 3),
	};
}

/**
 * Merges only rows whose duration, reset, values, tone, and base explanation
 * are all identical. Merged rows keep both scope labels and the shared
 * detail. A differing reset or value never merges (review failure mode 3).
 */
export function compactRows(rows: DisplayRow[]): DisplayRow[] {
	const consumed = new Set<number>();
	const result: DisplayRow[] = [];

	rows.forEach((row, index) => {
		if (consumed.has(index)) {
			return;
		}
		const rowLabel = scopedLabel(row.label);
		if (row.scope === undefined || rowLabel === undefined) {
			result.push(row);
			return;
		}
		const merged: DisplayRow[] = [row];
		rows.forEach((other, otherIndex) => {
			if (otherIndex <= index || consumed.has(otherIndex)) {
				return;
			}
			if (other.scope === undefined || other.scope === row.scope) {
				return;
			}
			const otherLabel = scopedLabel(other.label);
			if (otherLabel === undefined || otherLabel.base !== rowLabel.base) {
				return;
			}
			if (
				other.value !== row.value ||
				other.tone !== row.tone ||
				(other.detail ?? "") !== (row.detail ?? "")
			) {
				return;
			}
			merged.push(other);
			consumed.add(otherIndex);
		});
		if (merged.length === 1) {
			result.push(row);
			return;
		}
		const scopeNames = [
			...new Set(merged.map((entry) => scopedLabel(entry.label)?.scope ?? "")),
		].filter((scope) => scope.length > 0);
		const detail = row.detail;
		result.push({
			id: merged.map((entry) => entry.id).join("+"),
			label: `${scopeNames.join(" + ")} · ${rowLabel.base}`,
			value: row.value,
			detail:
				detail === undefined
					? `Scopes: ${scopeNames.join(", ")}`
					: `Scopes: ${scopeNames.join(", ")} · ${detail}`,
			scope: row.scope,
			tone: row.tone,
		});
	});
	return result;
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

export function formatUpdateAge(
	read: QuotaRead,
	now: number,
	_locale: LocaleContext,
): string {
	const time = latestFetchedTime(read) ?? latestAttemptTime(read);
	return time === undefined ? "never" : ageText(now - time);
}

function updateAgeRow(
	read: QuotaRead,
	now: number,
	locale: LocaleContext,
): DisplayRow {
	const fetchedAt = latestFetchedTime(read);
	if (fetchedAt !== undefined) {
		return {
			id: "quota:age",
			label: "Updated",
			value: ageText(now - fetchedAt),
			detail: `Fetched ${formatFullTimestamp(fetchedAt, locale)}`,
			tone: "normal",
		};
	}
	const attemptedAt = latestAttemptTime(read);
	if (attemptedAt !== undefined) {
		return {
			id: "quota:age",
			label: "Last attempt",
			value: ageText(now - attemptedAt),
			detail: `Attempted ${formatFullTimestamp(attemptedAt, locale)}`,
			tone: "warning",
		};
	}
	return {
		id: "quota:age",
		label: "Updated",
		value: "never",
		detail: "No successful read has been reported.",
		tone: "warning",
	};
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
					const resetParts = dateParts(metric.resetsAt, locale);
					const currentYear = dateParts(now, locale).year;
					const date = new Intl.DateTimeFormat(locale.locale, {
						timeZone: locale.timeZone,
						calendar: "gregory",
						month: "short",
						day: "numeric",
					}).format(metric.resetsAt);
					row.value += ` · resets ${date} ${resetParts.hour}:${resetParts.minute}${resetParts.year !== currentYear ? ` · ${resetParts.year}` : ""}`;
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

export type UsageSection = {
	providerID: string;
	heading: string;
	support: string;
	rows: DisplayRow[];
};

/**
 * Full-page view model derived only from sanitized provider declarations and
 * quota reads. A provider that did not exist when this file was written
 * renders through exactly this path.
 */
export function formatUsageSections(input: {
	providers: ProviderSummary[];
	quotaByProvider: Record<string, QuotaRead>;
	locale: LocaleContext;
	now?: number;
}): UsageSection[] {
	const now = input.now ?? Date.now();
	return input.providers.map((provider) => {
		const read = input.quotaByProvider[provider.providerID];
		const auth: DisplayRow = {
			id: "support",
			label: "Support",
			value: supportLabel(provider),
			detail:
				provider.integrationID === undefined
					? `${provider.authMethod} · provider ${provider.providerID}`
					: `${provider.authMethod} · integration ${provider.integrationID} · provider ${provider.providerID}`,
			tone: "normal",
		};
		const quotaRows: DisplayRow[] =
			read === undefined
				? [
						{
							id: "quota:pending",
							label: "Quota",
							value: "Not loaded yet. Refresh to load.",
							tone: "warning",
						},
					]
				: [
						...("sections" in read
							? [
									{
										id: "auth-source",
										label: "Auth source",
										value: read.authSource,
										detail:
											"Read on the server; credentials never cross plugin RPC.",
										tone: "normal" as const,
									},
								]
							: []),
						...formatQuotaRows(read, input.locale),
					];
		const age =
			read === undefined
				? ({
						id: "quota:age",
						label: "Updated",
						value: "never",
						detail: "No read has completed for this provider yet.",
						tone: "warning",
					} satisfies DisplayRow)
				: updateAgeRow(read, now, input.locale);
		return {
			providerID: provider.providerID,
			heading: provider.name,
			support: supportLabel(provider),
			rows: [auth, ...quotaRows, age].map((row) => ({
				...row,
				id: `${provider.providerID}:${row.id}`,
			})),
		};
	});
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
		if (result.state !== "available" || result.expiresAt > now) {
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

function wrapLine(text: string, width: number): string[] {
	const limit = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	let current = "";
	const push = () => {
		if (current.length > 0) {
			lines.push(current);
			current = "";
		}
	};
	for (const word of text.split(/\s+/)) {
		if (word.length === 0) {
			continue;
		}
		if (word.length > limit) {
			push();
			let rest = word;
			while (rest.length > limit) {
				lines.push(rest.slice(0, limit));
				rest = rest.slice(limit);
			}
			current = rest;
			continue;
		}
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= limit) {
			current = `${current} ${word}`;
		} else {
			push();
			current = word;
		}
	}
	push();
	return lines.length === 0 ? [""] : lines;
}

/**
 * Deterministic render-to-rows reducer used by the thin components and the
 * presentation tests. Wrapping preserves every word; nothing is ellipsized
 * or dropped at any width.
 */
export function renderRowsToLines(
	rows: DisplayRow[],
	width: number,
	options: { details?: boolean } = {},
): string[] {
	const lines: string[] = [];
	for (const row of rows) {
		lines.push(...wrapLine(`${row.label}: ${row.value}`, width));
		if (options.details === true && row.detail !== undefined) {
			for (const line of wrapLine(row.detail, Math.max(1, width - 2))) {
				lines.push(`  ${line}`);
			}
		}
	}
	return lines;
}

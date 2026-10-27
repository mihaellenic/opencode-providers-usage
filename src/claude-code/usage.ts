// biome-ignore-all lint/suspicious/noControlCharactersInRegex: terminal escape sequences are the input this parser must normalize.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

export type ClaudeUsage = {
	session: { usedPercent: number; resetsAt: number };
	week: { usedPercent: number; resetsAt: number };
};

export const CLAUDE_USAGE_TIMEOUT_MS = 30_000;
export const CLAUDE_USAGE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const CLAUDE_USAGE_CLEANUP_GRACE_MS = 250;

/**
 * The only CLI interaction this module performs. Print mode receives the
 * explicit local `/usage` command, not a normal model prompt.
 *
 * `--bare` is deliberately absent: it skips hooks, but it also stops reading
 * OAuth/keychain credentials and would no longer use the logged-in account.
 * No hook-suppressing flag was verified to preserve that account, so the
 * command stays exactly as probed.
 */
export const CLAUDE_USAGE_COMMAND = [
	"claude",
	"-p",
	"/usage",
	"--output-format",
	"json",
	"--no-session-persistence",
	"--strict-mcp-config",
	"--tools",
	"",
] as const;

export type ClaudeUsageSpawnOptions = {
	stdin: "ignore";
	stdout: "pipe";
	stderr: "ignore";
	detached: true;
	cwd: string;
};

export type ClaudeUsageChild = {
	readonly pid?: number;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: NodeJS.Signals | number): void;
};

export type ClaudeUsageSpawn = (
	command: readonly string[],
	options: ClaudeUsageSpawnOptions,
) => ClaudeUsageChild;

export type ClaudeUsageCollectOptions = {
	spawn?: ClaudeUsageSpawn;
	now?: () => number;
	platform?: NodeJS.Platform;
	homeDirectory?: string;
	directoryExists?: (path: string) => boolean;
	killProcess?: (pid: number, signal: NodeJS.Signals | number) => void;
	timeoutMs?: number;
	maxOutputBytes?: number;
	cleanupGraceMs?: number;
};

const defaultDirectoryExists = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Use the OS home directory rather than the current project so project-level
 * Claude settings and hooks are not discovered. If no valid absolute home
 * directory exists, fail closed instead of falling back to the project cwd.
 */
function resolveNeutralCwd(
	home: string,
	directoryExists: (path: string) => boolean,
): string | null {
	const trimmed = home.trim();
	if (trimmed === "" || !isAbsolute(trimmed)) {
		return null;
	}
	try {
		return directoryExists(trimmed) ? trimmed : null;
	} catch {
		return null;
	}
}

const defaultSpawn: ClaudeUsageSpawn = (command, options) =>
	Bun.spawn([...command], options);

const defaultKillProcess = (
	pid: number,
	signal: NodeJS.Signals | number,
): void => {
	process.kill(pid, signal);
};

const MAX_RESET_FUTURE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8.64e15;

/**
 * Process-group termination is only implemented where negative-PID signals
 * have POSIX semantics. Other platforms fail closed rather than run a child
 * whose descendant tree cannot be safely reaped.
 */
const POSIX_PLATFORMS: ReadonlySet<string> = new Set([
	"aix",
	"android",
	"darwin",
	"freebsd",
	"haiku",
	"linux",
	"netbsd",
	"openbsd",
	"sunos",
]);

function supportsProcessGroups(platform: NodeJS.Platform): boolean {
	return POSIX_PLATFORMS.has(platform);
}

/**
 * A detached child is its own group leader, so `-pid` targets only its group.
 * Never signal PID 0/1, our own PID, or our parent PID: those are the
 * dangerous process-group targets.
 */
function safeProcessGroupId(pid: number | undefined): number | null {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
		return null;
	}
	if (pid === process.pid || pid === process.ppid) {
		return null;
	}
	return pid;
}

function resolveMaxOutputBytes(value: number | undefined): number {
	if (value === undefined) {
		return CLAUDE_USAGE_MAX_OUTPUT_BYTES;
	}
	if (!Number.isSafeInteger(value) || value <= 0) {
		return CLAUDE_USAGE_MAX_OUTPUT_BYTES;
	}
	return Math.min(value, CLAUDE_USAGE_MAX_OUTPUT_BYTES);
}

function resolvePositiveMs(
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || value <= 0) {
		return fallback;
	}
	return value;
}

function resolveTimeoutMs(value: number | undefined): number {
	return Math.min(
		resolvePositiveMs(value, CLAUDE_USAGE_TIMEOUT_MS),
		CLAUDE_USAGE_TIMEOUT_MS,
	);
}

function resolveCleanupGraceMs(value: number | undefined): number {
	return Math.min(
		resolvePositiveMs(value, CLAUDE_USAGE_CLEANUP_GRACE_MS),
		CLAUDE_USAGE_CLEANUP_GRACE_MS,
	);
}

function isValidNow(now: number): boolean {
	return Number.isSafeInteger(now) && Math.abs(now) <= MAX_DATE_MS;
}

/**
 * Date.UTC maps years 0-99 to 1900-1999. Set the full year explicitly so
 * explicit, far-future, or rollover years cannot silently change meaning.
 */
function utcEpoch(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): number | null {
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day) ||
		!Number.isInteger(hour) ||
		!Number.isInteger(minute) ||
		!Number.isInteger(second)
	) {
		return null;
	}
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);
	const epoch = date.getTime();
	return Number.isFinite(epoch) ? epoch : null;
}

const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const DCS_SEQUENCE = /\u001B[P_^][\s\S]*?\u001B\\/g;
const CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001B[@-Z\\-_]/g;
const LEFTOVER_ESCAPE = /\u001B./g;

const MONTH_INDEX: Readonly<Record<string, number>> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const PERCENT_PATTERN = "([0-9]{1,3}(?:\\.[0-9]+)?)";
const RESET_PATTERN =
	"([A-Za-z]{3}) ([0-9]{1,2})(?:, ([0-9]{4}))? at ([0-9]{1,2})(?::([0-9]{2}))?(am|pm) \\(([^()\\s]+)\\)";

const SESSION_LINE = new RegExp(
	`^Current session: ${PERCENT_PATTERN}% used · resets ${RESET_PATTERN}$`,
	"gm",
);
const WEEK_LINE = new RegExp(
	`^Current week \\(all models\\): ${PERCENT_PATTERN}% used · resets ${RESET_PATTERN}$`,
	"gm",
);

function overlayCarriageReturns(line: string): string {
	if (!line.includes("\r")) {
		return line;
	}
	let result = "";
	for (const segment of line.split("\r")) {
		// A carriage return moves to column zero; the new frame overwrites the
		// old one only as far as it writes. Any remaining old characters stay.
		result = segment + result.slice(segment.length);
	}
	return result;
}

/**
 * Strips terminal control sequences and applies carriage-return repainting.
 * Only complete, literal lines survive this normalization.
 */
function normalizeScreen(screen: string): string {
	const stripped = screen
		.replace(OSC_SEQUENCE, "")
		.replace(DCS_SEQUENCE, "")
		.replace(CSI_SEQUENCE, "")
		.replace(ESCAPE_SEQUENCE, "")
		.replace(LEFTOVER_ESCAPE, "");

	return stripped
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map(overlayCarriageReturns)
		.join("\n");
}

type ZoneParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
	const cached = formatterCache.get(zone);
	if (cached !== undefined) {
		return cached;
	}
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			calendar: "gregory",
			numberingSystem: "latn",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		formatterCache.set(zone, formatter);
		return formatter;
	} catch {
		formatterCache.set(zone, null);
		return null;
	}
}

function formatZoneParts(
	epoch: number,
	formatter: Intl.DateTimeFormat,
): ZoneParts | null {
	if (!Number.isFinite(epoch)) {
		return null;
	}
	const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = formatter.formatToParts(new Date(epoch));
	} catch {
		return null;
	}
	for (const part of parts) {
		values[part.type] = part.value;
	}

	const year = Number(values.year);
	const month = Number(values.month);
	const day = Number(values.day);
	const hour = Number(values.hour);
	const minute = Number(values.minute);
	const second = Number(values.second);
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day) ||
		!Number.isInteger(hour) ||
		!Number.isInteger(minute) ||
		!Number.isInteger(second)
	) {
		return null;
	}
	return { year, month, day, hour, minute, second };
}

function offsetAt(
	epoch: number,
	formatter: Intl.DateTimeFormat,
): number | null {
	const parts = formatZoneParts(epoch, formatter);
	if (parts === null) {
		return null;
	}
	const asUtc = utcEpoch(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	if (asUtc === null) {
		return null;
	}
	return asUtc - Math.floor(epoch / 1000) * 1000;
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
	if (month === 1) {
		return isLeapYear(year) ? 29 : 28;
	}
	return MONTH_DAYS[month] ?? 0;
}

/**
 * Resolves a wall-clock time in an IANA zone to every matching instant. Two
 * instants means the time is ambiguous (DST fall-back); zero means it does not
 * exist (DST spring-forward).
 */
function wallTimeCandidates(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	formatter: Intl.DateTimeFormat,
): number[] | null {
	const guess = utcEpoch(year, month, day, hour, minute, 0);
	if (guess === null) {
		return null;
	}
	const offsets = new Set<number>();
	// Sampling around the date captures both sides of any offset transition.
	for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) {
		const offset = offsetAt(guess + delta, formatter);
		if (offset === null) {
			return null;
		}
		offsets.add(offset);
	}

	const matches = new Set<number>();
	for (const offset of offsets) {
		const candidate = guess - offset;
		const parts = formatZoneParts(candidate, formatter);
		if (
			parts !== null &&
			parts.year === year &&
			parts.month - 1 === month &&
			parts.day === day &&
			parts.hour === hour &&
			parts.minute === minute &&
			parts.second === 0
		) {
			matches.add(candidate);
		}
	}
	return [...matches].sort((left, right) => left - right);
}

function resolveReset(
	now: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	zone: string,
	explicitYear: number | null,
): number | null {
	const formatter = zoneFormatter(zone);
	if (formatter === null) {
		return null;
	}
	const nowParts = formatZoneParts(now, formatter);
	if (nowParts === null) {
		return null;
	}

	const maxFuture = now + MAX_RESET_FUTURE_MS;
	// When the CLI prints a year, that year is authoritative. Otherwise the
	// displayed line omits it, and only the current zone year or the next one
	// can produce a reset within the eight-day acceptance window.
	const years =
		explicitYear === null ? [nowParts.year, nowParts.year + 1] : [explicitYear];
	for (const year of years) {
		if (year < 1 || day > daysInMonth(year, month)) {
			continue;
		}
		const candidates = wallTimeCandidates(
			year,
			month,
			day,
			hour,
			minute,
			formatter,
		);
		if (candidates === null || candidates.length === 0) {
			continue;
		}
		const inWindow = candidates.filter(
			(candidate) => candidate >= now && candidate <= maxFuture,
		);
		if (candidates.length > 1) {
			if (explicitYear !== null || inWindow.length > 0) {
				// Never choose one offset for an ambiguous local time.
				return null;
			}
			continue;
		}
		if (inWindow.length === 1) {
			return inWindow[0] ?? null;
		}
	}
	return null;
}

type ParsedWindow = { usedPercent: number; resetsAt: number };

function parseWindowMatch(
	match: RegExpExecArray,
	now: number,
): ParsedWindow | null {
	const percentText = match[1];
	const monthText = match[2];
	const dayText = match[3];
	const yearText = match[4];
	const hourText = match[5];
	const minuteText = match[6];
	const meridiem = match[7];
	const zone = match[8];
	if (
		percentText === undefined ||
		monthText === undefined ||
		dayText === undefined ||
		hourText === undefined ||
		meridiem === undefined ||
		zone === undefined
	) {
		return null;
	}

	const usedPercent = Number(percentText);
	if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
		return null;
	}

	const month = MONTH_INDEX[monthText.toLowerCase()];
	if (month === undefined) {
		return null;
	}
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = minuteText === undefined ? 0 : Number(minuteText);
	let explicitYear: number | null = null;
	if (yearText !== undefined) {
		explicitYear = Number(yearText);
		if (
			!Number.isInteger(explicitYear) ||
			explicitYear < 1 ||
			explicitYear > 9999
		) {
			return null;
		}
	}
	if (!Number.isInteger(day) || day < 1 || day > 31) {
		return null;
	}
	if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
		return null;
	}
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
		return null;
	}

	const hour24 = (hour % 12) + (meridiem === "pm" ? 12 : 0);
	const resetsAt = resolveReset(
		now,
		month,
		day,
		hour24,
		minute,
		zone,
		explicitYear,
	);
	if (resetsAt === null) {
		return null;
	}
	return { usedPercent, resetsAt };
}

/**
 * Requires exactly one distinct complete value for a window. Repaints may
 * repeat the same frame; conflicting frames are treated as unreliable.
 */
function collectWindow(
	pattern: RegExp,
	screen: string,
	now: number,
): ParsedWindow | null {
	pattern.lastIndex = 0;
	const parsed = new Map<string, ParsedWindow>();
	for (const match of screen.matchAll(pattern)) {
		const window = parseWindowMatch(match, now);
		if (window === null) {
			return null;
		}
		parsed.set(`${window.usedPercent}:${window.resetsAt}`, window);
	}
	if (parsed.size !== 1) {
		return null;
	}
	return parsed.values().next().value ?? null;
}

/**
 * Parses only the two overall windows. Model-specific windows, partial frames,
 * and reset times that cannot be resolved unambiguously yield null.
 */
export function parseClaudeUsage(
	screen: string,
	now: number,
): ClaudeUsage | null {
	if (!isValidNow(now)) {
		return null;
	}
	const normalized = normalizeScreen(screen);
	const session = collectWindow(SESSION_LINE, normalized, now);
	if (session === null) {
		return null;
	}
	const week = collectWindow(WEEK_LINE, normalized, now);
	if (week === null) {
		return null;
	}
	return { session, week };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the JSON envelope without ever exposing it outside this module. */
function resultText(stdout: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	if (
		parsed.type !== "result" ||
		parsed.subtype !== "success" ||
		parsed.is_error !== false ||
		parsed.local_command !== "usage"
	) {
		return null;
	}
	return typeof parsed.result === "string" ? parsed.result : null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Terminates the detached process group when a safe group identifier exists,
 * then terminates the direct child as a fallback. Never uses a shell.
 */
function terminateChild(
	child: ClaudeUsageChild,
	killProcess: (pid: number, signal: NodeJS.Signals | number) => void,
): void {
	let group: number | null = null;
	try {
		group = safeProcessGroupId(child.pid);
	} catch {
		// A malformed process boundary has no safe group identifier.
	}
	if (group !== null) {
		try {
			killProcess(-group, "SIGKILL");
		} catch {
			// The group may already be gone; the direct child kill remains.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// A process that already exited needs no signal.
	}
}

/** Waits for a promise, but never longer than the supplied grace period. */
async function waitBounded(promise: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	await Promise.race([promise, grace]);
	if (timer !== undefined) {
		clearTimeout(timer);
	}
}

async function runUsageCommand(
	spawn: ClaudeUsageSpawn,
	killProcess: (pid: number, signal: NodeJS.Signals | number) => void,
	signal: AbortSignal,
	timeoutMs: number,
	maxOutputBytes: number,
	cleanupGraceMs: number,
	cwd: string,
): Promise<string | null> {
	let child: ClaudeUsageChild;
	try {
		child = spawn([...CLAUDE_USAGE_COMMAND], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			detached: true,
			cwd,
		});
	} catch {
		return null;
	}

	let reader: ReturnType<ClaudeUsageChild["stdout"]["getReader"]>;
	try {
		reader = child.stdout.getReader();
	} catch {
		terminateChild(child, killProcess);
		try {
			await waitBounded(
				Promise.resolve(child.exited).then(
					() => {},
					() => {},
				),
				cleanupGraceMs,
			);
		} catch {
			// Reaping is best-effort when the process boundary is malformed.
		}
		return null;
	}

	let stopped = false;
	let failed = false;
	let resolveStopped!: () => void;
	const stoppedPromise = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		failed = true;
		terminateChild(child, killProcess);
		resolveStopped();
		try {
			void reader.cancel().catch(() => {
				// Cancelling an already-closed stream is cleanup, not an error.
			});
		} catch {
			// A malformed stream boundary may throw synchronously.
		}
	};

	const onAbort = () => stop();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) {
		onAbort();
	}
	const timer = setTimeout(stop, timeoutMs);

	let exitCode: number | null = null;
	let exitSettled = false;
	let exitPromise: Promise<void>;
	try {
		exitPromise = Promise.resolve(child.exited).then(
			(code) => {
				exitCode = code;
				exitSettled = true;
			},
			() => {
				exitSettled = true;
			},
		);
	} catch {
		stop();
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		return null;
	}

	const textPromise = (async (): Promise<string | null> => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value === undefined || value.byteLength === 0) {
					continue;
				}
				total += value.byteLength;
				if (total > maxOutputBytes) {
					stop();
					return null;
				}
				chunks.push(value);
			}
		} catch {
			return null;
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// The reader is already released after a cancellation.
			}
		}
		if (total === 0) {
			return "";
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return decodeUtf8(bytes);
	})();

	try {
		const outcome = await Promise.race([
			Promise.allSettled([textPromise, exitPromise]).then(
				() => "settled" as const,
			),
			stoppedPromise.then(() => "stopped" as const),
		]);
		if (outcome === "stopped") {
			return null;
		}
		const text = await textPromise;
		if (failed || signal.aborted || exitCode !== 0 || text === null) {
			return null;
		}
		// Do not group-kill after a successful parent exit. Bun has already
		// reaped the leader, so the PGID may be reused and a negative-PID
		// signal could hit an unrelated group. Descendants surviving a
		// successful /usage are therefore a documented limitation.
		return text;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		if (!exitSettled) {
			stop();
			await waitBounded(exitPromise, cleanupGraceMs);
		}
	}
}

/**
 * Runs one bounded, non-interactive `/usage` command and returns sanitized
 * quota data. Every failure, cancellation, timeout, or oversized output yields
 * null; raw CLI output never leaves this module.
 */
export async function collectClaudeUsage(
	signal: AbortSignal,
	options: ClaudeUsageCollectOptions = {},
): Promise<ClaudeUsage | null> {
	if (signal.aborted) {
		return null;
	}
	const platform = options.platform ?? process.platform;
	if (!supportsProcessGroups(platform)) {
		return null;
	}
	let home: string;
	try {
		home = options.homeDirectory ?? homedir();
	} catch {
		return null;
	}
	const cwd = resolveNeutralCwd(
		home,
		options.directoryExists ?? defaultDirectoryExists,
	);
	if (cwd === null) {
		return null;
	}
	const spawn = options.spawn ?? defaultSpawn;
	const killProcess = options.killProcess ?? defaultKillProcess;
	const readNow = options.now ?? Date.now;
	const timeoutMs = resolveTimeoutMs(options.timeoutMs);
	const maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes);
	const cleanupGraceMs = resolveCleanupGraceMs(options.cleanupGraceMs);

	let startedAt: number;
	try {
		startedAt = readNow();
	} catch {
		return null;
	}
	if (!isValidNow(startedAt)) {
		return null;
	}

	let stdout: string | null;
	try {
		stdout = await runUsageCommand(
			spawn,
			killProcess,
			signal,
			timeoutMs,
			maxOutputBytes,
			cleanupGraceMs,
			cwd,
		);
	} catch {
		return null;
	}
	if (stdout === null) {
		return null;
	}
	const text = resultText(stdout);
	if (text === null || signal.aborted) {
		return null;
	}
	let completedAt: number;
	try {
		completedAt = readNow();
	} catch {
		return null;
	}
	if (!isValidNow(completedAt) || signal.aborted) {
		return null;
	}
	let usage: ClaudeUsage | null;
	try {
		usage = parseClaudeUsage(text, completedAt);
	} catch {
		return null;
	}
	if (signal.aborted) {
		return null;
	}
	return usage;
}

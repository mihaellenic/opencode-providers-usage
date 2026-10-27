import { describe, expect, test } from "bun:test";
import {
	CLAUDE_USAGE_CLEANUP_GRACE_MS,
	CLAUDE_USAGE_COMMAND,
	CLAUDE_USAGE_MAX_OUTPUT_BYTES,
	CLAUDE_USAGE_TIMEOUT_MS,
	collectClaudeUsage,
	parseClaudeUsage,
} from "../../src/claude-code/usage";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const SESSION_RESET = Date.UTC(2026, 5, 15, 23, 7, 0);
const WEEK_RESET = Date.UTC(2026, 5, 19, 14, 43, 0);

const SESSION_LINE =
	"Current session: 37% used · resets Jun 15 at 6:07pm (America/Chicago)";
const WEEK_LINE =
	"Current week (all models): 64% used · resets Jun 19 at 9:43am (America/Chicago)";

// Sanitized shape of the independently confirmed print-mode JSON result. The
// values are synthetic; the envelope and overall-line formats match the probe.
const SANITIZED_RESULT = [
	"You are currently using your subscription to power your Claude Code usage",
	"",
	SESSION_LINE,
	WEEK_LINE,
	"",
	"What's contributing to your limits usage?",
	"Approximate · sessions on this machine only · shares overlap",
	"",
	"Last 24h · 1000 requests · 20 sessions",
	"  87%  A synthetic recommendation",
	"  Top skills: /synthetic:skill 2%",
	"",
	"Last 7d · 1000 requests · 20 sessions",
].join("\n");

const EXPECTED_USAGE = {
	session: { usedPercent: 37, resetsAt: SESSION_RESET },
	week: { usedPercent: 64, resetsAt: WEEK_RESET },
};

const SANITIZED_USAGE_JSON = JSON.stringify({
	type: "result",
	subtype: "success",
	is_error: false,
	local_command: "usage",
	result: SANITIZED_RESULT,
	session_id: "synthetic-session-id",
	duration_ms: 0,
});

describe("parseClaudeUsage", () => {
	test("parses both complete overall windows with exact reset instants", () => {
		expect(parseClaudeUsage(SANITIZED_RESULT, NOW)).toEqual(EXPECTED_USAGE);
	});

	test("ignores model-specific windows", () => {
		const screen = [
			SESSION_LINE,
			"Current week (Opus): 12% used · resets Jun 20 at 8:00am (America/Chicago)",
			WEEK_LINE,
		].join("\n");

		expect(parseClaudeUsage(screen, NOW)).toEqual(EXPECTED_USAGE);
	});

	test("requires both overall windows", () => {
		expect(parseClaudeUsage(SESSION_LINE, NOW)).toBeNull();
		expect(parseClaudeUsage(WEEK_LINE, NOW)).toBeNull();
		expect(
			parseClaudeUsage(
				[
					SESSION_LINE,
					"Current week (Opus): 12% used · resets Jun 20 at 8:00am (America/Chicago)",
				].join("\n"),
				NOW,
			),
		).toBeNull();
	});

	test("accepts percentage bounds and rejects values outside 0-100", () => {
		const zero = [
			"Current session: 0% used · resets Jun 15 at 6:07pm (America/Chicago)",
			"Current week (all models): 100% used · resets Jun 19 at 9:43am (America/Chicago)",
		].join("\n");
		expect(parseClaudeUsage(zero, NOW)).toEqual({
			session: { usedPercent: 0, resetsAt: SESSION_RESET },
			week: { usedPercent: 100, resetsAt: WEEK_RESET },
		});

		for (const percentage of ["101%", "-1%", "abc%"]) {
			const screen = [
				`Current session: ${percentage} used · resets Jun 15 at 6:07pm (America/Chicago)`,
				WEEK_LINE,
			].join("\n");
			expect(parseClaudeUsage(screen, NOW)).toBeNull();
		}
	});

	test("rejects malformed, unknown-zone, and impossible resets", () => {
		const cases = [
			"Current session: 37% used · resets Jnu 15 at 6:07pm (America/Chicago)",
			"Current session: 37% used · resets Jun 15 at 6:07pm (Mars/Olympus)",
			"Current session: 37% used · resets Jun 15 at 6:07pm",
			"Current session: 37% used · resets Feb 30 at 6:07pm (UTC)",
			"Current session: 37% used · resets Jun 15 at 13:07pm (America/Chicago)",
			"Current session: 37% used · resets Jun 15 at 6:70pm (America/Chicago)",
		];

		for (const session of cases) {
			const screen = [session, WEEK_LINE].join("\n");
			expect(parseClaudeUsage(screen, NOW)).toBeNull();
		}
	});

	test("rejects ambiguous fall-back reset times", () => {
		const screen = [
			"Current session: 37% used · resets Nov 1 at 1:30am (America/New_York)",
			"Current week (all models): 64% used · resets Nov 2 at 5:00pm (America/New_York)",
		].join("\n");

		expect(
			parseClaudeUsage(screen, Date.UTC(2026, 9, 31, 12, 0, 0)),
		).toBeNull();
	});

	test("rejects nonexistent spring-forward reset times", () => {
		const screen = [
			"Current session: 37% used · resets Mar 8 at 2:30am (America/New_York)",
			"Current week (all models): 64% used · resets Mar 9 at 5:00pm (America/New_York)",
		].join("\n");

		expect(parseClaudeUsage(screen, Date.UTC(2026, 2, 7, 12, 0, 0))).toBeNull();
	});

	test("resolves unambiguous times around a DST transition", () => {
		const screen = [
			"Current session: 37% used · resets Mar 8 at 3:30am (America/New_York)",
			"Current week (all models): 64% used · resets Mar 9 at 5:00pm (America/New_York)",
		].join("\n");

		expect(parseClaudeUsage(screen, Date.UTC(2026, 2, 7, 12, 0, 0))).toEqual({
			session: { usedPercent: 37, resetsAt: Date.UTC(2026, 2, 8, 7, 30, 0) },
			week: { usedPercent: 64, resetsAt: Date.UTC(2026, 2, 9, 21, 0, 0) },
		});
	});

	test("rolls the year forward only when the reset is near New Year", () => {
		const screen = [
			"Current session: 37% used · resets Jan 1 at 12:30am (UTC)",
			"Current week (all models): 64% used · resets Jan 2 at 11pm (UTC)",
		].join("\n");

		expect(parseClaudeUsage(screen, Date.UTC(2026, 11, 31, 12, 0, 0))).toEqual({
			session: { usedPercent: 37, resetsAt: Date.UTC(2027, 0, 1, 0, 30, 0) },
			week: { usedPercent: 64, resetsAt: Date.UTC(2027, 0, 2, 23, 0, 0) },
		});
	});

	test("accepts and validates a year-qualified reset", () => {
		const screen = [
			"Current session: 37% used · resets Jan 2, 2027 at 5pm (UTC)",
			"Current week (all models): 64% used · resets Jan 3, 2027 at 9:30am (UTC)",
		].join("\n");

		expect(parseClaudeUsage(screen, Date.UTC(2026, 11, 31, 12, 0, 0))).toEqual({
			session: { usedPercent: 37, resetsAt: Date.UTC(2027, 0, 2, 17, 0, 0) },
			week: { usedPercent: 64, resetsAt: Date.UTC(2027, 0, 3, 9, 30, 0) },
		});
	});

	test("rejects invalid year-qualified resets without inferring another year", () => {
		const cases = [
			{
				session: "Current session: 37% used · resets Jan 2, 2027 at 5pm (UTC)",
				week: "Current week (all models): 64% used · resets Jan 3, 2027 at 9:30am (UTC)",
				now: Date.UTC(2026, 0, 1, 12, 0, 0),
			},
			{
				session: "Current session: 37% used · resets Jan 2, 2025 at 5pm (UTC)",
				week: "Current week (all models): 64% used · resets Jan 2, 2026 at 9:30am (UTC)",
				now: Date.UTC(2026, 0, 1, 12, 0, 0),
			},
			{
				session:
					"Current session: 37% used · resets Nov 1, 2026 at 1:30am (America/New_York)",
				week: "Current week (all models): 64% used · resets Nov 2, 2026 at 5:00pm (America/New_York)",
				now: Date.UTC(2026, 9, 31, 12, 0, 0),
			},
			{
				session:
					"Current session: 37% used · resets Mar 8, 2026 at 2:30am (America/New_York)",
				week: "Current week (all models): 64% used · resets Mar 9, 2026 at 5:00pm (America/New_York)",
				now: Date.UTC(2026, 2, 7, 12, 0, 0),
			},
			{
				session: "Current session: 37% used · resets Feb 30, 2027 at 5pm (UTC)",
				week: "Current week (all models): 64% used · resets Jan 3, 2027 at 9:30am (UTC)",
				now: Date.UTC(2026, 11, 31, 12, 0, 0),
			},
		];

		for (const { session, week, now } of cases) {
			expect(parseClaudeUsage([session, week].join("\n"), now)).toBeNull();
		}
	});

	test("rejects unverified separator variants", () => {
		const screen = [SESSION_LINE.replace(" · ", " | "), WEEK_LINE].join("\n");

		expect(parseClaudeUsage(screen, NOW)).toBeNull();
	});

	test("rejects unsafe now values without throwing", () => {
		const unsafe = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_SAFE_INTEGER,
			Number.MIN_SAFE_INTEGER,
			8.64e15 + 1,
			1.5,
		];

		for (const now of unsafe) {
			expect(parseClaudeUsage(SANITIZED_RESULT, now)).toBeNull();
		}

		// Both extremes of the Date range are finite but cannot contain a reset
		// near the sanitized fixture; neither may throw.
		expect(parseClaudeUsage(SANITIZED_RESULT, 8.64e15)).toBeNull();
		expect(parseClaudeUsage(SANITIZED_RESULT, -8.64e15)).toBeNull();
	});

	test("rejects past resets and resets more than eight days ahead", () => {
		const past = [
			"Current session: 37% used · resets Jun 14 at 4:00pm (America/Chicago)",
			WEEK_LINE,
		].join("\n");
		expect(parseClaudeUsage(past, NOW)).toBeNull();

		const farFuture = [
			"Current session: 37% used · resets Jun 24 at 4:00pm (America/Chicago)",
			WEEK_LINE,
		].join("\n");
		expect(parseClaudeUsage(farFuture, NOW)).toBeNull();
	});

	test("normalizes control sequences and carriage-return repaints", () => {
		const screen = [
			"\u001b]0;usage\u0007\u001b[1mCurrent session: 99% used · resets Jun 15 at 6:07pm (America/Chicago)\rCurrent session: 37% used · resets Jun 15 at 6:07pm (America/Chicago)\u001b[0m\u001b[K",
			`\u001b[32m${WEEK_LINE.replace("64%", "99%")}\u001b[0m\r${WEEK_LINE}\u001b[K`,
		].join("\r\n");

		expect(parseClaudeUsage(screen, NOW)).toEqual(EXPECTED_USAGE);
	});

	test("rejects conflicting repeated lines", () => {
		const screen = [
			SESSION_LINE,
			"Current session: 12% used · resets Jun 15 at 6:07pm (America/Chicago)",
			WEEK_LINE,
		].join("\n");

		expect(parseClaudeUsage(screen, NOW)).toBeNull();
	});
});

type FakeSpawnOptions = {
	stdout?: string;
	exitCode?: number;
	autoExit?: boolean;
	neverExit?: boolean;
	neverCloseOnKill?: boolean;
	neverSettle?: boolean;
	pid?: number;
	chunkSize?: number;
};

function fakeSpawn(options: FakeSpawnOptions = {}) {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(options.stdout ?? "");
	const chunks: Uint8Array[] = [];
	const chunkSize = options.chunkSize ?? 7;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		chunks.push(bytes.slice(offset, offset + chunkSize));
	}

	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const killCalls: (NodeJS.Signals | number | undefined)[] = [];
	const cancelCalls: number[] = [];
	const commands: string[][] = [];
	const spawnOptions: unknown[] = [];
	const neverExit = options.neverExit === true || options.neverSettle === true;
	const neverCloseOnKill =
		options.neverCloseOnKill === true || options.neverSettle === true;
	const autoExit = options.neverSettle === true ? false : options.autoExit;
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});

	const stream = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			for (const chunk of chunks) {
				streamController.enqueue(chunk);
			}
			if (autoExit !== false) {
				closed = true;
				streamController.close();
				resolveExit(options.exitCode ?? 0);
			}
		},
		cancel() {
			closed = true;
			cancelCalls.push(1);
		},
	});

	const spawn = (command: readonly string[], spawnInit: unknown) => {
		commands.push([...command]);
		spawnOptions.push(spawnInit);
		resolveStarted();
		return {
			pid: options.pid,
			stdout: stream,
			exited,
			kill(signal?: NodeJS.Signals | number) {
				killCalls.push(signal);
				if (!neverCloseOnKill && !closed) {
					closed = true;
					try {
						controller?.close();
					} catch {
						// A stream already cancelled by the collector needs no cleanup.
					}
				}
				if (!neverExit) {
					resolveExit(143);
				}
			},
		};
	};

	return {
		spawn,
		started,
		commands,
		spawnOptions,
		killCalls,
		cancelCalls,
	};
}

type CollectOptions = NonNullable<Parameters<typeof collectClaudeUsage>[1]>;

function collectForTest(
	signal: AbortSignal,
	options: CollectOptions = {},
): ReturnType<typeof collectClaudeUsage> {
	return collectClaudeUsage(signal, {
		platform: "darwin",
		homeDirectory: "/synthetic/home",
		directoryExists: () => true,
		...options,
	});
}

describe("collectClaudeUsage", () => {
	test("spawns the explicit non-interactive usage command", async () => {
		const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
		});

		expect(usage).toEqual(EXPECTED_USAGE);
		expect(fake.commands).toEqual([[...CLAUDE_USAGE_COMMAND]]);
		expect(fake.spawnOptions).toEqual([
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				detached: true,
				cwd: "/synthetic/home",
			},
		]);
	});

	test("returns null when the executable is missing", async () => {
		const usage = await collectForTest(new AbortController().signal, {
			spawn: () => {
				throw new Error("ENOENT");
			},
			now: () => NOW,
		});

		expect(usage).toBeNull();
	});

	test("returns null for login prompts, error results, and malformed output", async () => {
		const outputs = [
			JSON.stringify({
				type: "result",
				subtype: "error",
				is_error: true,
				local_command: "usage",
				result: "Please log in to continue.",
			}),
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: SANITIZED_RESULT,
			}),
			"not json",
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				local_command: "usage",
				result: "Current session: 37% used",
			}),
		];

		for (const stdout of outputs) {
			const fake = fakeSpawn({ stdout });
			const usage = await collectForTest(new AbortController().signal, {
				spawn: fake.spawn,
				now: () => NOW,
			});
			expect(usage).toBeNull();
		}
	});

	test("returns null on a non-zero exit status", async () => {
		const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON, exitCode: 1 });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
		});

		expect(usage).toBeNull();
	});

	test("enforces a timeout and terminates the process", async () => {
		const fake = fakeSpawn({ autoExit: false });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
	});

	test("returns null without spawning when already cancelled", async () => {
		const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });
		const controller = new AbortController();
		controller.abort();

		const usage = await collectForTest(controller.signal, {
			spawn: fake.spawn,
			now: () => NOW,
		});

		expect(usage).toBeNull();
		expect(fake.commands).toHaveLength(0);
	});

	test("cancels a running process", async () => {
		const fake = fakeSpawn({ autoExit: false });
		const controller = new AbortController();

		const pending = collectForTest(controller.signal, {
			spawn: fake.spawn,
			now: () => NOW,
		});
		await fake.started;
		controller.abort();

		expect(await pending).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
	});

	test("bounds output and terminates an oversized process", async () => {
		const fake = fakeSpawn({ stdout: "x".repeat(2048) });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			maxOutputBytes: 1024,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
	});

	test("returns null before spawning for an unsafe injected clock", async () => {
		for (const now of [Number.NaN, Number.MAX_SAFE_INTEGER, 1.5]) {
			const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });

			const usage = await collectForTest(new AbortController().signal, {
				spawn: fake.spawn,
				now: () => now,
			});

			expect(usage).toBeNull();
			expect(fake.commands).toHaveLength(0);
		}
	});

	test("returns boundedly when neither exit nor stdout settles", async () => {
		const fake = fakeSpawn({ neverSettle: true });
		const started = Date.now();

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
			cleanupGraceMs: 20,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
		expect(fake.cancelCalls.length).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("returns boundedly when only the exit promise never settles", async () => {
		const fake = fakeSpawn({ autoExit: false, neverExit: true });
		const started = Date.now();

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
			cleanupGraceMs: 20,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("returns boundedly when only stdout never settles", async () => {
		const fake = fakeSpawn({ autoExit: false, neverCloseOnKill: true });
		const started = Date.now();

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
			cleanupGraceMs: 20,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
		expect(fake.cancelCalls.length).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("returns boundedly when an aborted child cannot be reaped", async () => {
		const fake = fakeSpawn({ neverSettle: true });
		const controller = new AbortController();
		const pending = collectForTest(controller.signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 5_000,
			cleanupGraceMs: 20,
		});
		await fake.started;
		const started = Date.now();
		controller.abort();

		expect(await pending).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("fails closed when no safe neutral working directory is available", async () => {
		const cases = [
			{ homeDirectory: "" },
			{ homeDirectory: "   " },
			{ homeDirectory: "relative/home" },
			{ homeDirectory: "/synthetic/home", directoryExists: () => false },
			{
				homeDirectory: "/synthetic/home",
				directoryExists: () => {
					throw new Error("stat failed");
				},
			},
		];

		for (const cwdOptions of cases) {
			const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });

			const usage = await collectForTest(new AbortController().signal, {
				...cwdOptions,
				spawn: fake.spawn,
				now: () => NOW,
			});

			expect(usage).toBeNull();
			expect(fake.commands).toHaveLength(0);
		}
	});

	test("does not group-kill after a successful parent exit", async () => {
		const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON, pid: 4242 });
		const groupKills: number[] = [];

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			killProcess: (pid) => {
				groupKills.push(pid);
			},
		});

		expect(usage).toEqual(EXPECTED_USAGE);
		expect(groupKills).toEqual([]);
		expect(fake.killCalls).toEqual([]);
	});

	test("fails closed on platforms without POSIX process groups", async () => {
		const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			platform: "win32",
		});

		expect(usage).toBeNull();
		expect(fake.commands).toHaveLength(0);
	});

	test("terminates the detached process group and the direct child", async () => {
		const fake = fakeSpawn({ autoExit: false, pid: 4242 });
		const groupKills: { pid: number; signal: NodeJS.Signals | number }[] = [];

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
			cleanupGraceMs: 20,
			killProcess: (pid, signal) => {
				groupKills.push({ pid, signal });
			},
		});

		expect(usage).toBeNull();
		expect(groupKills).toEqual([{ pid: -4242, signal: "SIGKILL" }]);
		expect(fake.killCalls).toEqual(["SIGKILL"]);
	});

	test("never signals its own process group or invalid PIDs", async () => {
		for (const pid of [process.pid, process.ppid, 0, 1, undefined, 1.5]) {
			const fake = fakeSpawn({ autoExit: false, pid });
			const groupKills: number[] = [];

			const usage = await collectForTest(new AbortController().signal, {
				spawn: fake.spawn,
				now: () => NOW,
				timeoutMs: 10,
				cleanupGraceMs: 10,
				killProcess: (target) => {
					groupKills.push(target);
				},
			});

			expect(usage).toBeNull();
			expect(groupKills).toEqual([]);
			expect(fake.killCalls.length).toBeGreaterThan(0);
		}
	});

	test("falls back to the direct child when group termination fails", async () => {
		const fake = fakeSpawn({ autoExit: false, pid: 4242 });

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			timeoutMs: 25,
			cleanupGraceMs: 20,
			killProcess: () => {
				throw new Error("ESRCH");
			},
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
	});

	test("attempts group termination when the stdout boundary is malformed", async () => {
		const groupKills: number[] = [];
		const directKills: (NodeJS.Signals | number | undefined)[] = [];

		const usage = await collectForTest(new AbortController().signal, {
			spawn: () => ({
				pid: 4242,
				stdout: {
					getReader() {
						throw new Error("malformed stdout");
					},
				} as unknown as ReadableStream<Uint8Array>,
				exited: new Promise<number>(() => {}),
				kill: (signal?: NodeJS.Signals | number) => {
					directKills.push(signal);
				},
			}),
			now: () => NOW,
			killProcess: (pid) => {
				groupKills.push(pid);
			},
			timeoutMs: 100,
			cleanupGraceMs: 10,
		});

		expect(usage).toBeNull();
		expect(groupKills).toEqual([-4242]);
		expect(directKills).toEqual(["SIGKILL"]);
	});

	test("ignores invalid maxOutputBytes options instead of lifting the bound", async () => {
		const invalid = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5];

		for (const maxOutputBytes of invalid) {
			const fake = fakeSpawn({ stdout: SANITIZED_USAGE_JSON });

			const usage = await collectForTest(new AbortController().signal, {
				spawn: fake.spawn,
				now: () => NOW,
				maxOutputBytes,
			});

			expect(usage).toEqual(EXPECTED_USAGE);
		}
	});

	test("caps oversized maxOutputBytes options at the documented limit", async () => {
		const fake = fakeSpawn({
			stdout: "x".repeat(CLAUDE_USAGE_MAX_OUTPUT_BYTES + 1),
			chunkSize: 65_536,
		});

		const usage = await collectForTest(new AbortController().signal, {
			spawn: fake.spawn,
			now: () => NOW,
			maxOutputBytes: Number.MAX_SAFE_INTEGER,
			timeoutMs: 5_000,
		});

		expect(usage).toBeNull();
		expect(fake.killCalls.length).toBeGreaterThan(0);
	});

	test("defaults to the documented bounds and command", () => {
		expect(CLAUDE_USAGE_TIMEOUT_MS).toBe(30_000);
		expect(CLAUDE_USAGE_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
		expect(CLAUDE_USAGE_CLEANUP_GRACE_MS).toBe(250);
		expect([...CLAUDE_USAGE_COMMAND]).toEqual([
			"claude",
			"-p",
			"/usage",
			"--output-format",
			"json",
			"--no-session-persistence",
			"--strict-mcp-config",
			"--tools",
			"",
		]);
	});
});

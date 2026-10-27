import { strict as assert } from "node:assert";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import {
	CLAUDE_USAGE_COUNTDOWN_REFRESH_MS,
	type QuotaKeymapLayer,
	type QuotaTuiContext,
	QuotaUsagePage,
} from "../../src/tui";

const SUCCESS_MARKER = "claude-usage-page-live: PASS";

let now = 1_800_000_000_000;
const originalNow = Date.now;
const originalSet = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
const timers = new Map<
	ReturnType<typeof setTimeout>,
	{ at: number; callback(): void }
>();
Date.now = () => now;
globalThis.setTimeout = ((
	callback: () => void,
	delay = 0,
	...args: unknown[]
) => {
	if (delay < 1_000) return originalSet(callback, delay, ...args);
	const handle = {} as ReturnType<typeof setTimeout>;
	timers.set(handle, { at: now + delay, callback });
	return handle;
}) as typeof setTimeout;
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
	if (!timers.delete(handle)) originalClear(handle);
}) as typeof clearTimeout;

const advanceClock = async (ms: number) => {
	now += ms;
	for (const [handle, timer] of [...timers]) {
		if (timer.at <= now && timers.delete(handle)) timer.callback();
	}
	await new Promise((resolve) => originalSet(resolve, 5));
};

type ClaudeCall = {
	signal: AbortSignal;
	resolve(usage: ClaudeUsage | null): void;
};

const claudeCalls: ClaudeCall[] = [];
let listCalls = 0;

const usage = (usedPercent: number): ClaudeUsage => ({
	session: { usedPercent, resetsAt: now + 61_000 },
	week: {
		usedPercent: usedPercent + 10,
		resetsAt: now + 2 * 86_400_000 + 3 * 3_600_000,
	},
});
const STALE_USAGE = usage(12);
const FRESH_USAGE = usage(37);

const color = RGBA.fromHex("#ffffff");
const layers: QuotaKeymapLayer[] = [];
const context = {
	theme: {
		text: {
			base: color,
			muted: color,
			faint: color,
			action: { primary: { base: color } },
			feedback: {
				error: { base: color },
				warning: { base: color },
				success: { base: color },
			},
		},
	},
	keymap: {
		layer(factory: () => QuotaKeymapLayer) {
			layers.push(factory());
		},
	},
	ui: { router: { navigate: () => {} } },
	client: {
		rpc: () => ({
			events: { on: () => () => {} },
			list: async () => {
				listCalls += 1;
				return { version: 2, providers: [] };
			},
			get: async () => undefined,
			refresh: async () => undefined,
			claudeCodeUsage: async (
				_input: unknown,
				options?: { signal?: AbortSignal },
			) => {
				const signal = options?.signal;
				assert.ok(signal, "Claude RPC receives the page transport signal");
				return new Promise<ClaudeUsage | null>((resolve) => {
					claudeCalls.push({ signal, resolve });
				});
			},
		}),
	},
} as unknown as QuotaTuiContext;

const squashed = (frame: string): string => frame.replace(/\s+/gu, "");

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
try {
	setup = await testRender(
		() =>
			jsx(PluginContextProvider as never, {
				value: context,
				get children() {
					return jsx(QuotaUsagePage, { context, back: () => {} });
				},
			}),
		{ width: 100, height: 40 },
	);
	const frame = async (): Promise<string> => {
		for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
		await setup?.renderOnce();
		return setup?.captureCharFrame() ?? "";
	};

	// Mount: a request starts immediately even though the provider inventory is
	// empty, and the card stays hidden while collection is pending.
	let painted = await frame();
	assert.equal(claudeCalls.length, 1, "mount starts one Claude request");
	assert.equal(listCalls, 1, "empty inventory is loaded once");
	assert.ok(painted.includes("No connected providers."));
	assert.equal(claudeCalls[0]?.signal.aborted, false);
	assert.ok(!painted.includes("Claude Code"));
	console.log("claude-usage-page-live: mount+empty-inventory");

	// Ctrl+R refreshes Claude even while its card is hidden, aborting the
	// in-flight transport request.
	const refresh = layers
		.flatMap((layer) => layer.commands ?? [])
		.find((command) => command.id === "provider-quota.page.refresh");
	assert.ok(refresh, "page registers its refresh command");
	assert.equal(refresh.bind, "ctrl+r");
	await refresh.run?.();
	assert.equal(claudeCalls.length, 2, "ctrl+r starts another request");
	assert.equal(claudeCalls[0]?.signal.aborted, true);

	// A superseded result cannot paint, while the newest result renders even
	// with zero connected providers.
	claudeCalls[0]?.resolve(STALE_USAGE);
	painted = await frame();
	assert.ok(!painted.includes("Claude Code"), "stale result is ignored");
	assert.ok(painted.includes("No connected providers."));
	claudeCalls[1]?.resolve(FRESH_USAGE);
	painted = await frame();
	const card = squashed(painted);
	assert.ok(card.includes("ClaudeCode"));
	assert.ok(card.includes("5h·Session"));
	assert.ok(card.includes("7d·Week"));
	assert.ok(card.includes("37%"));
	assert.ok(card.includes("47%"));
	assert.ok(card.includes("resets2m"));
	assert.ok(!painted.includes("No connected providers."));
	console.log("claude-usage-page-live: ctrl+r-hidden+stale-abort");

	// With no provider deadlines, the countdown still repaints on its bounded
	// display cadence and never collects again.
	const countdown = [...timers.values()].filter(
		(timer) => timer.at === now + CLAUDE_USAGE_COUNTDOWN_REFRESH_MS,
	);
	assert.equal(countdown.length, 1, "countdown timer is scheduled");
	const callsBeforeTick = claudeCalls.length;
	await advanceClock(CLAUDE_USAGE_COUNTDOWN_REFRESH_MS);
	painted = await frame();
	assert.ok(squashed(painted).includes("resets31s"));
	assert.ok(
		[...timers.values()].some((timer) => timer.at === now + 1_000),
		"sub-minute countdown schedules second ticks",
	);
	assert.equal(claudeCalls.length, callsBeforeTick, "tick never collects");
	console.log("claude-usage-page-live: countdown+no-collect");

	// A refresh hides the value; unmount aborts the live transport request and
	// clears every display timer.
	await refresh.run?.();
	assert.equal(claudeCalls.length, 3);
	assert.equal(claudeCalls[1]?.signal.aborted, true);
	assert.ok(!(await frame()).includes("Claude Code"));
	assert.equal(timers.size, 0, "hiding the card clears the countdown timer");
	await setup.dispose();
	setup = undefined;
	assert.equal(claudeCalls[2]?.signal.aborted, true);
	assert.equal(timers.size, 0, "unmount clears display timers");
	claudeCalls[2]?.resolve(STALE_USAGE);
	await Promise.resolve();
	console.log("claude-usage-page-live: unmount-abort+cleanup");
	console.log(SUCCESS_MARKER);
} finally {
	await setup?.dispose();
	Date.now = originalNow;
	globalThis.setTimeout = originalSet;
	globalThis.clearTimeout = originalClear;
}

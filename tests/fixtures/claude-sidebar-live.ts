import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createSignal } from "solid-js";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type { QuotaGetResult } from "../../src/rpc";
import { type QuotaTuiContext, setupQuotaTui } from "../../src/tui";

const SUCCESS_MARKER = "claude-sidebar-live: PASS";

type Selected = { providerID: string; modelID: string };

type CapturedSlot = {
	append?: string;
	render: () => unknown;
};

type ClaudeCall = {
	signal: AbortSignal;
	resolve(usage: ClaudeUsage | null): void;
};

function SlotHost(props: { render: () => unknown }) {
	return jsx("box", {
		flexDirection: "column",
		get children() {
			return props.render();
		},
	});
}

function resetLine(frame: string): string {
	return frame.split("\n").find((line) => line.includes("resets")) ?? "";
}

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function callAt(calls: ClaudeCall[], index: number): ClaudeCall {
	const call = calls[index];
	assert.ok(call, `claudeCodeUsage call ${index} was not made`);
	return call;
}

const theme = {
	text: {
		base: RGBA.fromHex("#ffffff"),
		muted: RGBA.fromHex("#aaaaaa"),
		faint: RGBA.fromHex("#666666"),
		action: { primary: { base: RGBA.fromHex("#c3a6ef") } },
		feedback: {
			success: { base: RGBA.fromHex("#a7d5b2") },
			warning: { base: RGBA.fromHex("#ebc588") },
			error: { base: RGBA.fromHex("#ff3355") },
		},
	},
};

type Setup = Awaited<ReturnType<typeof testRender>>;

type PendingClaude = ClaudeCall & { reject(error: Error): void };

type SidebarHarness = {
	keyInput: EventEmitter;
	renderer: EventEmitter;
	stepEvents: Map<string, (event: unknown) => void>;
	claudeCalls: PendingClaude[];
	quotaCalls: { method: "get" | "refresh"; providerID: string }[];
	slots: CapturedSlot[];
	setSelected(next: Selected): void;
	failClaudeWith(error: Error | undefined): void;
	dispose(): void;
};

const CLAUDE_SELECTION: Selected = {
	providerID: "claude-agent",
	modelID: "claude-sonnet",
};
const BETA_SELECTION: Selected = { providerID: "beta", modelID: "model-b" };

const settle = () =>
	new Promise<void>((resolve) => setTimeout(() => resolve(), 5));

function paintedLines(frame: string): string[] {
	return frame
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function sidebarUsage(sessionUsed: number, weekUsed: number): ClaudeUsage {
	const now = Date.now();
	return {
		session: { usedPercent: sessionUsed, resetsAt: now + 3_600_000 },
		week: { usedPercent: weekUsed, resetsAt: now + 2 * 86_400_000 },
	};
}

function betaView(now: number): QuotaGetResult {
	return {
		version: 2,
		provider: {
			providerID: "beta",
			name: "Beta provider",
			authMethod: "oauth",
			support: "supported",
			evidence: "live-validated",
		},
		quota: {
			state: "available",
			authSource: "codex-companion",
			sections: [
				{
					scope: "app",
					result: {
						state: "available",
						metrics: [
							{
								kind: "window",
								id: "app-week",
								scope: "app",
								label: "Current app limit",
								windowSeconds: 604_800,
								remainingPercent: 33,
								usedPercent: 67,
								resetsAt: now + 3_600_000,
							},
						],
						fetchedAt: now,
						expiresAt: now + 3_600_000,
					},
				},
			],
		},
	};
}

function stepEvent(providerID: string, id: string) {
	return {
		data: {
			sessionID: "s",
			assistantMessageID: id,
			model: { providerID },
		},
	};
}

/**
 * Independent sidebar mount for the extended phases. Each phase gets its own
 * context and counters, so the primary phases' disposal assertions stay exact.
 */
function openSidebar(initial: Selected): SidebarHarness {
	const keyInput = new EventEmitter();
	const renderer = new EventEmitter();
	const stepEvents = new Map<string, (event: unknown) => void>();
	const [route] = createSignal<{ type: "home" }>({ type: "home" });
	const [selected, setSelected] = createSignal<Selected>(initial);
	const claudeCalls: PendingClaude[] = [];
	const quotaCalls: { method: "get" | "refresh"; providerID: string }[] = [];
	const slots: CapturedSlot[] = [];
	let claudeFailure: Error | undefined;
	const context = {
		renderer: Object.assign(renderer, { keyInput }),
		location: { directory: "/tmp/provider-usage-claude-sidebar-phases" },
		client: {
			rpc: () => ({
				events: {
					on: () => () => {},
				},
				list: async () => ({ version: 2, providers: [] }),
				get: async (input: { providerID: string }) => {
					quotaCalls.push({ method: "get", providerID: input.providerID });
					if (input.providerID !== "beta") {
						throw new Error("no synthetic generic quota");
					}
					return betaView(Date.now());
				},
				refresh: async (input: { providerID: string }) => {
					quotaCalls.push({ method: "refresh", providerID: input.providerID });
					if (input.providerID !== "beta") {
						throw new Error("no synthetic generic quota");
					}
					return betaView(Date.now());
				},
				claudeCodeUsage: (
					_input: unknown,
					options?: { signal?: AbortSignal },
				) => {
					const signal = options?.signal;
					assert.ok(signal, "Claude RPC receives the sidebar transport signal");
					return new Promise<ClaudeUsage | null>((resolve, reject) => {
						claudeCalls.push({ signal, resolve, reject });
						if (claudeFailure !== undefined) reject(claudeFailure);
					});
				},
			}),
		},
		data: {
			on: (name: string, handler: (event: unknown) => void) => {
				stepEvents.set(name, handler);
				return () => {
					stepEvents.delete(name);
				};
			},
			location: {
				provider: {
					list: () => [
						{ id: "claude-agent", name: "Claude Code" },
						{ id: "beta", name: "Beta provider" },
					],
				},
			},
		},
		theme,
		keymap: {
			layer(factory: () => unknown) {
				factory();
			},
			commands: () => [],
		},
		ui: {
			model: { current: () => selected() },
			toast: { show: () => {} },
			router: {
				register: () => () => {},
				navigate: () => {},
				current: route,
			},
			slot(input: CapturedSlot) {
				slots.push(input);
				return () => {};
			},
		},
	};
	const dispose = setupQuotaTui(context as unknown as QuotaTuiContext);
	return {
		keyInput,
		renderer,
		stepEvents,
		claudeCalls,
		quotaCalls,
		slots,
		setSelected: (next) => setSelected(next),
		failClaudeWith: (error) => {
			claudeFailure = error;
		},
		dispose,
	};
}

async function mountSidebar(harness: SidebarHarness): Promise<Setup> {
	assert.equal(harness.slots.length, 1);
	assert.equal(harness.slots[0]?.append, "sidebar.footer");
	return testRender(
		() =>
			jsx(SlotHost as never, {
				render: () => harness.slots[0]?.render(),
			}),
		{ width: 60, height: 30 },
	);
}

/**
 * Polls until the predicate holds. Every sampled frame must avoid the
 * `forbidden` text, so transient copy is caught as well as the final frame.
 */
async function frameWhen(
	setup: Setup,
	predicate: (frame: string) => boolean,
	forbidden: string[] = [],
): Promise<string> {
	let frame = "";
	for (let attempt = 0; attempt < 100; attempt += 1) {
		await setup.renderOnce();
		await settle();
		frame = setup.captureCharFrame();
		for (const text of forbidden) {
			assert.ok(
				!frame.includes(text),
				`frame must not contain ${JSON.stringify(text)}:\n${frame}`,
			);
		}
		if (predicate(frame)) {
			return frame;
		}
	}
	throw new Error(`sidebar frame did not converge:\n${frame}`);
}

const betaReady = (frame: string) =>
	frame.includes("Beta provider") && frame.includes("%");

async function extendedSidebarPhases(
	advanceClock: (ms: number) => Promise<void>,
): Promise<void> {
	// f. A non-claude provider never touches the Claude path, whatever the
	// selection, keypress, focus, or step signal.
	{
		const harness = openSidebar(BETA_SELECTION);
		const setup = await mountSidebar(harness);
		try {
			await frameWhen(setup, betaReady, ["Claude Code"]);
			assert.equal(harness.claudeCalls.length, 0);
			harness.setSelected({ providerID: "beta", modelID: "model-c" });
			await frameWhen(setup, betaReady, ["Claude Code"]);
			harness.keyInput.emit("keypress");
			harness.renderer.emit("focus");
			await advanceClock(61_000);
			harness.keyInput.emit("keypress");
			harness.renderer.emit("focus");
			harness.stepEvents.get("session.step.started")?.(stepEvent("beta", "b1"));
			harness.stepEvents.get("session.step.ended")?.(stepEvent("beta", "b1"));
			await advanceClock(61_000);
			harness.stepEvents.get("session.step.started")?.(stepEvent("beta", "b2"));
			harness.stepEvents.get("session.step.ended")?.(stepEvent("beta", "b2"));
			await settle();
			const after = await frameWhen(setup, betaReady, ["Claude Code"]);
			assert.ok(after.includes("Beta provider"));
			assert.equal(harness.claudeCalls.length, 0);
			console.log("claude-sidebar-live: other-provider-unchanged");
		} finally {
			await setup.dispose();
			harness.dispose();
		}
	}

	// g. A pending claude-agent collection is aborted by switching away; its
	// late result is dropped and paints nothing.
	{
		const harness = openSidebar(CLAUDE_SELECTION);
		const setup = await mountSidebar(harness);
		try {
			await frameWhen(setup, (frame) => frame.includes("Checking quota"));
			assert.equal(harness.claudeCalls.length, 1);
			harness.setSelected(BETA_SELECTION);
			const betaFrame = await frameWhen(setup, betaReady, ["Claude Code"]);
			assert.equal(callAt(harness.claudeCalls, 0).signal.aborted, true);
			assert.equal(harness.claudeCalls.length, 1);
			const before = paintedLines(betaFrame);
			callAt(harness.claudeCalls, 0).resolve(sidebarUsage(37, 47));
			await settle();
			await setup.renderOnce();
			await settle();
			const after = setup.captureCharFrame();
			assert.deepEqual(paintedLines(after), before);
			assert.ok(!after.includes("Claude Code"));
			assert.ok(!after.includes("5h"));
			assert.equal(harness.claudeCalls.length, 1);
			console.log("claude-sidebar-live: switch-away-drops-late-result");
		} finally {
			await setup.dispose();
			harness.dispose();
		}
	}

	// h. claude-agent -> other -> claude-agent -> other. Reselecting always
	// collects once, and the other provider's card repaints unchanged.
	{
		const harness = openSidebar(CLAUDE_SELECTION);
		const setup = await mountSidebar(harness);
		try {
			await frameWhen(setup, (frame) => frame.includes("Checking quota"));
			callAt(harness.claudeCalls, 0).resolve(sidebarUsage(37, 47));
			await frameWhen(setup, (frame) => frame.includes("37%"));
			harness.setSelected(BETA_SELECTION);
			const firstBeta = paintedLines(
				await frameWhen(setup, betaReady, ["Claude Code"]),
			);
			assert.equal(harness.claudeCalls.length, 1);
			harness.setSelected(CLAUDE_SELECTION);
			const pending = await frameWhen(setup, (frame) =>
				frame.includes("Checking quota"),
			);
			assert.equal(harness.claudeCalls.length, 2);
			assert.ok(!pending.includes("37%"));
			assert.ok(!pending.includes("47%"));
			callAt(harness.claudeCalls, 1).resolve(sidebarUsage(55, 60));
			await frameWhen(setup, (frame) => frame.includes("55%"));
			harness.setSelected(BETA_SELECTION);
			const secondBeta = paintedLines(
				await frameWhen(setup, betaReady, ["Claude Code"]),
			);
			assert.deepEqual(secondBeta, firstBeta);
			assert.equal(harness.claudeCalls.length, 2);
			console.log("claude-sidebar-live: switch-round-trip");
		} finally {
			await setup.dispose();
			harness.dispose();
		}
	}

	// i. Both failure kinds render the same unavailable card as null: header,
	// one line, and no error text, digits, percentages, or window labels.
	{
		const harness = openSidebar(BETA_SELECTION);
		const setup = await mountSidebar(harness);
		try {
			await frameWhen(setup, betaReady, ["Claude Code"]);
			for (const failure of [
				new Error("rpc.method_not_found"),
				new Error("upstream returned 503 for account 42"),
			]) {
				harness.failClaudeWith(failure);
				harness.setSelected(CLAUDE_SELECTION);
				const frame = await frameWhen(
					setup,
					(current) => current.includes("Usage unavailable"),
					["Quota unavailable"],
				);
				assert.ok(frame.includes("Claude Code"));
				assert.equal(
					paintedLines(frame).filter((line) =>
						line.includes("Usage unavailable"),
					).length,
					1,
				);
				assert.ok(!frame.includes(failure.message));
				assert.ok(!/\d|%/.test(frame));
				harness.setSelected(BETA_SELECTION);
				await frameWhen(setup, betaReady, ["Claude Code"]);
			}
			assert.equal(harness.claudeCalls.length, 2);
			console.log("claude-sidebar-live: failure-kinds");
		} finally {
			await setup.dispose();
			harness.dispose();
		}
	}

	// j. Claude-agent never shows the generic quota fallback in any state.
	{
		const harness = openSidebar(CLAUDE_SELECTION);
		const setup = await mountSidebar(harness);
		const forbidden = ["Quota unavailable"];
		try {
			const loading = await frameWhen(
				setup,
				(frame) => frame.includes("Checking quota"),
				forbidden,
			);
			assert.ok(loading.includes("Claude Code"));
			callAt(harness.claudeCalls, 0).resolve(sidebarUsage(37, 47));
			const ready = await frameWhen(
				setup,
				(frame) => frame.includes("37%"),
				forbidden,
			);
			assert.ok(ready.includes("Claude Code"));
			harness.failClaudeWith(new Error("transport closed"));
			harness.setSelected(BETA_SELECTION);
			await frameWhen(setup, betaReady, ["Claude Code"]);
			harness.setSelected(CLAUDE_SELECTION);
			const failed = await frameWhen(
				setup,
				(frame) => frame.includes("Usage unavailable"),
				forbidden,
			);
			assert.ok(failed.includes("Claude Code"));
			assert.ok(
				harness.quotaCalls.every((call) => call.providerID !== "claude-agent"),
			);
			console.log("claude-sidebar-live: claude-agent-no-generic-quota-text");
		} finally {
			await setup.dispose();
			harness.dispose();
		}
	}
}

async function main(): Promise<void> {
	// Prove this process really loaded solid-js/dist/solid.js: a memo must
	// recompute when its signal changes.
	const [count, setCount] = createSignal(0);
	const doubled = createMemo(() => count() * 2);
	assert.equal(doubled(), 0);
	setCount(3);
	assert.equal(doubled(), 6);

	let clock = Date.now();
	const originalNow = Date.now;
	Date.now = () => clock;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const deadlines = new Map<
		ReturnType<typeof setTimeout>,
		{ at: number; callback(): void }
	>();
	globalThis.setTimeout = ((
		callback: () => void,
		delay = 0,
		...args: unknown[]
	) => {
		if (delay < 1_000) return originalSetTimeout(callback, delay, ...args);
		const handle = {} as ReturnType<typeof setTimeout>;
		deadlines.set(handle, { at: clock + delay, callback });
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		if (!deadlines.delete(handle)) originalClearTimeout(handle);
	}) as typeof clearTimeout;
	const advanceClock = async (ms: number) => {
		clock += ms;
		for (const [id, deadline] of [...deadlines]) {
			if (deadline.at <= clock && deadlines.delete(id)) deadline.callback();
		}
		await settle();
	};
	const settle = () => new Promise((resolve) => originalSetTimeout(resolve, 5));

	const keyInput = new EventEmitter();
	const renderer = new EventEmitter();
	const stepEvents = new Map<string, (event: unknown) => void>();
	let eventDisposals = 0;
	const [route] = createSignal<{ type: "home" }>({ type: "home" });
	const [selected, setSelected] = createSignal<Selected>({
		providerID: "claude-agent",
		modelID: "claude-sonnet",
	});
	const claudeCalls: ClaudeCall[] = [];
	// Every quota RPC get/refresh is recorded: Claude must produce none.
	const quotaCalls: { method: "get" | "refresh"; providerID: string }[] = [];
	let updated: ((payload: unknown) => void) | undefined;
	let pushDisposals = 0;
	const slots: CapturedSlot[] = [];
	const navigations: unknown[] = [];
	let slotDisposals = 0;
	const context = {
		renderer: Object.assign(renderer, { keyInput }),
		location: { directory: "/tmp/provider-usage-claude-sidebar-live" },
		client: {
			rpc: () => ({
				events: {
					on: (_name: string, handler: typeof updated) => {
						updated = handler;
						return () => {
							updated = undefined;
							pushDisposals++;
						};
					},
				},
				list: async () => {
					throw new Error("sidebar must not list providers");
				},
				get: async (input: { providerID: string }) => {
					quotaCalls.push({ method: "get", providerID: input.providerID });
					throw new Error("no synthetic generic quota");
				},
				refresh: async (input: { providerID: string }) => {
					quotaCalls.push({ method: "refresh", providerID: input.providerID });
					throw new Error("no synthetic generic quota");
				},
				claudeCodeUsage: async (
					_input: unknown,
					options?: { signal?: AbortSignal },
				) => {
					const signal = options?.signal;
					assert.ok(signal, "Claude RPC receives the sidebar transport signal");
					return new Promise<ClaudeUsage | null>((resolve) => {
						claudeCalls.push({ signal, resolve });
					});
				},
			}),
		},
		data: {
			on: (name: string, handler: (event: unknown) => void) => {
				stepEvents.set(name, handler);
				return () => {
					stepEvents.delete(name);
					eventDisposals++;
				};
			},
			location: {
				provider: {
					list: () => [{ id: "claude-agent", name: "Claude Code" }],
				},
			},
		},
		theme,
		keymap: {
			layer(factory: () => unknown) {
				factory();
			},
			commands: () => [],
		},
		ui: {
			model: { current: () => selected() },
			toast: { show: () => {} },
			router: {
				register: () => () => {},
				navigate: (destination: unknown) => {
					navigations.push(destination);
				},
				current: route,
			},
			slot(input: CapturedSlot) {
				slots.push(input);
				return () => {
					slotDisposals += 1;
				};
			},
		},
	};
	const usageAt = (
		sessionUsed: number,
		weekUsed: number,
		sessionResetsAt = clock + 3_600_000,
	): ClaudeUsage => ({
		session: { usedPercent: sessionUsed, resetsAt: sessionResetsAt },
		week: { usedPercent: weekUsed, resetsAt: clock + 2 * 86_400_000 },
	});
	const dispose = setupQuotaTui(context as unknown as QuotaTuiContext);
	let setup: Awaited<ReturnType<typeof testRender>> | undefined;
	try {
		assert.equal(slots.length, 1);
		assert.equal(slots[0]?.append, "sidebar.footer");
		setup = await testRender(
			() =>
				jsx(SlotHost as never, {
					render: () => slots[0]?.render(),
				}),
			{ width: 60, height: 30 },
		);

		const waitForFrame = async (
			predicate: (frame: string) => boolean,
		): Promise<string> => {
			let frame = "";
			for (let attempt = 0; attempt < 100; attempt += 1) {
				await setup?.renderOnce();
				await settle();
				frame = setup?.captureCharFrame() ?? "";
				if (predicate(frame)) {
					return frame;
				}
			}
			throw new Error(`sidebar frame did not converge:\n${frame}`);
		};

		// a. Selecting claude-agent renders the card and collects exactly once.
		const pending = await waitForFrame((frame) =>
			frame.includes("Checking quota"),
		);
		assert.ok(pending.includes("Claude Code"));
		assert.equal(claudeCalls.length, 1);
		assert.equal(quotaCalls.length, 0);
		callAt(claudeCalls, 0).resolve(usageAt(37, 47));
		const ready = await waitForFrame(
			(frame) => frame.includes("5h") && frame.includes("37%"),
		);
		assert.ok(ready.includes("7d"));
		assert.ok(ready.includes("47%"));
		assert.ok(!ready.includes("Checking quota"));
		assert.equal(claudeCalls.length, 1);
		assert.equal(quotaCalls.length, 0);
		console.log("claude-sidebar-live: render-once");

		// b. Keypress and focus inside the 60s floor add nothing; at or after the
		// floor, a burst of keypresses collapses into one in-flight collection.
		keyInput.emit("keypress");
		renderer.emit("focus");
		await settle();
		assert.equal(claudeCalls.length, 1);
		clock += 59_000;
		keyInput.emit("keypress");
		renderer.emit("focus");
		await settle();
		assert.equal(claudeCalls.length, 1);
		clock += 1_000;
		keyInput.emit("keypress");
		keyInput.emit("keypress");
		await settle();
		assert.equal(claudeCalls.length, 2);
		assert.equal(callAt(claudeCalls, 1).signal.aborted, false);
		const inFlight = await waitForFrame((frame) => frame.includes("37%"));
		assert.ok(inFlight.includes("7d"));
		callAt(claudeCalls, 1).resolve(usageAt(55, 60));
		await waitForFrame((frame) => frame.includes("55%"));
		assert.equal(claudeCalls.length, 2);
		assert.equal(quotaCalls.length, 0);
		console.log("claude-sidebar-live: floor-and-single-flight");

		// c. Step completion is a trigger too, so it obeys the same floor.
		const emitStep = (name: string, id: string) =>
			stepEvents.get(name)?.({
				data: {
					sessionID: "s",
					assistantMessageID: id,
					model: { providerID: "claude-agent" },
				},
			});
		emitStep("session.step.started", "early");
		await settle();
		clock += 30_000;
		emitStep("session.step.ended", "early");
		await settle();
		assert.equal(claudeCalls.length, 2);
		clock += 30_000;
		emitStep("session.step.started", "late");
		emitStep("session.step.ended", "late");
		await settle();
		assert.equal(claudeCalls.length, 3);
		assert.equal(quotaCalls.length, 0);
		console.log("claude-sidebar-live: step-floor");

		// d. The countdown repaints on the display timer and never collects.
		callAt(claudeCalls, 2).resolve(usageAt(20, 30, clock + 45_000));
		const countdown = await waitForFrame((frame) => frame.includes("20%"));
		const beforeTick = resetLine(countdown);
		assert.ok(beforeTick.includes("resets"));
		await advanceClock(1_000);
		const ticked = await waitForFrame(
			(frame) => resetLine(frame) !== beforeTick,
		);
		assert.ok(ticked.includes("20%"));
		assert.equal(claudeCalls.length, 3);
		assert.equal(quotaCalls.length, 0);
		console.log("claude-sidebar-live: countdown-tick");

		// e. A null collection renders the header and one unavailable line only.
		clock += 61_000;
		keyInput.emit("keypress");
		await settle();
		assert.equal(claudeCalls.length, 4);
		callAt(claudeCalls, 3).resolve(null);
		const unavailable = await waitForFrame((frame) =>
			frame.includes("Usage unavailable"),
		);
		assert.ok(unavailable.includes("Claude Code"));
		assert.equal(countOf(unavailable, "Usage unavailable"), 1);
		assert.ok(!/%|resets/.test(unavailable));
		assert.equal(quotaCalls.length, 0);
		console.log("claude-sidebar-live: unavailable");

		// f. Activating the card opens the usage page; no collection is started.
		clock += 61_000;
		keyInput.emit("keypress");
		await settle();
		assert.equal(claudeCalls.length, 5);
		callAt(claudeCalls, 4).resolve(usageAt(37, 47));
		await waitForFrame((frame) => frame.includes("37%"));
		const callsBeforeClick = claudeCalls.length;
		await setup.mockMouse.click(3, 1);
		await setup.renderOnce();
		assert.deepEqual(navigations, [{ type: "plugin", name: "provider-usage" }]);
		assert.equal(claudeCalls.length, callsBeforeClick);
		console.log("claude-sidebar-live: click-through");

		// Deselecting aborts an in-flight collection and starts none; reselecting
		// claude-agent always collects.
		clock += 61_000;
		keyInput.emit("keypress");
		await settle();
		assert.equal(claudeCalls.length, 6);
		setSelected({ providerID: "beta", modelID: "model-b" });
		await settle();
		assert.equal(callAt(claudeCalls, 5).signal.aborted, true);
		assert.equal(claudeCalls.length, 6);
		setSelected({ providerID: "claude-agent", modelID: "claude-sonnet" });
		await settle();
		assert.equal(claudeCalls.length, 7);
		assert.equal(callAt(claudeCalls, 6).signal.aborted, false);
		assert.ok(
			quotaCalls.every((call) => call.providerID !== "claude-agent"),
			"claude-agent never reads the generic quota RPC",
		);
		console.log("claude-sidebar-live: deselect-abort");

		await setup.dispose();
		setup = undefined;
		dispose();
		assert.equal(callAt(claudeCalls, 6).signal.aborted, true);
		assert.equal(slotDisposals, 1);
		assert.equal(eventDisposals, 3);
		assert.equal(pushDisposals, 1);
		assert.equal(keyInput.listenerCount("keypress"), 0);
		assert.equal(renderer.listenerCount("focus"), 0);
		await extendedSidebarPhases(advanceClock);
	} finally {
		await setup?.dispose();
		dispose();
		Date.now = originalNow;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
	console.log(SUCCESS_MARKER);
}

await main();

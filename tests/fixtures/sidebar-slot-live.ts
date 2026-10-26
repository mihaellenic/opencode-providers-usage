import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createSignal } from "solid-js";
import type { QuotaPresentation, QuotaRead } from "../../src/core/contracts";
import type { QuotaGetResult, QuotaUpdatedEvent } from "../../src/rpc";
import {
	type QuotaKeymapLayer,
	type QuotaTuiContext,
	setupQuotaTui,
} from "../../src/tui";
import { UNAVAILABLE_NO_CURRENT_COPY } from "../../src/ui/format";

const SUCCESS_MARKER = "sidebar-slot-live: PASS";

type Selected = { providerID: string; modelID: string; variant?: string };

type CapturedSlot = {
	append?: string;
	render: () => unknown;
};

function windowQuota(options: {
	remainingPercent: number;
	fetchedAt: number;
	expiresAt: number;
	resetsAt: number;
}): QuotaRead {
	return {
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
							remainingPercent: options.remainingPercent,
							usedPercent: 100 - options.remainingPercent,
							resetsAt: options.resetsAt,
						},
					],
					fetchedAt: options.fetchedAt,
					expiresAt: options.expiresAt,
				},
			},
		],
	};
}

function quotaView(
	providerID: string,
	name: string,
	quota: QuotaRead,
): QuotaGetResult {
	return {
		version: 2,
		provider: {
			providerID,
			name,
			authMethod: "oauth",
			support: "supported",
			evidence: "live-validated",
		},
		quota,
	};
}

function SlotHost(props: {
	render: () => unknown;
	capture: (node: unknown) => void;
}) {
	return jsx("box", {
		flexDirection: "column",
		get children() {
			const node = props.render();
			props.capture(node);
			return node;
		},
	});
}

function paintedLines(frame: string): string[] {
	return frame
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

type FixtureTheme = {
	text: {
		base: RGBA;
		muted: RGBA;
		faint: RGBA;
		action: { primary: { base: RGBA } };
		feedback: {
			success: { base: RGBA };
			warning: { base: RGBA };
			error: { base: RGBA };
		};
	};
};

const INITIAL_COLORS = {
	base: "#ffffff",
	muted: "#aaaaaa",
	success: "#a7d5b2",
	warning: "#ebc588",
	error: "#ff3355",
	action: "#c3a6ef",
} as const;

const ALTERNATE_COLORS = {
	base: "#f0f0f0",
	muted: "#778899",
	success: "#3366cc",
	warning: "#cc8833",
	error: "#cc2244",
	action: "#ff00aa",
} as const;

type ThemeColors = Record<keyof typeof INITIAL_COLORS, string>;

function fixtureTheme(colors: ThemeColors): FixtureTheme {
	return {
		text: {
			base: RGBA.fromHex(colors.base),
			muted: RGBA.fromHex(colors.muted),
			faint: RGBA.fromHex("#666666"),
			action: { primary: { base: RGBA.fromHex(colors.action) } },
			feedback: {
				success: { base: RGBA.fromHex(colors.success) },
				warning: { base: RGBA.fromHex(colors.warning) },
				error: { base: RGBA.fromHex(colors.error) },
			},
		},
	};
}

function spanFor(
	frame: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
	text: string,
) {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(text)) {
				return span;
			}
		}
	}
	throw new Error(`no painted span contains ${JSON.stringify(text)}`);
}

function renderableTypes(node: unknown): string[] {
	const types: string[] = [];
	const visit = (current: unknown): void => {
		assert.notEqual(typeof current, "function", "function-valued child");
		const candidate = current as {
			constructor?: { name?: string };
			getChildren?: () => unknown[];
		};
		types.push(candidate.constructor?.name ?? "unknown");
		if (typeof candidate.getChildren === "function") {
			for (const child of candidate.getChildren()) {
				visit(child);
			}
		}
	};
	visit(node);
	return types;
}

async function main(): Promise<void> {
	// Prove this process really loaded solid-js/dist/solid.js: a memo must
	// recompute when its signal changes.
	const [count, setCount] = createSignal(0);
	const doubled = createMemo(() => count() * 2);
	assert.equal(doubled(), 0);
	setCount(3);
	assert.equal(doubled(), 6);

	const now = Date.now();
	let clock = now;
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
		await new Promise((resolve) => originalSetTimeout(resolve, 5));
	};
	const keyInput = new EventEmitter();
	const renderer = new EventEmitter();
	const stepEvents = new Map<string, (event: unknown) => void>();
	let eventDisposals = 0;
	const [route, setRoute] = createSignal<
		{ type: "home" } | { type: "session"; sessionID: string }
	>({ type: "home" });
	const reads: Record<string, QuotaRead> = {
		alpha: windowQuota({
			remainingPercent: 90,
			fetchedAt: now - 12_000,
			expiresAt: now + 60_000,
			resetsAt: now + 3_600_000,
		}),
		beta: windowQuota({
			remainingPercent: 33,
			fetchedAt: now - 80_000,
			expiresAt: now - 1,
			resetsAt: now + 3_600_000,
		}),
	};
	let failAlpha = false;
	let firstGet = true;
	let releaseInitial: () => void = () => {};
	const initialRead = new Promise<void>((resolve) => {
		releaseInitial = resolve;
	});
	const [selected, setSelected] = createSignal<Selected>({
		providerID: "alpha",
		modelID: "model-a",
	});
	const [theme, setTheme] = createSignal<FixtureTheme>(
		fixtureTheme(INITIAL_COLORS),
	);
	const tokenMutedA = RGBA.fromHex("#8899aa");
	const tokenMutedB = RGBA.fromHex("#1122cc");
	const [tokenMuted, setTokenMuted] = createSignal(tokenMutedA);
	const calls: { method: "get" | "refresh"; providerID: string }[] = [];
	const presentations: Record<string, QuotaPresentation> = {};
	let updated: ((payload: { data: QuotaUpdatedEvent }) => void) | undefined;
	let pushDisposals = 0;
	const slots: CapturedSlot[] = [];
	const navigations: unknown[] = [];
	let slotDisposals = 0;
	let layer: QuotaKeymapLayer | undefined;
	const quotaFor = (providerID: string): QuotaGetResult => {
		if (providerID === "alpha" && failAlpha) {
			throw new Error("alpha quota down");
		}
		const quota = reads[providerID];
		if (quota === undefined) {
			throw new Error(`no synthetic quota for ${providerID}`);
		}
		return {
			...quotaView(
				providerID,
				providerID === "alpha" ? "Alpha provider" : "Beta provider",
				quota,
			),
			...(presentations[providerID] === undefined
				? {}
				: { presentation: presentations[providerID] }),
		};
	};
	const context = {
		renderer: Object.assign(renderer, { keyInput }),
		location: { directory: "/tmp/provider-usage-live-slot" },
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
				list: async () => ({ version: 2, providers: [] }),
				get: async (input: { providerID: string }) => {
					calls.push({ method: "get", providerID: input.providerID });
					if (firstGet) {
						firstGet = false;
						await initialRead;
					}
					return quotaFor(input.providerID);
				},
				refresh: async (input: { providerID: string }) => {
					calls.push({ method: "refresh", providerID: input.providerID });
					return quotaFor(input.providerID);
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
			session: {
				message: {
					get: (_session: string, id: string) =>
						id === "missed"
							? { type: "assistant", model: { providerID: "delta" } }
							: undefined,
				},
			},
			location: {
				provider: {
					list: () => [
						{ id: "alpha", name: "Alpha host title" },
						{ id: "beta", name: "Beta host title" },
					],
				},
			},
		},
		get theme() {
			return theme();
		},
		keymap: {
			layer(factory: () => QuotaKeymapLayer) {
				layer = factory();
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
	const dispose = setupQuotaTui(context as unknown as QuotaTuiContext);
	const nodes: unknown[] = [];
	let setup: Awaited<ReturnType<typeof testRender>> | undefined;
	try {
		assert.equal(slots.length, 1);
		assert.equal(slots[0]?.append, "sidebar.footer");
		assert.ok(layer);
		setup = await testRender(
			() =>
				jsx(SlotHost as never, {
					render: () => slots[0]?.render(),
					capture: (node: unknown) => {
						nodes.push(node);
					},
				}),
			{ width: 60, height: 30 },
		);

		const waitForFrame = async (
			predicate: (frame: string) => boolean,
		): Promise<string> => {
			let frame = "";
			for (let attempt = 0; attempt < 100; attempt += 1) {
				await setup?.renderOnce();
				await new Promise((resolve) => setTimeout(resolve, 5));
				frame = setup?.captureCharFrame() ?? "";
				if (predicate(frame)) {
					return frame;
				}
			}
			throw new Error(`sidebar frame did not converge:\n${frame}`);
		};

		const waitForSpanColor = async (
			text: string,
			color: RGBA,
		): Promise<void> => {
			for (let attempt = 0; attempt < 100; attempt += 1) {
				await setup?.renderOnce();
				await new Promise((resolve) => setTimeout(resolve, 5));
				const frame = setup?.captureSpans();
				if (frame === undefined) {
					continue;
				}
				const span = spanFor(frame, text);
				if (span.fg.equals(color)) {
					return;
				}
			}
			throw new Error(`span did not repaint to ${color.toString()}`);
		};

		// A completion during the pending initial get must not be absorbed by
		// joining that older read. It gets one trailing refresh after settlement.
		clock += 1_000;
		const initialEvent = {
			data: {
				sessionID: "s",
				assistantMessageID: "initial",
				model: { providerID: "alpha" },
			},
		};
		stepEvents.get("session.step.started")?.(initialEvent);
		stepEvents.get("session.step.ended")?.(initialEvent);
		await new Promise((resolve) => originalSetTimeout(resolve, 5));
		assert.equal(calls.filter((call) => call.method === "refresh").length, 0);
		clock += 4_000;
		releaseInitial();
		const fresh = await waitForFrame(
			(frame) => frame.includes("10%") && frame.includes("Alpha host title"),
		);
		const freshLines = paintedLines(fresh);
		assert.equal(freshLines[0], " Alpha host title");
		assert.ok(freshLines.some((line) => line.includes("7d")));
		assert.ok(fresh.includes("━"));
		assert.ok(fresh.includes("resets 1h"));
		assert.ok(!fresh.includes("updated"));
		assert.ok(!fresh.includes("12s ago"));
		assert.ok(!fresh.includes("View all providers"));
		assert.ok(!fresh.includes("requires companion"));
		assert.ok(!fresh.includes("live-validated"));
		assert.ok(!fresh.includes("2026-"));
		await advanceClock(9_999);
		assert.equal(calls.filter((call) => call.method === "refresh").length, 0);
		await advanceClock(1);
		assert.equal(calls.filter((call) => call.method === "refresh").length, 1);

		// The live contribution is a static nested Box/Text tree, not one joined
		// text blob and never a function-valued child.
		const types = renderableTypes(nodes.at(-1));
		console.log("sidebar-slot-live: static-tree");
		assert.ok(types.some((type) => type.includes("BoxRenderable")));
		assert.ok(types.some((type) => type.includes("TextRenderable")));
		assert.ok(
			types.every(
				(type) =>
					type.includes("BoxRenderable") || type.includes("TextRenderable"),
			),
		);

		// Theme changes repaint the already-mounted contribution: first a whole
		// theme-object replacement, then a token-level update on a reactive token.
		const callsBeforeTheme = calls.length;
		const initialTheme = theme();
		const initialSpans = setup.captureSpans();
		assert.ok(spanFor(initialSpans, "10%").fg.equals(initialTheme.text.muted));
		assert.ok(
			spanFor(initialSpans, "resets 1h").fg.equals(initialTheme.text.muted),
		);
		assert.ok(
			spanFor(initialSpans, "Alpha host title").fg.equals(
				initialTheme.text.base,
			),
		);

		const alternate = fixtureTheme(ALTERNATE_COLORS);
		setTheme(alternate);
		await waitForSpanColor("10%", alternate.text.muted);
		await waitForSpanColor("resets 1h", alternate.text.muted);
		const alternateSpans = setup.captureSpans();
		assert.ok(
			spanFor(alternateSpans, "Alpha host title").fg.equals(
				alternate.text.base,
			),
		);
		assert.equal(calls.length, callsBeforeTheme);

		const tokenTheme = {
			text: {
				...alternate.text,
				get muted() {
					return tokenMuted();
				},
			},
		};
		setTheme(tokenTheme);
		await waitForSpanColor("resets 1h", tokenMutedA);
		setTokenMuted(tokenMutedB);
		await waitForSpanColor("resets 1h", tokenMutedB);
		assert.equal(calls.length, callsBeforeTheme);
		console.log("sidebar-slot-live: theme-updates");

		// Clicking anywhere in the card navigates to the existing page route and
		// triggers no new quota read.
		const callsBeforeClick = calls.length;
		await setup.mockMouse.click(3, 1);
		await setup.renderOnce();
		assert.deepEqual(navigations, [{ type: "plugin", name: "provider-usage" }]);
		assert.equal(calls.length, callsBeforeClick);

		setSelected({ providerID: "beta", modelID: "model-a" });
		const expired = await waitForFrame((frame) => {
			const squashed = frame.replace(/[│\s]+/g, "");
			const expected = UNAVAILABLE_NO_CURRENT_COPY.replace(/\s+/g, "");
			return squashed.includes(expected);
		});
		assert.ok(expired.includes("Quota unavailable"));
		assert.ok(!expired.includes("last attempt"));
		assert.ok(!expired.includes("ago"));
		assert.ok(!expired.includes("33%"));
		assert.ok(!expired.includes("resets"));

		failAlpha = true;
		setSelected({ providerID: "alpha", modelID: "model-a" });
		const failed = await waitForFrame((frame) =>
			frame.includes("no current result was returned"),
		);
		assert.ok(failed.includes("Alpha host title"));
		assert.ok(!/%/.test(failed));
		assert.ok(!failed.includes("resets"));
		assert.deepEqual(calls, [
			{ method: "get", providerID: "alpha" },
			{ method: "refresh", providerID: "alpha" },
			{ method: "get", providerID: "beta" },
			{ method: "get", providerID: "alpha" },
		]);

		// Activity uses the same provider even when only its selected model or
		// route changes. RPC errors preserve the existing card on same-provider refresh.
		clock += 61_000;
		setSelected({ providerID: "alpha", modelID: "model-b" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(calls.at(-1), { method: "refresh", providerID: "alpha" });
		clock += 61_000;
		setRoute({ type: "session", sessionID: "synthetic-session" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(calls.at(-1), { method: "refresh", providerID: "alpha" });
		clock += 61_000;
		keyInput.emit("keypress");
		renderer.emit("focus");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(
			calls.filter(
				(call) => call.method === "refresh" && call.providerID === "alpha",
			).length,
			4,
		);
		const emitStep = (name: string, id: string) =>
			stepEvents.get(name)?.({
				data: {
					sessionID: "s",
					assistantMessageID: id,
					model: { providerID: "gamma" },
				},
			});
		emitStep("session.step.started", "started");
		emitStep("session.step.ended", "started");
		emitStep("session.step.failed", "started");
		emitStep("session.step.ended", "missed");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(calls.filter((call) => call.providerID === "gamma").length, 1);
		assert.equal(calls.filter((call) => call.providerID === "delta").length, 1);

		// Retain an hour-old success even beyond expiry/reset. Render
		// reconciliation is display-only and must not request quota.
		failAlpha = false;
		const retained = reads.alpha;
		assert.ok(retained && "sections" in retained);
		const emitQuota = (quota: QuotaRead, presentation: QuotaPresentation) =>
			updated?.({
				data: {
					version: 2,
					providerID: "alpha",
					quota,
					presentation,
				},
			});
		const noCurrent: QuotaRead = {
			state: "unavailable",
			reason: "network_error",
			attemptedAt: clock,
		};
		// Establish the summary again after the earlier initial-read transport error.
		clock += 61_000;
		presentations.alpha = { revision: 1, lastKnown: retained };
		keyInput.emit("keypress");
		await waitForFrame((frame) => frame.includes("10%"));
		await advanceClock(3_600_000);
		const idleCalls = calls.length;
		setTheme(fixtureTheme(INITIAL_COLORS));
		const idleFrame = await waitForFrame((frame) => frame.includes("10%"));
		assert.ok(!idleFrame.includes("Data might be stale"));
		assert.equal(calls.length, idleCalls);

		// Failure alone starts a display deadline, not a fetch. Let time pass
		// without a pushed event: warning at 180 seconds, not before.
		emitQuota(noCurrent, {
			revision: 2,
			lastKnown: retained,
			failedSince: clock,
		});
		await advanceClock(179_999);
		await setup.renderOnce();
		assert.ok(!setup.captureCharFrame().includes("Data might be stale"));
		const beforeDeadlineCalls = calls.length;
		await advanceClock(1);
		const staleFrame = await waitForFrame((frame) =>
			frame.includes("Data might be stale"),
		);
		assert.ok(staleFrame.includes("10%"));
		assert.equal(calls.length, beforeDeadlineCalls);

		// Newer RPC success supersedes pushed failure, even if replayed later.
		const recoveredAt = clock;
		const recovered = windowQuota({
			remainingPercent: 85,
			fetchedAt: recoveredAt,
			expiresAt: clock + 90_000,
			resetsAt: clock + 3_600_000,
		});
		assert.ok("sections" in recovered);
		reads.alpha = recovered;
		presentations.alpha = { revision: 4, lastKnown: recovered };
		keyInput.emit("keypress");
		const recoveredFrame = await waitForFrame((frame) => frame.includes("15%"));
		assert.ok(!recoveredFrame.includes("Data might be stale"));
		emitQuota(noCurrent, {
			revision: 2,
			lastKnown: retained,
			failedSince: clock - 180_000,
		});
		await setup.renderOnce();
		assert.ok(setup.captureCharFrame().includes("15%"));
		assert.ok(!setup.captureCharFrame().includes("Data might be stale"));

		// A transport error cannot erase the card or fabricate a server failure.
		failAlpha = true;
		await advanceClock(61_000);
		keyInput.emit("keypress");
		await new Promise((resolve) => originalSetTimeout(resolve, 5));
		await setup.renderOnce();
		assert.ok(setup.captureCharFrame().includes("15%"));

		// Invalidation has no history. Old pushes must not restore old figures.
		emitQuota(
			{
				state: "auth-required",
				reason: "unsupported_auth_method",
				attemptedAt: clock,
			},
			{ revision: 5 },
		);
		const invalidated = await waitForFrame((frame) =>
			frame.includes("credentials were rejected"),
		);
		assert.ok(!invalidated.includes("15%"));
		assert.ok(!invalidated.includes("Data might be stale"));
		emitQuota(retained, { revision: 1, lastKnown: retained });
		await setup.renderOnce();
		assert.ok(!setup.captureCharFrame().includes("10%"));

		// Long-running failure still cannot warn until the data itself is old.
		emitQuota(noCurrent, {
			revision: 6,
			lastKnown: recovered,
			failedSince: clock - 180_000,
		});
		await setup.renderOnce();
		assert.ok(!setup.captureCharFrame().includes("Data might be stale"));
		await advanceClock(1_800_000 - (clock - recoveredAt));
		await setup.renderOnce();
		assert.ok(!setup.captureCharFrame().includes("Data might be stale"));
		await advanceClock(1);
		await waitForFrame((frame) => frame.includes("Data might be stale"));

		// Selection changes and unload each cancel the display-only timer.
		const pendingHistory = windowQuota({
			remainingPercent: 85,
			fetchedAt: clock,
			expiresAt: clock + 90_000,
			resetsAt: clock + 3_600_000,
		});
		assert.ok("sections" in pendingHistory);
		const pendingPresentation = {
			revision: 7,
			lastKnown: pendingHistory,
			failedSince: clock,
		};
		emitQuota(noCurrent, pendingPresentation);
		const deadlineAt = clock + 1_800_001;
		assert.ok([...deadlines.values()].some((timer) => timer.at === deadlineAt));
		setSelected({ providerID: "beta", modelID: "model-a" });
		await setup.renderOnce();
		assert.ok(
			![...deadlines.values()].some((timer) => timer.at === deadlineAt),
		);
		failAlpha = false;
		presentations.alpha = pendingPresentation;
		setSelected({ providerID: "alpha", modelID: "model-a" });
		await waitForFrame((frame) => frame.includes("15%"));
		assert.ok([...deadlines.values()].some((timer) => timer.at === deadlineAt));

		// Repeated host reconciliation builds fresh renderables; no disposed node
		// is ever reused.
		assert.ok(nodes.length >= 3);
		assert.ok(new Set(nodes).size >= 3);

		await setup.dispose();
		setup = undefined;
		dispose();
		assert.equal(slotDisposals, 1);
		assert.equal(eventDisposals, 3);
		assert.equal(pushDisposals, 1);
		assert.equal(deadlines.size, 0);
		assert.equal(keyInput.listenerCount("keypress"), 0);
		assert.equal(renderer.listenerCount("focus"), 0);
		const callsAfterDispose = calls.length;
		setSelected({ providerID: "beta", modelID: "model-a" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls.length, callsAfterDispose);
	} finally {
		await setup?.dispose();
		dispose();
		Date.now = originalNow;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
	console.log(SUCCESS_MARKER);
	console.log("sidebar-slot-live: navigation+disposal");
}

await main();

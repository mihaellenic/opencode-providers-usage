import { strict as assert } from "node:assert";
import { PluginContextProvider } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { QuotaRead } from "../../src/core/contracts";
import { type QuotaTuiContext, QuotaUsagePage } from "../../src/tui";

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

const provider = {
	providerID: "alpha",
	name: "Alpha",
	authMethod: "key",
	support: "supported",
	evidence: "documented-only",
};
const read = (expiresAt: number): QuotaRead => ({
	state: "available",
	authSource: "opencode",
	sections: [
		{
			scope: "provider-balance",
			result: {
				state: "available",
				fetchedAt: now,
				expiresAt,
				metrics: [
					{
						kind: "money",
						id: "balance",
						scope: "provider-balance",
						label: "Balance",
						currency: "USD",
						remaining: 42,
					},
				],
			},
		},
	],
});
let calls = 0;
let disposals = 0;
let update: ((payload: unknown) => void) | undefined;
const color = RGBA.fromHex("#ffffff");
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
	keymap: { layer: () => {} },
	ui: { router: { navigate: () => {} } },
	client: {
		rpc: () => ({
			list: async () => {
				calls++;
				return {
					version: 2,
					providers: [{ provider, quota: read(now + 90_000) }],
				};
			},
			events: {
				on: (_name: string, handler: (payload: unknown) => void) => {
					update = handler;
					return () => {
						update = undefined;
						disposals++;
					};
				},
			},
		}),
	},
} as unknown as QuotaTuiContext;

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
try {
	setup = await testRender(
		() =>
			jsx(PluginContextProvider as never, {
				value: context,
				get children() {
					return jsx(QuotaUsagePage, { context });
				},
			}),
		{ width: 120, height: 40 },
	);
	const frame = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await setup?.renderOnce();
		return setup?.captureCharFrame() ?? "";
	};
	assert.ok((await frame()).includes("$42.00 remaining"));
	now += 90_000;
	for (const [handle, timer] of [...timers])
		if (timer.at <= now && timers.delete(handle)) timer.callback();
	const expired = await frame();
	assert.ok(
		!expired.includes("$42.00 remaining"),
		"expired detail figures must disappear without a push",
	);
	assert.ok(expired.replace(/[│\s]/gu, "").includes("nocurrentvalidatedquota"));
	assert.equal(calls, 1, "display currentness deadline must not fetch");
	// New observations replace/cancel the prior deadline; max age still applies
	// even if a custom v2 source claims a much longer expiresAt.
	update?.({
		data: {
			version: 2,
			providerID: "alpha",
			quota: read(now + 3_600_000),
			presentation: { revision: 2 },
		},
	});
	assert.ok((await frame()).includes("$42.00 remaining"));
	now += 90_000;
	for (const [handle, timer] of [...timers])
		if (timer.at <= now && timers.delete(handle)) timer.callback();
	assert.ok(!(await frame()).includes("$42.00 remaining"));
	assert.equal(calls, 1);
	update?.({
		data: {
			version: 2,
			providerID: "alpha",
			quota: read(now + 60_000),
			presentation: { revision: 3 },
		},
	});
	await frame();
	assert.ok(timers.size > 0);
	await setup.dispose();
	setup = undefined;
	assert.equal(timers.size, 0);
	assert.equal(disposals, 1);
	console.log("detail-page-live: PASS");
} finally {
	await setup?.dispose();
	Date.now = originalNow;
	globalThis.setTimeout = originalSet;
	globalThis.clearTimeout = originalClear;
}

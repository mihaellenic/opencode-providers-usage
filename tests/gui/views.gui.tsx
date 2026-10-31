import { afterEach, describe, expect, test } from "bun:test";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import type { ClaudeUsage } from "../../src/claude-code/usage";
import type { ProviderSummary, QuotaRead } from "../../src/core/contracts";
import { DashboardView } from "../../src/gui/DashboardView";
import { ProviderCard } from "../../src/gui/ProviderCard";
import { SummaryView } from "../../src/gui/SummaryView";
import { useController } from "../../src/gui/solid";
import {
	createUsageController,
	type UsageController,
} from "../../src/gui/state";
import { styles } from "../../src/gui/styles";
import { QUOTA_RPC_VERSION, type QuotaListResult } from "../../src/rpc";
import { fakeClock, fakeRpc, fakeSession } from "./fakes";

const flush = async (): Promise<void> => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

const summary = (id: string): ProviderSummary => ({
	providerID: id,
	name: `Provider ${id}`,
	authMethod: "oauth",
	support: "supported",
	evidence: "unverified",
});

const windowQuota = (usedPercent: number): QuotaRead => ({
	state: "available",
	authSource: "opencode",
	sections: [
		{
			scope: "app",
			result: {
				state: "available",
				metrics: [
					{
						kind: "window",
						id: "w",
						scope: "app",
						label: "Primary",
						windowSeconds: 18_000,
						usedPercent,
						remainingPercent: 100 - usedPercent,
						resetsAt: 3_600_000,
					},
				],
				fetchedAt: 0,
				expiresAt: 3_600_000,
			},
		},
	],
});

const unsupported: QuotaRead = {
	state: "unsupported",
	reason: "no source",
	attemptedAt: 0,
};
const transient: QuotaRead = {
	state: "unavailable",
	reason: "transport",
	attemptedAt: 0,
};
const notApplicable: QuotaRead = {
	state: "not-applicable",
	reason: "no_validated_quota_source",
	attemptedAt: 0,
};

const listOf = (...items: [string, QuotaRead][]): QuotaListResult => ({
	version: QUOTA_RPC_VERSION,
	providers: items.map(([id, quota]) => ({ provider: summary(id), quota })),
});

const getOf = (id: string, quota: QuotaRead) => ({
	version: QUOTA_RPC_VERSION,
	provider: summary(id),
	quota,
});

const claude: ClaudeUsage = {
	session: { usedPercent: 10, resetsAt: 1_800_000 },
	week: { usedPercent: 20, resetsAt: 86_400_000 },
};

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
});

function setup(provider: string | null = "a") {
	const rpc = fakeRpc();
	const session = fakeSession("s1");
	const clock = fakeClock();
	if (provider !== null) session.setProvider(provider);
	const real = createUsageController({
		session,
		rpc,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	let listeners = 0;
	const retried: string[] = [];
	const controller: UsageController = {
		...real,
		subscribe(listener) {
			listeners += 1;
			const off = real.subscribe(listener);
			return () => {
				listeners -= 1;
				off();
			};
		},
		retry(id) {
			retried.push(id);
			real.retry(id);
		},
	};
	session.setVisible(true);
	return {
		rpc,
		session,
		clock,
		controller,
		retried,
		listeners: () => listeners,
	};
}

function App(props: { controller: UsageController }) {
	const version = useController(props.controller);
	const isDashboard = () => {
		version();
		return props.controller.view() === "dashboard";
	};
	return (
		<Show
			when={isDashboard()}
			fallback={<SummaryView controller={props.controller} now={() => 0} />}
		>
			<DashboardView controller={props.controller} now={() => 0} />
		</Show>
	);
}

function mount(h: ReturnType<typeof setup>): HTMLElement {
	const root = document.createElement("div");
	document.body.appendChild(root);
	disposers.push(render(() => <App controller={h.controller} />, root));
	return root;
}

/** The CSS block whose selector list is exactly `selector`. */
function ruleFor(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|[\\s},])${escaped}\\s*\\{([^}]*)\\}`).exec(
		styles,
	);
	if (match === null) throw new Error(`no CSS rule for ${selector}`);
	return match[1] ?? "";
}

const retryOf = (root: ParentNode, id: string): HTMLButtonElement => {
	const card = root.querySelector(`[data-provider="${id}"]`);
	const found = [...(card?.querySelectorAll("button") ?? [])].find(
		(b) => b.textContent?.trim() === "Retry",
	);
	if (found === undefined) throw new Error(`no Retry button for ${id}`);
	return found;
};

const button = (root: HTMLElement): HTMLButtonElement => {
	const found = root.querySelector("button");
	if (found === null) throw new Error("no button");
	return found;
};

const buttonByText = (root: HTMLElement, text: string): HTMLButtonElement => {
	const found = [...root.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`no button ${text}`);
	return found;
};

async function openDashboard(h: ReturnType<typeof setup>, root: HTMLElement) {
	button(root).click();
	await flush();
	// Opening restarts collection; the summary-era calls are now stale and the
	// controller must ignore them even if they settle.
	h.rpc.reject("list", new Error("stale"));
	h.rpc.reject("get", new Error("stale"));
	await flush();
}

describe("SummaryView", () => {
	test("renders distinct text for every state", async () => {
		const texts = new Set<string>();

		const none = setup(null);
		const noneRoot = mount(none);
		texts.add(noneRoot.textContent ?? "");
		expect(
			noneRoot.querySelector('[data-state="no-selection"]'),
		).not.toBeNull();

		const loading = setup();
		const loadingRoot = mount(loading);
		texts.add(loadingRoot.textContent ?? "");
		expect(loadingRoot.querySelector('[data-state="loading"]')).not.toBeNull();
		expect(button(loadingRoot).getAttribute("aria-busy")).toBe("true");

		const ready = setup();
		const readyRoot = mount(ready);
		ready.rpc.resolve("get", getOf("a", windowQuota(45.5)));
		await flush();
		texts.add(readyRoot.textContent ?? "");
		expect(readyRoot.querySelector('[data-state="ready"]')).not.toBeNull();
		expect(readyRoot.textContent).toContain("45.5%");
		expect(readyRoot.textContent).toContain("Provider a");

		const failed = setup();
		const failedRoot = mount(failed);
		failed.rpc.reject("get", new Error("boom"));
		await flush();
		texts.add(failedRoot.textContent ?? "");
		expect(failedRoot.querySelector('[data-state="failed"]')).not.toBeNull();

		expect(texts.size).toBe(4);
	});

	test("failed with lastKnown keeps figures and says they are stale", async () => {
		const h = setup();
		const root = mount(h);
		h.rpc.resolve("get", getOf("a", windowQuota(45.5)));
		await flush();
		h.controller.refresh();
		h.rpc.reject("refresh", new Error("boom"));
		await flush();
		const state = root.querySelector('[data-state="failed"]');
		expect(state).not.toBeNull();
		expect(root.textContent).toContain("45.5%");
		expect(root.textContent).toContain("Refresh failed");
		expect(root.textContent?.toLowerCase()).toContain("stale");
	});

	test("has one native button that opens the dashboard on click, Enter and Space", async () => {
		for (const activate of [
			(b: HTMLButtonElement) => b.click(),
			(b: HTMLButtonElement) =>
				b.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						bubbles: true,
						cancelable: true,
					}),
				),
			(b: HTMLButtonElement) =>
				b.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: " ",
						code: "Space",
						bubbles: true,
						cancelable: true,
					}),
				),
		]) {
			const h = setup();
			const root = mount(h);
			expect(root.querySelectorAll("button").length).toBe(1);
			expect(button(root).tagName).toBe("BUTTON");
			expect(button(root).getAttribute("type")).toBe("button");
			activate(button(root));
			await flush();
			expect(h.controller.view()).toBe("dashboard");
			expect(root.querySelector("[data-dashboard]")).not.toBeNull();
			for (const dispose of disposers.splice(0)) dispose();
			document.body.innerHTML = "";
		}
	});
});

describe("DashboardView", () => {
	test("Back returns to the summary and focuses its button", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		expect(buttonByText(root, "Refresh")).toBeDefined();
		buttonByText(root, "Back").click();
		await flush();
		expect(h.controller.view()).toBe("summary");
		expect(root.querySelector("[data-dashboard]")).toBeNull();
		expect(document.activeElement).toBe(button(root));
	});

	test("Refresh refreshes through the controller", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", windowQuota(10)]));
		await flush();
		const before = h.rpc.calls.filter((c) => c.method === "refresh").length;
		buttonByText(root, "Refresh").click();
		await flush();
		expect(h.rpc.calls.filter((c) => c.method === "refresh").length).toBe(
			before + 1,
		);
	});

	test("orders available cards and moves unsupported and not-applicable ones into one note after the grid", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve(
			"list",
			listOf(
				["a", unsupported],
				["b", transient],
				["c", windowQuota(10)],
				["d", notApplicable],
			),
		);
		await flush();
		const order = [...root.querySelectorAll("[data-provider]")].map((n) =>
			n.getAttribute("data-provider"),
		);
		expect(order).toEqual(["b", "c"]);
		expect(root.querySelector('[data-provider="a"]')).toBeNull();
		expect(root.querySelector('[data-provider="d"]')).toBeNull();
		expect(root.querySelector("[data-full-row]")).toBeNull();

		const note = root.querySelector("[data-unavailable-note]");
		expect(note?.textContent).toBe(
			"Usage unavailable for: Provider a, Provider d",
		);
		expect(note?.tagName).toBe("P");
		const grid = root.querySelector(".ou-grid");
		expect(grid).not.toBeNull();
		expect(note).not.toBeNull();
		expect(
			(grid?.compareDocumentPosition(note as Node) ?? 0) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).not.toBe(0);
	});

	test("an all-unavailable inventory shows only the note, with no grid and no disconnected message", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", unsupported], ["b", notApplicable]));
		await flush();
		expect(root.querySelector("[data-provider]")).toBeNull();
		expect(root.querySelector(".ou-grid")).toBeNull();
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider a, Provider b",
		);
		expect(root.textContent).not.toContain("No connected providers.");
	});

	test("an inventory without unavailable providers renders no note", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", windowQuota(10)], ["b", transient]));
		await flush();
		expect(root.querySelector("[data-unavailable-note]")).toBeNull();
		expect(root.querySelectorAll("[data-provider]").length).toBe(2);
	});

	test("an empty inventory keeps the disconnected message and no note", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf());
		await flush();
		expect(root.textContent).toContain("No connected providers.");
		expect(root.querySelector("[data-unavailable-note]")).toBeNull();
	});

	test("the note is muted and wraps a long unbroken display name", async () => {
		const longName =
			"Unbroken-Quarterly-Enterprise-Gateway-Provider-Name-Without-Spaces";
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", {
			version: QUOTA_RPC_VERSION,
			providers: [
				{
					provider: { ...summary("a"), name: longName },
					quota: unsupported,
				},
			],
		});
		await flush();
		const note = root.querySelector("[data-unavailable-note]");
		expect(note?.textContent).toBe(`Usage unavailable for: ${longName}`);
		expect(note?.getAttribute("data-tone")).toBe("muted");
		expect(ruleFor(".ou-note[data-unavailable-note]")).toMatch(
			/overflow-wrap:\s*anywhere/,
		);
		expect(ruleFor(".ou-note[data-unavailable-note]")).not.toMatch(
			/white-space/,
		);
		expect(ruleFor('.ou-dashboard [data-tone="muted"]')).toMatch(
			/opacity:\s*0\.\d+/,
		);
	});

	test("a failed refresh of an unsupported provider keeps its card with Retry, and a successful Retry returns it to the note", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve(
			"list",
			listOf(["a", unsupported], ["b", windowQuota(10)], ["d", notApplicable]),
		);
		await flush();
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider a, Provider d",
		);

		buttonByText(root, "Refresh").click();
		await flush();
		// Pending refreshes settle oldest first: a, then b and d.
		h.rpc.reject("refresh", new Error("boom"));
		h.rpc.resolve("refresh", getOf("b", windowQuota(10)));
		h.rpc.resolve("refresh", getOf("d", notApplicable));
		await flush();

		const failed = root.querySelector('[data-provider="a"]');
		expect(failed?.textContent).toContain("Refresh failed");
		expect(retryOf(root, "a")).toBeDefined();
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider d",
		);

		retryOf(root, "a").click();
		await flush();
		expect(h.retried).toEqual(["a"]);
		h.rpc.reject("refresh", new Error("still down"));
		await flush();
		expect(retryOf(root, "a")).toBeDefined();
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider d",
		);

		retryOf(root, "a").click();
		await flush();
		h.rpc.resolve("refresh", getOf("a", unsupported));
		await flush();
		expect(root.querySelector('[data-provider="a"]')).toBeNull();
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider a, Provider d",
		);
	});

	test("a transient failure stays a card whose Retry works while the unsupported provider stays in the note", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", unsupported], ["b", transient]));
		await flush();
		buttonByText(root, "Refresh").click();
		await flush();
		// Oldest first: a settles successfully, then b fails.
		h.rpc.resolve("refresh", getOf("a", unsupported));
		h.rpc.reject("refresh", new Error("boom"));
		await flush();
		const card = root.querySelector('[data-provider="b"]');
		expect(card?.textContent).toContain("Refresh failed");
		expect(root.querySelector("[data-unavailable-note]")?.textContent).toBe(
			"Usage unavailable for: Provider a",
		);
		retryOf(root, "b").click();
		await flush();
		expect(h.retried).toEqual(["b"]);
	});

	test("Claude card is absent while collecting, on failure and method_not_found, present on success", async () => {
		const cases: [string, (h: ReturnType<typeof setup>) => void, boolean][] = [
			["collecting", () => {}, false],
			[
				"failure",
				(h) => h.rpc.reject("claudeCodeUsage", new Error("x")),
				false,
			],
			[
				"method_not_found",
				(h) => h.rpc.resolve("claudeCodeUsage", null),
				false,
			],
			["success", (h) => h.rpc.resolve("claudeCodeUsage", claude), true],
		];
		for (const [name, settle, present] of cases) {
			const h = setup();
			const root = mount(h);
			await openDashboard(h, root);
			h.rpc.resolve("list", listOf(["a", windowQuota(10)]));
			settle(h);
			await flush();
			expect(
				root.querySelector('[data-provider="claude-code"]') !== null,
				name,
			).toBe(present);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.innerHTML = "";
		}
	});

	test("a failed card shows Retry that calls controller.retry", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", windowQuota(10)], ["b", transient]));
		await flush();
		buttonByText(root, "Refresh").click();
		await flush();
		h.rpc.reject("refresh", new Error("boom"));
		await flush();
		const card = root.querySelector('[data-provider="a"]');
		expect(card?.textContent).toContain("Refresh failed");
		const retry = [...(card?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent?.trim() === "Retry",
		);
		expect(retry).toBeDefined();
		retry?.click();
		await flush();
		expect(h.retried).toEqual(["a"]);
	});

	test("a rejected list shows a failure and no spinner", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
		h.rpc.reject("list", new Error("boom"));
		await flush();
		expect(root.querySelector('[aria-busy="true"]')).toBeNull();
		expect(root.querySelector("[data-loading]")).toBeNull();
		expect(root.textContent).toContain("Could not load");
	});

	test("progressbar values equal the visible percent", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		h.rpc.resolve("list", listOf(["a", windowQuota(45.5)]));
		h.rpc.resolve("claudeCodeUsage", claude);
		await flush();
		const bars = [...root.querySelectorAll('[role="progressbar"]')];
		expect(bars.length).toBeGreaterThanOrEqual(3);
		const seen: string[] = [];
		for (const bar of bars) {
			const now = bar.getAttribute("aria-valuenow");
			expect(bar.getAttribute("aria-valuemin")).toBe("0");
			expect(bar.getAttribute("aria-valuemax")).toBe("100");
			expect(bar.getAttribute("aria-label")?.length).toBeGreaterThan(0);
			const row = bar.closest("[data-line]");
			expect(row?.textContent).toContain(`${now}%`);
			seen.push(now ?? "");
		}
		expect(seen).toContain("45.5");
		expect(seen).toContain("10");
		expect(seen).toContain("20");
	});

	test("ctrl+r keydown is not default-prevented", async () => {
		const h = setup();
		const root = mount(h);
		await openDashboard(h, root);
		for (const target of [
			root.querySelector("[data-dashboard]"),
			buttonByText(root, "Refresh"),
		]) {
			const event = new KeyboardEvent("keydown", {
				key: "r",
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			});
			target?.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
	});

	test("unmount leaves no controller listener", async () => {
		const h = setup();
		const root = document.createElement("div");
		document.body.appendChild(root);
		const dispose = render(() => <App controller={h.controller} />, root);
		expect(h.listeners()).toBeGreaterThan(0);
		await openDashboard(h, root);
		dispose();
		expect(h.listeners()).toBe(0);
		expect(root.innerHTML).toBe("");
	});
});

describe("ProviderCard", () => {
	test("renders every line variant without losing information", () => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		disposers.push(
			render(
				() => (
					<ProviderCard
						card={{
							id: "x",
							name: "X",
							lines: [
								{
									id: "1",
									kind: "window",
									label: "5h",
									value: { text: "40%", tone: "normal" },
									fill: 0.4,
									reset: "resets 1h",
								},
								{
									id: "2",
									kind: "window",
									label: "7d",
									value: { text: "Unknown (not reported)", tone: "muted" },
								},
								{
									id: "3",
									kind: "credit",
									label: "Included",
									value: { text: "$5.00 remaining", tone: "error" },
									detail: "refills in 2d",
								},
								{
									id: "4",
									kind: "pair",
									left: { text: "$1.00 / $2.00 used", tone: "normal" },
									right: { text: "+$3.00 credits", tone: "normal" },
									metricIDs: [],
								},
								{
									id: "5",
									kind: "bar",
									fill: 0.25,
									percent: { text: "25%", tone: "warning" },
									reset: "resets 3h",
								},
								{
									id: "6",
									kind: "status",
									text: "Be careful",
									tone: "warning",
								},
							],
						}}
					/>
				),
				root,
			),
		);
		const text = root.textContent ?? "";
		for (const expected of [
			"X",
			"5h",
			"40%",
			"resets 1h",
			"7d",
			"Unknown (not reported)",
			"Included",
			"$5.00 remaining",
			"refills in 2d",
			"$1.00 / $2.00 used",
			"+$3.00 credits",
			"25%",
			"resets 3h",
			"Be careful",
		]) {
			expect(text).toContain(expected);
		}
		expect(root.querySelectorAll('[role="progressbar"]').length).toBe(2);
	});
});

describe("summary overlay", () => {
	test("accessible name starts with the visible text and ends with the action", async () => {
		const h = setup();
		const root = mount(h);
		h.rpc.resolve("get", getOf("a", windowQuota(45.5)));
		await flush();
		const b = button(root);
		const label = b.getAttribute("aria-label") ?? "";
		expect(b.textContent?.replace(/\s+/g, " ").trim()).toContain(
			"Provider usage",
		);
		expect(label.startsWith("Provider usage")).toBe(true);
		expect(label).toContain("Provider a");
		expect(label.endsWith("Open dashboard")).toBe(true);
		expect(label.indexOf("Provider a")).toBeLessThan(
			label.indexOf("Open dashboard"),
		);
		expect(root.querySelectorAll("button").length).toBe(1);
		expect(root.querySelectorAll('[role="progressbar"]').length).toBe(1);
	});

	test("the button stretches over the whole summary and the section shows focus", () => {
		expect(styles).toMatch(/\.ou-summary\s*\{[^}]*position:\s*relative/);
		expect(styles).toMatch(
			/\.ou-summary-button::after\s*\{[^}]*content:\s*""[^}]*position:\s*absolute[^}]*inset:\s*0/,
		);
		expect(styles).toMatch(
			/\.ou-summary:has\(\.ou-summary-button:focus-visible\)\s*\{[^}]*outline/,
		);
	});
});

describe("styles", () => {
	test("dashboard scrolls inside itself and contains overscroll", () => {
		expect(styles).toContain("overflow-y: auto");
		expect(styles).toContain("overscroll-behavior: contain");
	});

	test("grid has no fixed panel width and goes from 1 to 2 columns by container query", () => {
		expect(styles).toContain("container-type: inline-size");
		expect(styles).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
		expect(styles).toMatch(
			/@container[^{]*\(min-width:[^)]*\)\s*\{[^@]*repeat\(2,/,
		);
		expect(styles).not.toMatch(/(?<![-\w])width:\s*[\d.]+(?:px|r?em|ch|vw|pt)/);
		expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
		expect(styles).not.toMatch(/var\(--/);
	});
});

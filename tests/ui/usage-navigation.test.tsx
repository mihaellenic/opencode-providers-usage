import { describe, expect, test } from "bun:test";
import { createUsageNavigator, type QuotaTuiContext } from "../../src/tui";

type QuotaRoute = ReturnType<QuotaTuiContext["ui"]["router"]["current"]>;
type QuotaDestination = Parameters<
	QuotaTuiContext["ui"]["router"]["navigate"]
>[0];

function routeHost(initial: QuotaRoute) {
	let route = initial;
	const navigations: QuotaDestination[] = [];
	return {
		context: {
			ui: {
				router: {
					current: () => route,
					navigate: (destination: QuotaDestination) => {
						navigations.push(destination);
						route = destination as QuotaRoute;
					},
				},
			},
		} as unknown as Pick<QuotaTuiContext, "ui">,
		navigations,
		current: () => route,
	};
}

describe("usage page return route", () => {
	test("esc returns to the session that opened the page", () => {
		const host = routeHost({ type: "session", sessionID: "ses_session" });
		const usage = createUsageNavigator(host.context);

		usage.open();
		expect(host.current()).toEqual({
			type: "plugin",
			name: "provider-usage",
		} as unknown as QuotaRoute);

		usage.back();
		expect(host.current()).toEqual({
			type: "session",
			sessionID: "ses_session",
		});
	});

	test("reopening while the page is active keeps the original return route", () => {
		const host = routeHost({ type: "session", sessionID: "ses_session" });
		const usage = createUsageNavigator(host.context);

		usage.open();
		usage.open();
		usage.back();

		expect(host.current()).toEqual({
			type: "session",
			sessionID: "ses_session",
		});
	});

	test("back without an opening route returns home", () => {
		const host = routeHost({ type: "session", sessionID: "ses_session" });
		const usage = createUsageNavigator(host.context);

		usage.back();

		expect(host.current()).toEqual({ type: "home" });
	});

	test("opening from home returns home", () => {
		const host = routeHost({ type: "home" });
		const usage = createUsageNavigator(host.context);

		usage.open();
		usage.back();

		expect(host.current()).toEqual({ type: "home" });
	});

	test("returning to a session does not replay its startup prompt", () => {
		const host = routeHost({
			type: "session",
			sessionID: "ses_session",
			prompt: { text: "startup prompt" },
		} as unknown as QuotaRoute);
		const usage = createUsageNavigator(host.context);

		usage.open();
		usage.back();

		expect(host.current()).toEqual({
			type: "session",
			sessionID: "ses_session",
		});
	});

	test("returning to another plugin restores its route data", () => {
		const host = routeHost({
			type: "plugin",
			id: "other.plugin",
			name: "other-page",
			data: { tab: "second" },
		});
		const usage = createUsageNavigator(host.context);

		usage.open();
		usage.back();

		expect(host.current()).toEqual({
			type: "plugin",
			id: "other.plugin",
			name: "other-page",
			data: { tab: "second" },
		});
	});
});

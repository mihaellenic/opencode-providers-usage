import { describe, expect, test } from "bun:test";
import { resolveCompanionOptions } from "../../src/index";

describe("codex companion options", () => {
	test("companion_is_enabled_without_configuration", () => {
		expect(resolveCompanionOptions(undefined)).toEqual({ enabled: true });
		expect(resolveCompanionOptions({})).toEqual({ enabled: true });
		expect(resolveCompanionOptions({ codexCompanion: "yes" } as never)).toEqual(
			{ enabled: true },
		);
	});

	test("explicit_false_is_the_only_opt_out", () => {
		expect(
			resolveCompanionOptions({ codexCompanion: { enabled: false } }),
		).toEqual({ enabled: false });
		expect(
			resolveCompanionOptions({
				codexCompanion: { enabled: "false" },
			} as never),
		).toEqual({ enabled: true });
	});

	test("home_alone_still_enables_and_is_preserved", () => {
		expect(
			resolveCompanionOptions({ codexCompanion: { home: "/synthetic/home" } }),
		).toEqual({ enabled: true, home: "/synthetic/home" });
		expect(
			resolveCompanionOptions({ codexCompanion: { home: "   " } }),
		).toEqual({ enabled: true });
	});
});

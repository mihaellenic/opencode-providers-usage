import { describe, expect, test } from "bun:test";
import { resolveCompanionOptions } from "../../src/index";

describe("codex companion options", () => {
	test.each([
		["no options", undefined, { enabled: true }],
		["empty options", {}, { enabled: true }],
		["non-object companion", { codexCompanion: "yes" }, { enabled: true }],
		[
			"explicit false is the opt out",
			{ codexCompanion: { enabled: false } },
			{ enabled: false },
		],
		[
			"string false is not an opt out",
			{ codexCompanion: { enabled: "false" } },
			{ enabled: true },
		],
		[
			"home alone enables and is preserved",
			{ codexCompanion: { home: "/synthetic/home" } },
			{ enabled: true, home: "/synthetic/home" },
		],
		[
			"blank home is dropped",
			{ codexCompanion: { home: "   " } },
			{ enabled: true },
		],
	])("%s", (_name, options, expected) => {
		expect(resolveCompanionOptions(options as never)).toEqual(expected);
	});
});

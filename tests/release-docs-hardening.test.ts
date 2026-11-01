import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("docs/validation.md", () => {
	const doc = read("docs/validation.md");

	test("no longer references the removed check:build or old build exports output", () => {
		expect(doc).not.toContain("check:build");
		expect(doc).not.toContain("build exports ok");
	});

	test("uses the current deterministic build, package contract, strict audit, and pack dry-run", () => {
		expect(doc).toContain("bun scripts/bun-audit-gate.ts");
		expect(doc).toContain("tests/package.test.ts");
		expect(doc).toContain("npm pack --dry-run");
		expect(doc).toContain("bun run build");
	});

	test("labels the original baseline as historical", () => {
		expect(doc).toMatch(/historical/i);
	});
});

describe("docs/releasing.md bootstrap hardening", () => {
	const doc = read("docs/releasing.md");

	test("explains the runtime and output-directory checks", () => {
		expect(doc).toContain("exactly Bun 1.4.4");
		expect(doc).toContain("new or existing-empty");
		expect(doc).toContain("symlink");
		expect(doc).toContain("source repository");
	});

	test("explains publish-error ambiguity and safe retry", () => {
		const start = doc.indexOf("## Failure and recovery");
		expect(start).toBeGreaterThan(-1);
		const text = doc.slice(start);
		expect(text).toContain("--verify-published");
		expect(text).toContain("do not republish");
		expect(text).toContain("E404");
		expect(text).toContain("independently confirm");
		expect(text).toMatch(/auth[\s\S]*network[\s\S]*malformed[\s\S]*mismatch/i);
		expect(text).toContain("same accepted tarball");
		expect(text).toMatch(/never[^\n]*bump the version/i);
		expect(text).toMatch(/never[^\n]*move[^\n]*tag/i);
		expect(text).toMatch(/never[^\n]*unpublish/i);
	});
});

describe("Desktop GUI support statements (Task 8)", () => {
	const readme = read("README.md");
	const support = read("docs/support.md");

	for (const [name, doc] of [
		["README.md", readme],
		["docs/support.md", support],
	] as const) {
		test(`${name} qualifies the Desktop GUI as experimental with exact tested versions`, () => {
			expect(doc).toMatch(/experimental/i);
			expect(doc).toContain("@opencode/plugin");
			expect(doc).toContain("2.2.0");
			expect(doc).toContain("Desktop `2.2.1`");
		});

		test(`${name} separates the historical 2.1.4 validation from the current tested versions`, () => {
			expect(doc).toContain(
				"Historical validation: OpenCode `2.1.4` (V2 plugin, RPC, and terminal APIs)",
			);
			expect(doc).toContain(
				"current package SDK is `@opencode/plugin` `2.2.0`",
			);
			expect(doc).toContain(
				"clean TUI smoke on CLI `2.2.0` under the candidate SDK",
			);
			expect(doc).toContain("synthetic smoke on the Desktop `2.2.1` server");
			expect(doc).toContain(
				"OpenCode `2.1.4` hosts were not tested with this build",
			);
			expect(doc).not.toContain("Baseline: OpenCode `2.1.4`");
			expect(doc).not.toContain("| OpenCode baseline |");
		});

		test(`${name} separates the earlier 2.2.1 smoke from the final-bundle 2.2.2 flows`, () => {
			expect(doc).toContain(
				"The earlier full synthetic smoke (S1-S13) ran on Desktop `2.2.1` with the previous GUI bundle.",
			);
			expect(doc).toContain(
				"The final GUI bundle (SHA-256 `761e180f...`) was exercised only for the composer-model, new-session default, dashboard and Back flows, on Desktop `2.2.2`.",
			);
			expect(doc).toContain(
				"The other scenarios were not rerun on `2.2.2`, and the final bundle did not run the full matrix on `2.2.1`.",
			);
		});

		test(`${name} does not transfer historical GUI hash evidence to a rebuilt candidate`, () => {
			expect(doc.replace(/\s+/g, " ")).toContain(
				"Recorded GUI bundle hashes are historical artifacts; a rebuilt candidate needs fresh host checks.",
			);
		});

		test(`${name} keeps web, V1 and forks unsupported and drops the blanket desktop exclusion`, () => {
			expect(doc).toMatch(/web[^\n]*not supported|not supported[^\n]*web/i);
			expect(doc).toMatch(/V1/);
			expect(doc).toMatch(/forks?/i);
			expect(doc).not.toContain("desktop/web extension");
			expect(doc).not.toContain("desktop/web extensions");
		});

		test(`${name} uses only the exact allowed phrasing near "verified" for the Desktop GUI`, () => {
			const allowed = ["verified beyond the PASS rows", "not verified"];
			const lines = doc
				.split("\n")
				.filter((l) => /desktop/i.test(l) && /verified/i.test(l));
			for (const line of lines) {
				expect(allowed.some((phrase) => line.includes(phrase))).toBe(true);
			}
		});

		test(`${name} does not link to the git-ignored docs/superpowers tree`, () => {
			expect(doc).not.toContain("docs/superpowers");
		});

		test(`${name} relative links point at tracked files`, () => {
			const tracked = new Set(
				execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
					.split("\n")
					.filter(Boolean),
			);
			const base = name === "README.md" ? "" : "docs/";
			for (const match of doc.matchAll(/\]\(([^)#\s]*)(#[^)\s]*)?\)/g)) {
				const target = match[1] ?? "";
				if (target === "" || /^[a-z]+:/i.test(target)) continue;
				const resolved = join(base, target).replace(/^\.\//, "");
				expect(tracked.has(resolved)).toBe(true);
			}
		});
	}

	test("README intro counts five entrypoints and names the SDK and toolchain", () => {
		expect(readme).toContain("exports five entrypoints");
		expect(readme).not.toContain("exports four entrypoints");
		expect(readme).toMatch(/SDK[^\n]*`2\.2\.0`/);
	});

	test("support.md inlines the smoke table with provenance, gaps and fixture labels", () => {
		expect(support).toContain("## Desktop GUI smoke results");
		expect(readme).toContain("(docs/support.md#desktop-gui-smoke-results)");
		for (const phrase of [
			"synthetic data",
			"not real quota validation",
			"| S10 | Two windows, different sessions | PASS |",
			"| S13 | Old-contract backend (no `claudeCodeUsage`) | PASS (fixture backend) |",
			"fixture, not a real older binary",
			"| S14 | Real older OpenCode server binary | NOTRUN |",
			"`/usr/bin/security`",
		]) {
			expect(support).toContain(phrase);
		}
	});
});

describe("Desktop GUI support details (final fix)", () => {
	const support = read("docs/support.md");

	test("S9 states how the 296 s sample relates to the 300000 ms idle window", () => {
		const row = support.split("\n").find((l) => l.startsWith("| S9 "));
		expect(row).toContain("sample that started 4 s after the idle reset");
		expect(row).toContain("about 300000 ms in total");
	});

	test("documents why OpenTUI 0.6.8 is retained", () => {
		expect(support).toContain(
			"`@opentui/solid` `0.6.8` is retained because `0.7.0` changed glyph rounding in the Ollama credit bar",
		);
		expect(support).toContain(
			"OpenTUI `0.7.0` peers of SDK `2.2.0` are optional",
		);
	});
});

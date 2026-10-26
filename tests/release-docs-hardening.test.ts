import { describe, expect, test } from "bun:test";
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

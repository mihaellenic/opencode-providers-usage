import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const doc = readFileSync(join(root, "docs/releasing.md"), "utf8");

describe("docs/releasing.md owner-run bootstrap", () => {
	test("documents the approval boundary before any public action", () => {
		expect(doc).toContain("## One-time bootstrap");
		expect(doc).toContain("Approval boundary");
		expect(doc).toContain("explicit owner approval");
		expect(doc).toContain("mihaellenic");
		expect(doc).toContain("research finding, not authorization");
		expect(doc).toContain("mihaellenic/opencode-providers-usage");
		expect(doc).toContain("MIT");
		expect(doc).toContain("Mihael Lenic");
	});

	test("pins the exact preflight toolchain and scratch root", () => {
		expect(doc).toContain("Bun 1.4.4");
		expect(doc).toContain("Node 24");
		expect(doc).toContain("npm 11.16.0");
		expect(doc).toContain("11.19.1");
		expect(doc).toContain(
			"/private/var/folders/g4/1c3drxkd7099x31fjzffcjjw0000gn/T/opencode",
		);
		expect(doc).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(doc).toContain(
			"bun scripts/release-acceptance.ts --output-dir <absolute-dir>",
		);
	});

	test("publishes only the accepted tarball with owner interactive 2FA", () => {
		expect(doc).toContain("npm publish <accepted-tarball> --access public");
		expect(doc).toContain("never repack");
		expect(doc).toContain("2FA");
		expect(doc).toContain("no stored token");
		expect(doc).toContain(
			"bun scripts/release-acceptance.ts --verify-published <artifact.json>",
		);
		expect(doc).toContain("dist.integrity");
		expect(doc).toContain("OIDC provenance");
	});

	test("tags and releases only after verification, never moving tags", () => {
		expect(doc).toContain("v0.1.0");
		expect(doc).toContain("exact accepted source commit");
		expect(doc).toContain("non-draft");
		expect(doc).toContain("never move");
		expect(doc).toContain("0.0.0");
		expect(doc).toContain('{".": "0.1.0"}');
	});

	test("documents failure, recovery, and rollback boundaries", () => {
		expect(doc).toContain("## Failure and recovery");
		expect(doc).toContain("do not bump the version");
		expect(doc).toContain("immutable");
		expect(doc).toContain("deprecat");
		expect(doc).toContain("never automated unpublish");
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { committedPaths, isCommittedPath } from "../scripts/release-inventory";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const doc = read("docs/releasing.md");
const flat = doc.replace(/\s+/g, " ");
const acceptanceSource = read("scripts/release-acceptance.ts");
const release = read(".github/workflows/release.yml");

/** ArtifactMetadata field names, read from the acceptance source itself. */
function artifactFields(): string[] {
	const match = acceptanceSource.match(
		/export interface ArtifactMetadata \{([^}]*)\}/,
	);
	if (!match) throw new Error("ArtifactMetadata interface not found");
	return [...(match[1] ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? "");
}

/** Every `--flag` token used on a `bun scripts/release-acceptance.ts` line. */
function documentedAcceptanceFlags(): string[] {
	const flags = new Set<string>();
	for (const line of doc.split("\n")) {
		if (!line.includes("scripts/release-acceptance.ts")) continue;
		for (const token of line.split(/\s+/)) {
			if (token.startsWith("--")) flags.add(token);
		}
	}
	return [...flags].sort();
}

describe("docs relative links", () => {
	const tracked = committedPaths(root);
	for (const path of [
		"README.md",
		"docs/releasing.md",
		"docs/support.md",
		"docs/validation.md",
	]) {
		test(`${path} relative links point at tracked files`, () => {
			const base = dirname(path);
			for (const match of read(path).matchAll(/\]\(([^)#\s]*)(#[^)\s]*)?\)/g)) {
				const target = match[1] ?? "";
				if (target === "" || /^[a-z]+:/i.test(target)) continue;
				const resolved = join(base, target).replace(/^\.\//, "");
				expect(isCommittedPath(tracked, resolved)).toBe(true);
			}
		});
	}
});

describe("docs/releasing.md against the release tooling", () => {
	test("documents artifact.json fields exactly as ArtifactMetadata declares them", () => {
		const fields = artifactFields();
		expect(fields).toEqual([
			"name",
			"version",
			"filename",
			"path",
			"integrity",
			"shasum",
			"sha256",
		]);
		const listed = doc.match(/`artifact\.json`, whose fields are\s+([^.]*)\./);
		expect(listed).not.toBeNull();
		const documented = [...(listed?.[1] ?? "").matchAll(/`(\w+)`/g)].map(
			(m) => m[1],
		);
		expect(documented).toEqual(fields);
	});

	test("documents only acceptance flags that exist in the script", () => {
		const flags = new Set([
			...documentedAcceptanceFlags(),
			...[...flat.matchAll(/`(--[a-z][a-z-]*)`/g)].map((m) => m[1] ?? ""),
		]);
		expect([...flags].sort()).toEqual(["--output-dir", "--verify-published"]);
		for (const flag of flags) {
			expect(acceptanceSource).toContain(`"${flag}"`);
		}
		// local-only flag: the runbook must never recommend it for releases
		expect(doc).not.toContain("--allow-published");
	});

	test("never instructs storing an npm token and the workflow publishes over OIDC", () => {
		expect(doc).not.toMatch(/NPM_TOKEN|_authToken/);
		expect(doc).not.toContain("NODE_AUTH_TOKEN");
		expect(release).not.toContain("NODE_AUTH_TOKEN");
		expect(release).not.toContain("secrets.NPM");
		expect(release).toContain("id-token: write");
	});
});

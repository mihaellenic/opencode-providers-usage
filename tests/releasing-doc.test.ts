import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const doc = read("docs/releasing.md");
const acceptanceSource = read("scripts/release-acceptance.ts");
const ci = read(".github/workflows/ci.yml");
const pkg = JSON.parse(read("package.json")) as {
	publishConfig?: { access?: string };
};

/** Return the markdown lines of one `## ` or `### ` section, heading excluded. */
function section(heading: string): string {
	const start = doc.indexOf(`\n${heading}\n`);
	if (start === -1) throw new Error(`missing section: ${heading}`);
	const rest = doc.slice(start + heading.length + 2);
	const next = rest.search(/\n##? /);
	return next === -1 ? rest : rest.slice(0, next);
}

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

describe("docs/releasing.md approval boundary", () => {
	test("lists every owner-gated action with the research-finding caveat", () => {
		const boundary = section("## Approval boundary");
		expect(boundary).toContain("explicit owner approval");
		expect(boundary).toContain("public-source review");
		expect(boundary).toContain("MIT license and attribution to Mihael Lenic");
		expect(boundary).toContain("mihaellenic/opencode-providers-usage");
		expect(boundary).toContain("The owner `mihaellenic` is a");
		expect(boundary).toContain("research finding, not authorization");
		expect(boundary).toContain("the first npm publish");
		expect(boundary).toContain("creating the `v0.1.0` tag");
	});

	test("forbids requesting token values", () => {
		expect(doc).toContain("Do not request, paste, or store token values");
	});
});

describe("docs/releasing.md preflight", () => {
	test("pins Bun 1.4.4 and matches the package and CI pins", () => {
		expect(doc).toContain("| Bun | 1.4.4 |");
		expect(pkg).toBeDefined();
		expect(read("package.json")).toContain('"packageManager": "bun@1.4.4"');
		expect(ci).toContain("bun-version: 1.4.4");
	});

	test("describes Node 24 as a local observation, not a CI match", () => {
		expect(doc).toContain("Node 24 is the release toolchain observation");
		expect(doc).toContain("`ci.yml` does not pin Node");
		expect(doc).toContain("Node 24 is not a CI match");
		expect(doc).not.toMatch(/Node 24 matches CI/i);
		expect(ci).not.toContain("node-version");
	});

	test("records npm 11.19.1 as observed, not pinned", () => {
		expect(doc).toContain("npm | 11.16.0 or later");
		expect(doc).toContain(
			"observed, not pinned: the local machine reported 11.19.1",
		);
	});

	test("uses a placeholder SCRATCH_ROOT and no machine-specific absolute path", () => {
		expect(doc).toContain("export SCRATCH_ROOT=<approved-scratch-root>");
		expect(doc).toContain("local example only");
		expect(doc).not.toContain("/private/var/");
	});
});

describe("docs/releasing.md source commit recording", () => {
	test("records the source commit explicitly before acceptance", () => {
		const step = section("### 2. Record the source commit");
		expect(step).toContain("git rev-parse HEAD");
		expect(step).toContain("release report");
		expect(step).toContain("`commit:`");
		const acceptStep = section("### 3. Accept the exact commit");
		expect(acceptStep).toContain(
			"bun scripts/release-acceptance.ts --output-dir <absolute-dir>",
		);
		expect(doc.indexOf("git rev-parse HEAD")).toBeLessThan(
			doc.indexOf(
				"bun scripts/release-acceptance.ts --output-dir <absolute-dir>",
			),
		);
	});

	test("never claims artifact.json contains the source commit", () => {
		expect(doc).toMatch(/`artifact\.json` does not contain a commit/);
		const lines = doc.split("\n");
		for (const line of lines) {
			expect(line).not.toMatch(
				/artifact\.json[^\n]*(records|contains|includes|carries|has)[^\n]*commit/i,
			);
			expect(line).not.toMatch(/commit[^\n]*in `?artifact\.json/i);
		}
	});

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
		const listed = doc.match(/`artifact\.json`, whose fields are ([^.]*)\./);
		expect(listed).not.toBeNull();
		const documented = [...(listed?.[1] ?? "").matchAll(/`(\w+)`/g)].map(
			(m) => m[1],
		);
		expect(documented).toEqual(fields);
	});

	test("tags the exact recorded source commit, not a commit read from artifact.json", () => {
		const tag = section("### 6. Tag and create the GitHub baseline");
		expect(tag).toContain(
			"creates the annotated tag `v0.1.0` on the source commit recorded in step 2",
		);
		expect(tag).not.toMatch(/recorded in `artifact\.json`/);
	});
});

describe("docs/releasing.md owner-only repository bootstrap", () => {
	test("is marked owner-only and precedes publication", () => {
		const bootstrap = doc.indexOf(
			"## Owner-only: repository bootstrap and hosted CI",
		);
		const publish = doc.indexOf("## Owner-only: publish the accepted tarball");
		expect(bootstrap).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(bootstrap);
		expect(doc).toContain(
			"Every command and decision in this section belongs to the owner",
		);
	});

	test("orders create, remote, push to main, then hosted CI green", () => {
		const order = [
			"Owner creates the public repository `mihaellenic/opencode-providers-usage`",
			"Owner adds the remote",
			"Owner pushes the reviewed bootstrap source, including `ci.yml`, to `main`",
			"Owner confirms hosted CI is green on that exact commit",
		].map((phrase) => doc.indexOf(phrase));
		for (const index of order) expect(index).toBeGreaterThan(-1);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("requires SSH or a workflow-capable credential and notes the gh scope gap", () => {
		const bootstrap = section(
			"## Owner-only: repository bootstrap and hosted CI",
		);
		expect(bootstrap).toContain(
			"SSH, or a credential permitted to push workflow",
		);
		expect(bootstrap).toContain("lacks the `workflow` scope");
		expect(bootstrap).toContain("do not use it for this push");
	});

	test("requires hosted CI green on the exact source commit before publish", () => {
		expect(doc).toContain("Publication must not");
		expect(doc).toContain(
			"begin until hosted CI is green on the source commit",
		);
		const green = doc.indexOf("hosted CI is green on the source commit");
		const publish = doc.indexOf("npm publish <accepted-tarball>");
		expect(green).toBeGreaterThan(-1);
		expect(green).toBeLessThan(publish);
	});
});

describe("docs/releasing.md publication and verification", () => {
	test("publishes only the accepted tarball with interactive 2FA and no stored token", () => {
		expect(doc).toContain("npm publish <accepted-tarball> --access public");
		expect(pkg.publishConfig?.access).toBe("public");
		expect(doc.replace(/\s+/g, " ")).toContain("never repack the working tree");
		expect(doc).toContain(
			"completes\n  2FA when prompted, with no stored token",
		);
	});

	test("documents only flags that exist in the acceptance CLI", () => {
		const flags = documentedAcceptanceFlags();
		expect(flags).toEqual(["--output-dir", "--verify-published"]);
		for (const flag of flags) {
			expect(acceptanceSource).toContain(`"${flag}"`);
		}
	});

	test("verifies registry version and dist.integrity against the accepted integrity", () => {
		expect(doc).toContain(
			"bun scripts/release-acceptance.ts --verify-published <artifact.json>",
		);
		expect(doc).toContain("`dist.integrity`");
		expect(doc).toContain("exactly equal to the accepted `integrity`");
	});

	test("points post-publish smoke at docs/validation.md and that file exists", () => {
		expect(doc).toContain("[`docs/validation.md`](validation.md)");
		expect(existsSync(join(root, "docs/validation.md"))).toBe(true);
		expect(doc).toContain("bun load-check.mjs");
		expect(doc).toContain(
			"npm install --ignore-scripts opencode-providers-usage@0.1.0",
		);
		expect(doc).not.toMatch(/NPM_TOKEN|_authToken/);
	});

	test("states the bootstrap publish is not OIDC provenance, in that sentence", () => {
		expect(doc).toContain(
			"It does **not**\nproduce OIDC provenance, and the release report must not claim that it does.",
		);
	});
});

describe("docs/releasing.md tag, seeding, and recovery", () => {
	test("never moves a tag and never fabricates 0.0.0 history", () => {
		expect(doc).toContain("Do not reuse a tag; never move an existing tag.");
		expect(doc).toContain("never fabricate `0.0.0` history");
	});

	test("seeds the manifest only after the baseline and states Task 5 ownership", () => {
		const seeding = section("### 7. Seed release automation");
		expect(seeding).toContain('`{".": "0.1.0"}` only after steps 4');
		expect(seeding).toContain("This seeding is part of Task 5");
	});

	test("keeps failed publishes visible, immutable versions, and no automated unpublish", () => {
		const recovery = section("## Failure and recovery");
		expect(recovery).toContain(
			"do not bump the version and do not move\n  the tag",
		);
		expect(recovery).toContain("npm versions are immutable");
		expect(recovery).toContain("never automated unpublish");
		expect(recovery).toContain("deprecate the version");
	});
});

describe("docs/releasing.md later releases", () => {
	test("states release automation is not implemented and the manual flow applies until Task 5", () => {
		const later = section("## Later releases");
		expect(later).toContain("Release automation is not implemented yet.");
		expect(later).toContain("Until Task 5 is complete");
	});
});

describe("docs/releasing.md formatting", () => {
	test("keeps every line within 100 characters", () => {
		const long = doc.split("\n").filter((line) => line.length > 100);
		expect(long).toEqual([]);
	});
});

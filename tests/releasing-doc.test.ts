import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const doc = read("docs/releasing.md");
const flat = doc.replace(/\s+/g, " ");
const acceptanceSource = read("scripts/release-acceptance.ts");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
const validate = read(".github/workflows/validate-release-pr.yml");
const pkgText = read("package.json");
const pkg = JSON.parse(pkgText) as {
	publishConfig?: { access?: string };
	scripts?: Record<string, string>;
	repository?: { url?: string };
};
const releaseConfig = JSON.parse(read("release-please-config.json")) as {
	"bump-minor-pre-major"?: boolean;
};
const manifest = JSON.parse(read(".release-please-manifest.json")) as Record<
	string,
	string
>;

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

describe("docs/releasing.md automated flow and setup", () => {
	test("states that merging the release PR approves publication", () => {
		expect(flat).toContain(
			"Merging the release PR into `main` approves publication of that version.",
		);
		expect(flat).toContain("Do not merge it just to update the changelog.");
	});

	test("no longer describes the automation as future or unimplemented", () => {
		expect(doc).not.toContain("Task 5");
		expect(doc).not.toContain("not implemented");
		expect(doc).not.toMatch(/until release automation/i);
		expect(doc).not.toContain("## Later releases");
	});

	test("documents the owner-only setup steps", () => {
		const setup = section("## Setup");
		expect(setup).toContain("Owner-only");
		expect(setup).toContain(
			"Allow GitHub Actions to create and approve\n  pull requests",
		);
		expect(setup).toContain("`bun run setup`");
		expect(pkg.scripts?.setup).toContain("core.hooksPath");
	});

	test("the release workflow exists, publishes over OIDC, and the repo URL matches", () => {
		expect(pkg.repository?.url).toContain(
			"mihaellenic/opencode-providers-usage",
		);
		expect(existsSync(join(root, ".github/workflows/release.yml"))).toBe(true);
		expect(release).toContain("id-token: write");
	});

	test("never instructs storing an npm token", () => {
		expect(doc).toContain("Do not request, paste, or store token values");
		expect(doc).not.toMatch(/NPM_TOKEN|_authToken/);
		expect(doc).not.toContain("NODE_AUTH_TOKEN");
		expect(release).not.toContain("NODE_AUTH_TOKEN");
		expect(release).not.toContain("secrets.NPM");
	});

	test("pins Bun, Node, and npm to the values the workflows use", () => {
		expect(doc).toContain("| Bun | 1.4.4 |");
		expect(pkgText).toContain('"packageManager": "bun@1.4.4"');
		expect(ci).toContain("bun-version: 1.4.4");
		expect(release).toContain("bun-version: 1.4.4");
		expect(validate).toContain("bun-version: 1.4.4");
		// the doc names Node 24 as the release toolchain; both release workflows set it
		expect(doc).toContain("Node 24 is the release toolchain");
		expect(doc).toContain("| Node | 24 |");
		expect(release).toContain("node-version: 24");
		expect(validate).toContain("node-version: 24");
		expect(doc).toContain("| npm | 11.16.0 |");
		expect(release).toContain("npm install -g npm@11.16.0");
		expect(validate).toContain("npm install -g npm@11.16.0");
	});
});

describe("docs/releasing.md release PR review", () => {
	test("states the 0.x version policy the config encodes", () => {
		const review = section("## 1. Review and merge the release PR");
		expect(releaseConfig["bump-minor-pre-major"]).toBe(true);
		expect(flat).toContain(
			"while below 1.0, `feat` and breaking changes bump the minor version; `fix` bumps the patch version",
		);
		expect(review).toContain("[release-please-config.json]");
		expect(existsSync(join(root, "release-please-config.json"))).toBe(true);
	});

	test("names the validation check exactly as the workflow defines it", () => {
		const review = section("## 1. Review and merge the release PR");
		expect(review).toContain("**Validate release PR / release-pr-validation**");
		expect(validate).toContain("name: Validate release PR");
		expect(validate).toContain("name: release-pr-validation");
		expect(review).toContain("exact current\n   head");
	});

	test("an absent, pending, stale, or failed validation run is not success", () => {
		const review = section("## 1. Review and merge the release PR");
		expect(review).toContain(
			"An absent, pending, stale, or\n   failed run is not success.",
		);
	});

	test("covers bot-created PRs, the unenforced check, and rechecking the base", () => {
		const review = section("## 1. Review and merge the release PR");
		const text = review.replace(/\s+/g, " ");
		expect(text).toContain(
			"A PR created by a bot may not trigger the workflow",
		);
		expect(text).toContain("do not merge until the PR is validated");
		expect(text).toContain(
			"not an enforced required check unless the live branch rules say so",
		);
		expect(text).toContain("Recheck the current base and merge result");
		expect(text).toContain("read-only repository and PR permissions");
	});
});

describe("docs/releasing.md automated publication", () => {
	test("lists the publish steps in the order release.yml runs them", () => {
		const publication = section("## 2. Automated publication");
		const text = publication.replace(/\s+/g, " ");
		const order = [
			"Release Please creates the release tag and GitHub release.",
			"checks out that exact tag, not floating `main`",
			"sets up Node 24 and Bun 1.4.4",
			"`bun install --frozen-lockfile --ignore-scripts`",
			"runs fresh artifact acceptance",
			"uploads the evidence",
			"recomputes the tarball's sha512 integrity",
			"installs npm 11.16.0",
			"npm publish <accepted tarball> --access public",
			"--verify-published <artifact.json>",
		].map((phrase) => text.indexOf(phrase));
		for (const index of order) expect(index).toBeGreaterThan(-1);
		expect([...order].sort((a, b) => a - b)).toEqual(order);

		// the workflow runs the same steps in the same order
		const workflowOrder = [
			"googleapis/release-please-action",
			"steps.resolve.outputs.tag }}",
			"bun install --frozen-lockfile --ignore-scripts",
			"scripts/release-acceptance.ts --output-dir",
			"actions/upload-artifact",
			"actions/download-artifact",
			'npm publish "$tarball" --access public',
			"--verify-published",
		].map((phrase) => release.indexOf(phrase));
		for (const index of workflowOrder) expect(index).toBeGreaterThan(-1);
		expect([...workflowOrder].sort((a, b) => a - b)).toEqual(workflowOrder);
	});

	test("publishes only the accepted tarball over OIDC and never rebuilds it", () => {
		expect(pkg.publishConfig?.access).toBe("public");
		expect(flat).toContain("publishes only the accepted tarball");
		expect(flat).toContain("using OIDC trusted publishing");
		expect(flat).toContain(
			"never downloads or trusts the PR validator's artifact",
		);
		expect(release).toContain("artifact.json");
	});

	test("does not treat a GitHub release or green PR check as proof of publication", () => {
		expect(flat).toContain(
			"A GitHub release or a green PR check does not prove npm publication succeeded.",
		);
	});
});

describe("docs/releasing.md acceptance and security gates", () => {
	const gates = section("### Acceptance and security gates");

	test("explains the runtime and output-directory checks", () => {
		expect(gates).toContain("exactly Bun 1.4.4");
		expect(gates).toContain("`packageManager` and `engines.bun`");
		expect(gates).toContain("new or existing-empty");
		expect(gates).toContain("symlink");
		expect(gates).toContain("source repository");
	});

	test("describes the clean export, published-version refusal, one tarball, and consumer audit", () => {
		const text = gates.replace(/\s+/g, " ");
		expect(text).toContain("Exports the committed source with `git archive`");
		expect(text).toContain("Refuses an already-published version");
		expect(text).toContain("Packs exactly one tarball");
		expect(text).toContain(
			"Installs the tarball in a scratch production consumer",
		);
		expect(text).toContain("Audits that consumer's production tree");
		expect(text).toContain("not the repository");
		expect(text).toContain("High and critical advisories block acceptance");
		expect(text).toContain("fail closed");
	});

	test("lists the allowed tarball contents the acceptance script enforces", () => {
		for (const file of [
			"package.json",
			"README.md",
			"LICENSE",
			"index.js",
			"tui.js",
			"rpc.js",
		]) {
			expect(gates).toContain(`\`${file}\``);
			expect(acceptanceSource).toContain(`"package/${file}"`);
		}
		expect(gates.replace(/\s+/g, " ")).toContain("five export paths");
		expect(gates.replace(/\s+/g, " ")).toContain(
			"Resolution is not a GUI load test",
		);
		const bundles = acceptanceSource.match(/"package\/dist\/[^"]+"/g) ?? [];
		expect(bundles).toHaveLength(4);
		expect(gates.replace(/\s+/g, " ")).toContain("the four `dist/` bundles");
	});

	test("never claims artifact.json contains the source commit", () => {
		expect(doc).toMatch(/`artifact\.json` does not contain a commit/);
		for (const line of doc.split("\n")) {
			expect(line).not.toMatch(
				/artifact\.json[^\n]*(records|contains|includes|carries|has)[^\n]*commit/i,
			);
			expect(line).not.toMatch(/commit[^\n]*in `?artifact\.json/i);
		}
		expect(acceptanceSource).toContain("  commit:    ");
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
});

describe("docs/releasing.md evidence artifacts", () => {
	test("names both evidence artifacts and the 14-day retention the workflows set", () => {
		const evidence = section("### Evidence artifacts and retention");
		expect(evidence).toContain("`release-pr-evidence-<PR>-<attempt>`");
		expect(evidence).toContain("`release-evidence-<tag>`");
		expect(evidence).toContain("retained for 14 days");
		expect(validate).toContain("name: release-pr-evidence-");
		expect(validate).toContain("github.run_attempt }}");
		expect(release).toContain("name: release-evidence-");
		expect(validate).toContain("retention-days: 14");
		expect(release).toContain("retention-days: 14");
		expect(evidence).toContain("`head-status.json`");
	});
});

describe("docs/releasing.md post-publish checks", () => {
	const post = section("## 3. Optional owner-run post-publish checks");

	test("states host smoke is not a publish gate and claims are not widened", () => {
		const text = post.replace(/\s+/g, " ");
		expect(text).toContain("They are not a publish gate");
		expect(text).toContain("Host smoke tests are not a publish gate");
		expect(text).toContain("do not widen the support or validation claims");
		expect(text).toContain("unavailable checks remain unverified");
		expect(doc).not.toMatch(/required before publication/i);
	});

	test("links to files that exist", () => {
		expect(doc).toContain("[docs/validation.md](validation.md)");
		expect(doc).toContain("[docs/support.md](support.md)");
		expect(doc).toContain("[README](../README.md)");
		for (const path of ["docs/validation.md", "docs/support.md", "README.md"]) {
			expect(existsSync(join(root, path))).toBe(true);
		}
	});

	test("keeps the registry load check aligned with the acceptance consumer install", () => {
		expect(doc).toContain("bun load-check.mjs");
		expect(doc).toContain("npm pkg set overrides.solid-js=1.9.18");
		expect(doc).toContain("single locked `solid-js@1.9.18`");
		expect(doc).not.toContain("overrides.seroval");
		expect(doc).not.toContain("solid-js=1.9.12");
		expect(doc).not.toContain("@opentui/core@0.6.8");
		expect(doc).not.toContain("@opencode/theme@2.2.0");
		expect(doc).not.toContain("@opencode/theme@2.1.4");
		expect(doc).toContain(
			"@opencode/theme@2.2.5 @opentui/core@0.8.0 @opentui/solid@0.8.0 solid-js@1.9.18",
		);
		expect(doc).toContain(
			"npm install --ignore-scripts opencode-providers-usage@X.Y.Z",
		);
		expect(doc).toContain('"opencode-providers-usage/gui-experimental"');
		expect(post.replace(/\s+/g, " ")).toContain(
			"resolution is not a GUI load test",
		);
	});
});

describe("docs/releasing.md failure and recovery", () => {
	const recovery = section("## Failure and recovery");
	const text = recovery.replace(/\s+/g, " ");

	test("treats publish errors as ambiguous and verifies before any retry", () => {
		expect(text).toContain("A publish error is ambiguous.");
		expect(text).toContain(
			"bun scripts/release-acceptance.ts --verify-published <artifact.json>",
		);
		expect(text).toContain("preserved `artifact.json`");
		expect(text).toContain("do not republish");
		expect(text).toContain("`dist.integrity`");
		expect(text).toContain("exactly equal to the accepted `integrity`");
		expect(text).toContain("Never retry blindly.");
		expect(text).toContain("same accepted tarball");
		expect(text).toMatch(/auth[\s\S]*network[\s\S]*malformed[\s\S]*mismatch/i);
	});

	test("treats E404 only as a signal needing independent confirmation", () => {
		expect(text).toContain(
			"**E404** (version not found): this is only a signal.",
		);
		expect(text).toContain("independently confirm");
	});

	test("never bumps the version, moves the tag, or unpublishes automatically", () => {
		expect(recovery).toContain(
			"do not bump the version and do not move the\n  tag",
		);
		expect(text).toMatch(/never[^.]*bump the version/i);
		expect(text).toMatch(/never[^.]*move the tag/i);
		expect(text).toMatch(/never[^.]*unpublish/i);
		expect(text).toContain("Do not reuse a tag; never move an existing tag.");
		expect(text).toContain("npm versions are immutable");
		expect(text).toContain("fix-forward");
		expect(text).toContain("never automated unpublish");
		expect(text).toContain("deprecate the version");
	});

	test("recovers a failed publication through workflow_dispatch with an existing release tag", () => {
		expect(text).toContain("Actions → Release → Run workflow");
		expect(text).toContain("`release_tag`");
		expect(text).toContain("existing `vX.Y.Z`");
		expect(text).toContain("non-draft GitHub release");
		expect(text).toContain(
			"only after confirming the version is not on the registry",
		);
		expect(text).toContain("**Use workflow from** set to `main`");
		expect(release).toContain("github.ref == 'refs/heads/main'");
		expect(release).toContain("workflow_dispatch:");
		expect(release).toContain("release_tag:");
		expect(release).toContain('test "$draft" = "false"');
	});
});

describe("docs/releasing.md history", () => {
	const history = section("## History");
	const text = history.replace(/\s+/g, " ");

	test("states 0.1.0 was published manually without OIDC provenance", () => {
		expect(text).toContain(
			"`0.1.0` was published manually by the owner with interactive 2FA.",
		);
		expect(history).toContain(
			"That bootstrap publish\ndid **not** produce OIDC provenance, and the release report must not claim that it did.",
		);
	});

	test("records the manifest seeding after the baseline and never fabricates 0.0.0", () => {
		expect(text).toContain(
			"The tag `v0.1.0` and its GitHub release existed first",
		);
		expect(text).toContain("was seeded at `0.1.0` after that baseline");
		// History is fixed text; the live manifest moves with each release PR.
		expect(manifest["."]).toMatch(/^0\.\d+\.\d+$/);
		expect(text).toContain("never fabricate `0.0.0` history");
	});
});

describe("docs/releasing.md formatting", () => {
	test("keeps every line within 100 characters", () => {
		const long = doc.split("\n").filter((line) => line.length > 100);
		expect(long).toEqual([]);
	});
});

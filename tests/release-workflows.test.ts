import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobBlock, OPEN_EXPR, read, runBlock } from "./workflow-helpers";

describe("release-please config", () => {
	const manifest = JSON.parse(read(".release-please-manifest.json"));

	// The release PR bumps the manifest, so pin its shape, not a version.
	test("tracks a single root package at a 0.x version", () => {
		expect(Object.keys(manifest)).toEqual(["."]);
		expect(manifest["."]).toMatch(/^0\.\d+\.\d+$/);
	});
});

const release = read(".github/workflows/release.yml");

describe("release workflow triggers and permissions", () => {
	const header = release.slice(0, release.indexOf("\njobs:\n"));

	test("runs on pushes to main and manual recovery dispatch only", () => {
		expect(release.startsWith("name: Release\n")).toBe(true);
		expect(header).toContain(
			"on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      release_tag:",
		);
		expect(header).toContain("        required: true\n        type: string\n");
		for (const forbidden of [
			"pull_request",
			"pull_request_target",
			"workflow_run",
			"schedule:",
		]) {
			expect(release).not.toContain(forbidden);
		}
	});

	test("serializes releases without cancelling an in-flight publish", () => {
		expect(release).toContain(
			"concurrency:\n  group: release\n  cancel-in-progress: false\n",
		);
	});

	test("grants write scopes only to the release-please job", () => {
		const releasePlease = jobBlock(release, "release-please");
		const accept = jobBlock(release, "accept");
		const publish = jobBlock(release, "publish");
		expect(releasePlease).toContain(
			"permissions:\n      contents: write\n      issues: write\n      pull-requests: write\n",
		);
		expect(releasePlease).toContain("if: github.event_name == 'push'");
		for (const job of [accept, publish]) {
			expect(job).not.toContain("contents: write");
			expect(job).not.toContain("issues: write");
			expect(job).not.toContain("pull-requests: write");
		}
		expect(release.match(/contents: write/g)?.length).toBe(1);
	});

	test("runs release-please with the committed config and manifest", () => {
		const releasePlease = jobBlock(release, "release-please");
		expect(releasePlease).toContain(
			"uses: googleapis/release-please-action@v5",
		);
		expect(releasePlease).toContain("config-file: release-please-config.json");
		expect(releasePlease).toContain(
			"manifest-file: .release-please-manifest.json",
		);
		expect(releasePlease).toContain(
			`release_created: ${OPEN_EXPR} steps.release.outputs.release_created }}`,
		);
		expect(releasePlease).toContain(
			`tag_name: ${OPEN_EXPR} steps.release.outputs.tag_name }}`,
		);
	});

	test("publishes only after a created release or an explicit dispatch", () => {
		const accept = jobBlock(release, "accept");
		const publish = jobBlock(release, "publish");
		const trigger =
			"((github.event_name == 'push' && needs.release-please.outputs.release_created == 'true') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))";
		expect(accept).toContain("needs: release-please\n");
		expect(accept).toContain(`if: always() && ${trigger}\n`);
		expect(publish).toContain("needs: [release-please, accept]\n");
		expect(publish).toContain(
			`if: always() && needs.accept.result == 'success' && ${trigger}\n`,
		);
		expect(publish).toContain(
			"if: always() && needs.accept.result == 'success' && ((github.event_name == 'push' && needs.release-please.outputs.release_created == 'true') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))",
		);
	});

	test("never publishes from a dispatch started on a non-main ref", () => {
		// A branch copy of this workflow would carry id-token: write.
		for (const name of ["accept", "publish"]) {
			const condition = jobBlock(release, name)
				.split("\n")
				.find((line) => line.trim().startsWith("if:"));
			expect(condition).toBeDefined();
			const dispatchClause = condition?.split("||").pop() ?? "";
			expect(dispatchClause).toContain(
				"github.event_name == 'workflow_dispatch'",
			);
			expect(dispatchClause).toContain("github.ref == 'refs/heads/main'");
			expect(condition?.match(/workflow_dispatch/g)).toHaveLength(1);
		}
	});
});

describe("release workflow forbidden constructs", () => {
	test("has no token credentials, bypasses, retries or registry rollbacks", () => {
		for (const forbidden of [
			"NPM_TOKEN",
			"NODE_AUTH_TOKEN",
			"secrets.",
			".npmrc",
			"continue-on-error",
			"|| true",
			"npm unpublish",
			"npm deprecate",
			"pull_request_target",
			"--provenance",
		]) {
			expect(release, forbidden).not.toContain(forbidden);
		}
		expect(release).not.toMatch(/\b(?:for|while|until)\b[^\n]*\bdo\b/);
		expect(release).not.toMatch(/\bretry\b|nick-fields|wretry/i);
	});
});

describe("release workflow accept job", () => {
	const accept = jobBlock(release, "accept");

	test("has no publishing capability", () => {
		expect(accept).not.toContain("id-token");
		expect(accept).not.toContain("npm publish");
		expect(accept).not.toContain("npm install -g");
		expect(accept).not.toContain("--verify-published");
	});

	test("checks out the exact resolved tag and verifies it", () => {
		expect(accept).toContain(`ref: ${OPEN_EXPR} steps.resolve.outputs.tag }}`);
		expect(accept).toContain(
			"actual_tag=$(git describe --tags --exact-match HEAD)",
		);
		expect(accept).toContain('test "$actual_tag" = "$RELEASE_TAG"');
		expect(accept).toContain(`test "$version" = "$` + `{RELEASE_TAG#v}"`);
	});

	test("exports the resolved tag and accepted commit to the publisher", () => {
		expect(accept).toContain(`tag: ${OPEN_EXPR} steps.resolve.outputs.tag }}`);
		expect(accept).toContain(`sha: ${OPEN_EXPR} steps.verify.outputs.sha }}`);
		expect(accept).toContain(
			'echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"',
		);
	});

	test("runs the full gate and acceptance with the shared artifact dir", () => {
		for (const command of [
			"bun install --frozen-lockfile --ignore-scripts",
			"run: bun run test\n",
			"run: bun run lint\n",
			"run: bun run typecheck\n",
			"run: bun run build\n",
		]) {
			expect(accept, command).toContain(command);
		}
		expect(accept).toContain(`SCRATCH_ROOT: ${OPEN_EXPR} runner.temp }}\n`);
		expect(accept).toContain(
			`ARTIFACT_DIR: ${OPEN_EXPR} runner.temp }}/providers-usage-release\n`,
		);
		expect(accept).toContain(
			'run: bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"',
		);
	});

	test("preserves evidence even when acceptance fails", () => {
		const start = accept.indexOf("name: Preserve acceptance evidence");
		const step = accept.slice(start);
		expect(start).toBeGreaterThan(accept.indexOf("--output-dir"));
		expect(step).toContain("if: always()");
		expect(step).toContain("uses: actions/upload-artifact@v7");
		expect(step).toContain(
			`name: release-evidence-${OPEN_EXPR} steps.resolve.outputs.tag }}`,
		);
		expect(step).toContain(
			`path: ${OPEN_EXPR} runner.temp }}/providers-usage-release`,
		);
		expect(step).toContain("if-no-files-found: warn");
		expect(step).toContain("retention-days: 14");
	});

	test("orders every gate before the evidence upload", () => {
		const markers = [
			"name: Resolve release ref",
			"uses: actions/checkout@v7",
			"name: Verify the checked-out tag and package version",
			"bun install --frozen-lockfile --ignore-scripts",
			"run: bun run test\n",
			"run: bun run lint\n",
			"run: bun run typecheck\n",
			"run: bun run build\n",
			"bun scripts/release-acceptance.ts --output-dir",
			"uses: actions/upload-artifact@v7",
		];
		const positions = markers.map((marker) => accept.indexOf(marker));
		for (const [index, position] of positions.entries()) {
			expect(position, markers[index]).toBeGreaterThan(-1);
		}
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(new Set(positions).size).toBe(positions.length);
	});
});

describe("release workflow publish job", () => {
	const publish = jobBlock(release, "publish");

	test("checks out the accepted commit, not a re-resolved tag", () => {
		expect(publish).toContain(`ref: ${OPEN_EXPR} needs.accept.outputs.sha }}`);
		expect(publish).not.toContain("steps.resolve");
		expect(publish).not.toContain("gh api");
	});

	test("installs nothing and runs no repo gate", () => {
		for (const forbidden of [
			"bun install",
			"bun run ",
			"npm ci",
			"npm install\n",
			"--output-dir",
			"actions/upload-artifact",
		]) {
			expect(publish, forbidden).not.toContain(forbidden);
		}
		expect(release.match(/bun install/g)?.length).toBe(1);
		expect(publish.match(/scripts\/release-acceptance\.ts/g)?.length).toBe(1);
	});

	test("downloads the accepted artifact and checks its integrity first", () => {
		expect(publish).toContain("uses: actions/download-artifact@v8");
		expect(publish).toContain(
			`name: release-evidence-${OPEN_EXPR} needs.accept.outputs.tag }}`,
		);
		expect(publish).toContain(
			`path: ${OPEN_EXPR} runner.temp }}/providers-usage-release`,
		);
		const verify = publish.indexOf(
			"name: Verify the accepted tarball integrity",
		);
		expect(verify).toBeGreaterThan(publish.indexOf("download-artifact"));
		expect(verify).toBeLessThan(publish.indexOf("npm publish"));
		const step = publish.slice(
			verify,
			publish.indexOf("uses: actions/setup-node"),
		);
		expect(step).toContain('createHash("sha512")');
		expect(step).toContain("meta.integrity");
		expect(step).toContain("process.exit(1)");
	});

	test("publishes exactly the accepted tarball once, without a token", () => {
		expect(release.match(/npm publish/g)?.length).toBe(1);
		const start = publish.indexOf("name: Publish the accepted tarball");
		const step = publish.slice(
			start,
			publish.indexOf("- name: Verify published integrity"),
		);
		expect(step).toContain(
			`ARTIFACT_DIR: ${OPEN_EXPR} runner.temp }}/providers-usage-release\n`,
		);
		expect(step).toContain(
			`filename=$(node -p 'require(process.env.ARTIFACT_DIR + "/artifact.json").filename')`,
		);
		expect(step).toContain('tarball="$ARTIFACT_DIR/$filename"');
		expect(step).toContain('test -f "$tarball"');
		expect(step).toContain('npm publish "$tarball" --access public\n');
		expect(step.indexOf('test -f "$tarball"')).toBeLessThan(
			step.indexOf("npm publish"),
		);
	});

	test("verifies the published package after publishing", () => {
		const start = publish.indexOf("name: Verify published integrity");
		const step = publish.slice(start);
		expect(step).toContain(
			'run: bun scripts/release-acceptance.ts --verify-published "$ARTIFACT_DIR/artifact.json"',
		);
		expect(start).toBeGreaterThan(publish.indexOf("npm publish"));
	});
});

describe("release workflow tag resolution behaviour", () => {
	const repository = "mihaellenic/opencode-providers-usage";
	const scratch: string[] = [];

	afterEach(() => {
		for (const dir of scratch.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	type Resolve = {
		eventName: "push" | "workflow_dispatch";
		releaseTag?: string;
		dispatchTag?: string;
		release?: unknown;
	};

	function resolve(options: Resolve) {
		const dir = mkdtempSync(join(tmpdir(), "release-resolve-"));
		scratch.push(dir);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const gh = join(bin, "gh");
		writeFileSync(
			gh,
			[
				"#!/bin/sh",
				'echo "$@" >> "$GH_CALLS"',
				'exec cat "$GH_FIXTURE"',
				"",
			].join("\n"),
		);
		chmodSync(gh, 0o755);
		const fixture = join(dir, "release.json");
		writeFileSync(fixture, JSON.stringify(options.release ?? {}));
		const output = join(dir, "github-output");
		writeFileSync(output, "");
		const calls = join(dir, "gh-calls");
		writeFileSync(calls, "");

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) env[key] = value;
		}
		Object.assign(env, {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			GH_FIXTURE: fixture,
			GH_CALLS: calls,
			GITHUB_OUTPUT: output,
			GITHUB_REPOSITORY: repository,
			GH_TOKEN: "test-token",
			EVENT_NAME: options.eventName,
			DISPATCH_TAG: options.dispatchTag ?? "",
			RELEASE_TAG: options.releaseTag ?? "",
		});

		const result = spawnSync(
			"bash",
			["-c", runBlock(release, "Resolve release ref")],
			{ cwd: dir, env, encoding: "utf8" },
		);
		return {
			exitCode: result.status ?? -1,
			stderr: result.stderr ?? "",
			output: readFileSync(output, "utf8"),
			calls: readFileSync(calls, "utf8"),
		};
	}

	const published = (tag: string, overrides: Record<string, unknown> = {}) => ({
		tag_name: tag,
		draft: false,
		...overrides,
	});

	test("accepts a push release tag and writes it to the step output", () => {
		const run = resolve({ eventName: "push", releaseTag: "v1.2.3" });
		expect(run.exitCode).toBe(0);
		expect(run.output).toBe("tag=v1.2.3\n");
		expect(run.calls).toBe("");
	});

	const invalid = [
		["main", "main"],
		["a truncated version", "v1.2"],
		["a prerelease suffix", "v1.2.3-rc1"],
		["an empty tag", ""],
		["a path traversal prefix", "../v1.2.3"],
		["a missing v prefix", "1.2.3"],
		["trailing text", "v1.2.3 extra"],
		["a trailing newline", "v1.2.3\nmain"],
	] as const;

	for (const [name, tag] of invalid) {
		test(`rejects ${name} from a push release`, () => {
			const run = resolve({ eventName: "push", releaseTag: tag });
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toBe("");
		});

		test(`rejects ${name} from a dispatch before calling the API`, () => {
			const run = resolve({
				eventName: "workflow_dispatch",
				dispatchTag: tag,
				release: published("v1.2.3"),
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toBe("");
			expect(run.calls).toBe("");
		});
	}

	test("ignores the release-please tag when dispatching manually", () => {
		const run = resolve({
			eventName: "workflow_dispatch",
			dispatchTag: "v1.2.3",
			releaseTag: "not-a-tag",
			release: published("v1.2.3"),
		});
		expect(run.exitCode).toBe(0);
		expect(run.output).toBe("tag=v1.2.3\n");
	});

	test("accepts a dispatch for a published non-draft release", () => {
		const run = resolve({
			eventName: "workflow_dispatch",
			dispatchTag: "v1.2.3",
			release: published("v1.2.3"),
		});
		expect(run.exitCode).toBe(0);
		expect(run.output).toBe("tag=v1.2.3\n");
		expect(run.calls.trim()).toBe(
			`api repos/${repository}/releases/tags/v1.2.3`,
		);
	});

	test("rejects a dispatch for a draft release", () => {
		const run = resolve({
			eventName: "workflow_dispatch",
			dispatchTag: "v1.2.3",
			release: published("v1.2.3", { draft: true }),
		});
		expect(run.exitCode).not.toBe(0);
		expect(run.output).toBe("");
	});

	test("rejects a dispatch when the release reports a different tag", () => {
		const run = resolve({
			eventName: "workflow_dispatch",
			dispatchTag: "v1.2.3",
			release: published("v9.9.9"),
		});
		expect(run.exitCode).not.toBe(0);
		expect(run.output).toBe("");
	});

	test("rejects a dispatch when the release response lacks draft or tag", () => {
		for (const release of [{}, { tag_name: "v1.2.3" }, { draft: false }]) {
			const run = resolve({
				eventName: "workflow_dispatch",
				dispatchTag: "v1.2.3",
				release,
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toBe("");
		}
	});
});

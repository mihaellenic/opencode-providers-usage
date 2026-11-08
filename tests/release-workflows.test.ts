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
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Built without a literal dollar-brace so Biome does not flag GitHub expression text.
const OPEN_EXPR = `\${{`;
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("release-please config", () => {
	const config = JSON.parse(read("release-please-config.json"));
	const manifest = JSON.parse(read(".release-please-manifest.json"));

	test("releases a node package and bumps minor while pre-1.0", () => {
		expect(config["release-type"]).toBe("node");
		expect(config["bump-minor-pre-major"]).toBe(true);
	});

	test("manages the root package with plain vX.Y.Z tags", () => {
		expect(Object.keys(config.packages)).toEqual(["."]);
		expect(config.packages["."]["package-name"]).toBe(
			"opencode-providers-usage",
		);
		expect(config.packages["."]["include-component-in-tag"]).toBe(false);
	});

	// The release PR bumps the manifest, so pin its shape, not a version.
	test("tracks a single root package at a 0.x version", () => {
		expect(Object.keys(manifest)).toEqual(["."]);
		expect(manifest["."]).toMatch(/^0\.\d+\.\d+$/);
	});
});

/** Extract a top-level job block so assertions cannot match another job. */
function jobBlock(source: string, name: string): string {
	const marker = `\n  ${name}:\n`;
	const start = source.indexOf(marker);
	if (start === -1) throw new Error(`job ${name} not found`);
	const rest = source.slice(start + marker.length);
	const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/);
	return next === -1 ? rest : rest.slice(0, next);
}

/** Collect `run:` bodies, single-line or block scalar, so shell can be inspected. */
function runBlocks(source: string): string[] {
	const blocks: string[] = [];
	let current: string[] | undefined;
	let blockIndent = 0;
	for (const line of source.split("\n")) {
		if (current === undefined) {
			const match = /^(\s*)(?:-\s+)?run: \|\s*$/.exec(line);
			if (match) {
				current = [];
				blockIndent = match[1]?.length ?? 0;
				continue;
			}
			const single = /^(\s*)(?:-\s+)?run:\s+(.+)$/.exec(line);
			if (single?.[2]) blocks.push(single[2]);
			continue;
		}
		if (line.trim() === "") {
			current.push(line);
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent <= blockIndent) {
			blocks.push(current.join("\n"));
			current = undefined;
		} else {
			current.push(line);
		}
	}
	if (current !== undefined) blocks.push(current.join("\n"));
	return blocks;
}

/** Extract a named step's inline shell body so it can run without a GitHub runner. */
function runBlock(source: string, stepName: string): string {
	const lines = source.split("\n");
	const stepIndex = lines.findIndex(
		(line) => line.trim() === `- name: ${stepName}`,
	);
	if (stepIndex === -1) throw new Error(`step ${stepName} not found`);
	const first = lines[stepIndex] as string;
	const stepIndent = first.length - first.trimStart().length;
	let stepEnd = lines.length;
	for (let index = stepIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] as string;
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		if (indent === stepIndent && line.trimStart().startsWith("- ")) {
			stepEnd = index;
			break;
		}
	}
	const step = lines.slice(stepIndex, stepEnd);
	const runIndex = step.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
	if (runIndex === -1)
		throw new Error(`step ${stepName} has no multi-line run body`);
	const runLine = step[runIndex] as string;
	const runIndent = runLine.length - runLine.trimStart().length;
	const body: string[] = [];
	for (let index = runIndex + 1; index < step.length; index += 1) {
		const line = step[index] as string;
		if (line.trim() === "") {
			body.push("");
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent <= runIndent) break;
		body.push(line.slice(runIndent + 2));
	}
	return body.join("\n").trimEnd();
}

const release = read(".github/workflows/release.yml");

describe("release workflow triggers and permissions", () => {
	const header = release.slice(0, release.indexOf("\njobs:\n"));
	const topLevel = release.slice(0, release.indexOf("\nconcurrency:"));

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

	test("defaults the workflow to read-only repository access", () => {
		expect(topLevel).toContain("\npermissions:\n  contents: read\n");
		expect(topLevel).not.toContain("write");
		expect(topLevel).not.toContain("id-token");
	});

	test("serializes releases without cancelling an in-flight publish", () => {
		expect(release).toContain(
			"concurrency:\n  group: release\n  cancel-in-progress: false\n",
		);
	});

	test("grants write scopes only to the release-please job", () => {
		const releasePlease = jobBlock(release, "release-please");
		const publish = jobBlock(release, "publish");
		expect(releasePlease).toContain(
			"permissions:\n      contents: write\n      issues: write\n      pull-requests: write\n",
		);
		expect(releasePlease).toContain("if: github.event_name == 'push'");
		expect(publish).not.toContain("contents: write");
		expect(publish).not.toContain("issues: write");
		expect(publish).not.toContain("pull-requests: write");
		expect(release.match(/contents: write/g)?.length).toBe(1);
	});

	test("grants id-token write only to the publish job", () => {
		const releasePlease = jobBlock(release, "release-please");
		const publish = jobBlock(release, "publish");
		expect(release.match(/id-token/g)?.length).toBe(1);
		expect(releasePlease).not.toContain("id-token");
		expect(publish).toContain(
			"permissions:\n      contents: read\n      id-token: write\n",
		);
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
		const publish = jobBlock(release, "publish");
		expect(publish).toContain("needs: release-please");
		expect(publish).toContain(
			"if: always() && ((github.event_name == 'push' && needs.release-please.outputs.release_created == 'true') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))",
		);
	});

	test("never publishes from a dispatch started on a non-main ref", () => {
		// A branch copy of this workflow would carry id-token: write.
		const condition = jobBlock(release, "publish")
			.split("\n")
			.find((line) => line.trim().startsWith("if:"));
		expect(condition).toBeDefined();
		const dispatchClause = condition?.split("||").pop() ?? "";
		expect(dispatchClause).toContain(
			"github.event_name == 'workflow_dispatch'",
		);
		expect(dispatchClause).toContain("github.ref == 'refs/heads/main'");
		expect(condition?.match(/workflow_dispatch/g)).toHaveLength(1);
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

	test("has no shell that interpolates event or input context", () => {
		const blocks = runBlocks(release);
		expect(blocks.length).toBeGreaterThan(5);
		for (const block of blocks) expect(block).not.toContain(OPEN_EXPR);
	});

	test("checks out without persisting credentials", () => {
		const publish = jobBlock(release, "publish");
		expect(publish).toContain("uses: actions/checkout@v7");
		expect(publish).toContain("persist-credentials: false");
	});
});

describe("release workflow publish job", () => {
	const publish = jobBlock(release, "publish");

	test("pins the runtimes used to publish", () => {
		expect(publish).toContain("uses: actions/setup-node@v7");
		expect(publish).toContain("node-version: 24");
		expect(publish).toContain("package-manager-cache: false");
		expect(publish).toContain("npm install -g npm@11.16.0");
		expect(publish).toContain('test "$(npm --version)" = "11.16.0"');
		expect(publish).toContain("uses: oven-sh/setup-bun@v2");
		expect(publish).toContain("bun-version: 1.4.4");
	});

	test("checks out the exact resolved tag and verifies it", () => {
		expect(publish).toContain(`ref: ${OPEN_EXPR} steps.resolve.outputs.tag }}`);
		expect(publish).toContain(
			"actual_tag=$(git describe --tags --exact-match HEAD)",
		);
		expect(publish).toContain('test "$actual_tag" = "$RELEASE_TAG"');
		expect(publish).toContain(`test "$version" = "$` + `{RELEASE_TAG#v}"`);
	});

	test("runs the full gate and acceptance with the shared artifact dir", () => {
		for (const command of [
			"bun install --frozen-lockfile --ignore-scripts",
			"run: bun run test\n",
			"run: bun run lint\n",
			"run: bun run typecheck\n",
			"run: bun run build\n",
		]) {
			expect(publish, command).toContain(command);
		}
		expect(publish).toContain(`SCRATCH_ROOT: ${OPEN_EXPR} runner.temp }}\n`);
		expect(publish).toContain(
			`ARTIFACT_DIR: ${OPEN_EXPR} runner.temp }}/providers-usage-release\n`,
		);
		expect(publish).toContain(
			'run: bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"',
		);
	});

	test("preserves evidence even when acceptance fails", () => {
		const start = publish.indexOf("name: Preserve acceptance evidence");
		const step = publish.slice(
			start,
			publish.indexOf("- name: Publish", start),
		);
		expect(step).toContain("if: always()");
		expect(step).toContain("uses: actions/upload-artifact@v7");
		expect(step).toContain(
			`name: release-evidence-${OPEN_EXPR} steps.resolve.outputs.tag }}`,
		);
		expect(step).toContain("if-no-files-found: warn");
		expect(step).toContain("retention-days: 14");
	});

	test("orders every gate before the one-shot publish", () => {
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
			"npm publish",
			"bun scripts/release-acceptance.ts --verify-published",
		];
		const positions = markers.map((marker) => publish.indexOf(marker));
		for (const [index, position] of positions.entries()) {
			expect(position, markers[index]).toBeGreaterThan(-1);
		}
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(new Set(positions).size).toBe(positions.length);
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
			`tarball=$(node -p 'require(process.env.ARTIFACT_DIR + "/artifact.json").path')`,
		);
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

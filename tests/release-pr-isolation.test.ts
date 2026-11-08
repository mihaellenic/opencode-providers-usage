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
const workflowPath = join(root, ".github/workflows/validate-release-pr.yml");
const workflow = readFileSync(workflowPath, "utf8");

const repository = "mihaellenic/opencode-providers-usage";
const releaseRef = "release-please--branches--main";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const movedSha = "c".repeat(40);

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

type PullOverrides = {
	state?: string;
	baseRef?: string;
	baseSha?: string;
	headRef?: string;
	headSha?: string;
	headRepo?: string;
};

function pullRequest(overrides: PullOverrides = {}) {
	return {
		number: 1,
		state: overrides.state ?? "open",
		base: {
			ref: overrides.baseRef ?? "main",
			sha: overrides.baseSha ?? baseSha,
		},
		head: {
			ref: overrides.headRef ?? releaseRef,
			sha: overrides.headSha ?? headSha,
			repo: { full_name: overrides.headRepo ?? repository },
		},
	};
}

function identityEnv(overrides: Record<string, string | undefined> = {}) {
	return {
		GITHUB_REPOSITORY: repository,
		PR: "1",
		HEAD_SHA: headSha,
		EVENT_HEAD_REPO: repository,
		EVENT_HEAD_REF: releaseRef,
		EVENT_BASE_REF: "main",
		...overrides,
	};
}

function freshnessEnv(overrides: Record<string, string | undefined> = {}) {
	return {
		GITHUB_REPOSITORY: repository,
		GH_TOKEN: "test-token",
		PR: "1",
		HEAD_SHA: headSha,
		...overrides,
	};
}

type StepOptions = {
	pull?: unknown;
	pullRaw?: string;
	env?: Record<string, string | undefined>;
	ghFails?: boolean;
	artifactFiles?: Record<string, string>;
};

type StepRun = {
	exitCode: number;
	stdout: string;
	stderr: string;
	output: string;
	summary: string;
	dir: string;
};

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runStep(stepName: string, options: StepOptions = {}): StepRun {
	const dir = mkdtempSync(join(tmpdir(), "release-pr-isolation-"));
	scratch.push(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const gh = join(bin, "gh");
	writeFileSync(
		gh,
		[
			"#!/bin/sh",
			`if [ "$` + `{GH_FIXTURE_FAIL:-0}" = "1" ]; then`,
			'  echo "gh: fixture failure" >&2',
			"  exit 1",
			"fi",
			'exec cat "$GH_FIXTURE"',
			"",
		].join("\n"),
	);
	chmodSync(gh, 0o755);

	const fixture = join(dir, "pull.json");
	writeFileSync(
		fixture,
		options.pullRaw ?? JSON.stringify(options.pull ?? pullRequest(), null, 2),
	);
	const output = join(dir, "github-output");
	writeFileSync(output, "");
	const summary = join(dir, "github-summary");
	writeFileSync(summary, "");
	const artifactDir = join(dir, "artifact");
	mkdirSync(artifactDir);
	for (const [name, content] of Object.entries(options.artifactFiles ?? {})) {
		writeFileSync(join(artifactDir, name), content);
	}

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		...process.env,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		GH_FIXTURE: fixture,
		GH_FIXTURE_FAIL: options.ghFails ? "1" : "0",
		GITHUB_OUTPUT: output,
		GITHUB_STEP_SUMMARY: summary,
		ARTIFACT_DIR: artifactDir,
		...options.env,
	})) {
		if (value !== undefined) env[key] = value;
	}

	const result = spawnSync("bash", ["-c", runBlock(workflow, stepName)], {
		cwd: dir,
		env,
		encoding: "utf8",
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		output: readFileSync(output, "utf8"),
		summary: readFileSync(summary, "utf8"),
		dir,
	};
}

function outputs(run: StepRun): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (const line of run.output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0)
			parsed[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return parsed;
}

function headStatus(run: StepRun) {
	return JSON.parse(
		readFileSync(join(run.dir, "artifact", "head-status.json"), "utf8"),
	) as {
		expected_sha: string;
		observed_sha: string | null;
		pr_state: string | null;
		outcome: string;
	};
}

const precheck = "Validate PR identity through the GitHub API";
const freshness = "Verify current PR head";
const evidence = "Require accepted evidence";
const summaryStep = "Summarize validation and acceptance evidence";

describe("release PR workflow static isolation", () => {
	const header = workflow.slice(0, workflow.indexOf("\njobs:\n"));
	const validate = jobBlock(workflow, "validate");

	test("runs only on pull_request events targeting main", () => {
		expect(workflow.startsWith("name: Validate release PR\n")).toBe(true);
		expect(header).toContain(
			"on:\n  pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened]\n",
		);
		for (const forbidden of [
			"pull_request_target",
			"workflow_run",
			"workflow_dispatch",
			"schedule:",
			"push:",
		]) {
			expect(workflow, forbidden).not.toContain(forbidden);
		}
	});

	test("defaults the workflow to read-only repository access", () => {
		expect(header).toContain("\npermissions:\n  contents: read\n");
		expect(header).not.toContain("write");
		expect(header).not.toContain("id-token");
	});

	test("grants the job only contents and pull-requests read", () => {
		expect(validate).toContain(
			"    permissions:\n      contents: read\n      pull-requests: read\n    steps:\n",
		);
		expect(workflow.match(/^\s*permissions:/gm)?.length).toBe(2);
		expect(workflow.match(/^\s+[a-z-]+: (?:read|write|none)$/gm)).toEqual([
			"  contents: read",
			"      contents: read",
			"      pull-requests: read",
		]);
	});

	test("has no id-token or write scope anywhere", () => {
		expect(workflow).not.toContain("id-token");
		expect(workflow).not.toMatch(/^\s+[a-z-]+: write\s*$/m);
		expect(workflow).not.toContain("write-all");
		expect(workflow).not.toContain("contents: write");
		expect(workflow).not.toContain("pull-requests: write");
		expect(workflow).not.toContain("issues: write");
		expect(workflow).not.toContain("packages: write");
		expect(workflow).not.toContain("actions: write");
	});

	test("has no credentials, bypasses or publishing", () => {
		for (const forbidden of [
			"NPM_TOKEN",
			"NODE_AUTH_TOKEN",
			"secrets.",
			"id-token",
			"contents: write",
			"pull_request_target",
			"continue-on-error",
			"|| true",
			"npm publish",
			".npmrc",
			"release-please-action",
			"--verify-published",
		]) {
			expect(workflow, forbidden).not.toContain(forbidden);
		}
	});

	test("only runs for same-repository release-please branches", () => {
		expect(validate).toContain("name: release-pr-validation\n");
		expect(validate).toContain(
			"    if: github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'release-please--')\n",
		);
	});

	test("checks out the exact head commit without persisting credentials", () => {
		expect(validate).toContain("uses: actions/checkout@v7");
		expect(validate).toContain(
			`ref: ${OPEN_EXPR} github.event.pull_request.head.sha }}`,
		);
		expect(validate).toContain("fetch-depth: 0");
		expect(validate).toContain("persist-credentials: false");
		expect(validate).toContain('test "$(git rev-parse HEAD)" = "$HEAD_SHA"');
		expect(validate).toContain(`git cat-file -e "$` + `{BASE_SHA}^{commit}"`);
	});

	test("pins the runtimes and action majors used by the release workflow", () => {
		expect(validate).toContain("uses: actions/setup-node@v7");
		expect(validate).toContain("node-version: 24");
		expect(validate).toContain("package-manager-cache: false");
		expect(validate).toContain("npm install -g npm@11.16.0");
		expect(validate).toContain('test "$(npm --version)" = "11.16.0"');
		expect(validate).toContain("uses: oven-sh/setup-bun@v2");
		expect(validate).toContain("bun-version: 1.4.4");
		expect(validate).toContain("uses: actions/upload-artifact@v7");
	});

	test("runs the repository gate as separately identified steps", () => {
		for (const command of [
			"- id: install\n        run: bun install --frozen-lockfile --ignore-scripts\n",
			"- id: test\n        run: bun run test\n",
			"- id: lint\n        run: bun run lint\n",
			"- id: typecheck\n        run: bun run typecheck\n",
			"- id: build\n        run: bun run build\n",
		]) {
			expect(validate, command).toContain(command);
		}
		expect(validate).toContain('sh scripts/commit-subject-ok.sh "$s" "$id"');
		expect(validate).toContain(
			`ARTIFACT_DIR: ${OPEN_EXPR} runner.temp }}/providers-usage-release-pr\n`,
		);
		expect(validate).toContain(
			'run: bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"',
		);
		expect(workflow).not.toContain("tokscope");
	});

	test("has no shell that interpolates event or step context", () => {
		const blocks = runBlocks(workflow);
		expect(blocks.length).toBeGreaterThan(8);
		for (const block of blocks) expect(block).not.toContain(OPEN_EXPR);
	});

	test("never turns a possibly false boolean into empty with jq", () => {
		expect(workflow).not.toMatch(/\.(?:draft|merged|locked)\b/);
	});

	test("orders identity, checkout, gate, acceptance and the final require step", () => {
		const markers = [
			"name: Validate PR identity through the GitHub API",
			"uses: actions/checkout@v7",
			"name: Verify the checked-out commit",
			"name: Ensure the PR base commit is available",
			"bun install --frozen-lockfile --ignore-scripts",
			"run: bun run test\n",
			"run: bun run lint\n",
			"run: bun run typecheck\n",
			"run: bun run build\n",
			"name: Validate release PR commit subjects",
			"bun scripts/release-acceptance.ts --output-dir",
			"name: Verify current PR head",
			"name: Preserve acceptance evidence",
			"name: Summarize validation and acceptance evidence",
			"name: Require accepted evidence",
		];
		const positions = markers.map((marker) => validate.indexOf(marker));
		for (const [index, position] of positions.entries()) {
			expect(position, markers[index]).toBeGreaterThan(-1);
		}
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(new Set(positions).size).toBe(positions.length);
	});

	test("the require-evidence step is last and cannot be skipped", () => {
		const start = validate.indexOf("- name: Require accepted evidence");
		const step = validate.slice(start);
		expect(step).not.toContain("\n      - ");
		expect(step).not.toContain("if:");
		expect(step).toContain(
			`ACCEPTANCE: ${OPEN_EXPR} steps.evidence.outputs.acceptance || 'not-run' }}`,
		);
		expect(step).toContain(
			`FRESHNESS: ${OPEN_EXPR} steps.freshness.outcome || 'not-run' }}`,
		);
	});

	test("preserves evidence even when earlier steps fail", () => {
		const start = validate.indexOf("name: Preserve acceptance evidence");
		const step = validate.slice(
			start,
			validate.indexOf("- name: Summarize", start),
		);
		expect(step).toContain("if: always()");
		expect(step).toContain(
			`name: release-pr-evidence-${OPEN_EXPR} github.event.pull_request.number }}-${OPEN_EXPR} github.run_attempt }}`,
		);
		expect(step).toContain(
			`path: ${OPEN_EXPR} runner.temp }}/providers-usage-release-pr\n`,
		);
		expect(step).toContain("if-no-files-found: warn");
		expect(step).toContain("retention-days: 14");
	});

	test("the summary step reports every gate outcome including lint", () => {
		const start = validate.indexOf("- name: Summarize");
		const step = validate.slice(
			start,
			validate.indexOf("- name: Require accepted evidence"),
		);
		expect(step).toContain("if: always()");
		for (const id of [
			"accept",
			"install",
			"test",
			"lint",
			"typecheck",
			"build",
			"subjects",
			"freshness",
		]) {
			expect(step, id).toContain(
				`${OPEN_EXPR} steps.${id}.outcome || 'not-run' }}`,
			);
		}
	});
});

describe("release PR identity pre-check", () => {
	test("accepts an open same-repo release PR at the event head", () => {
		const run = runStep(precheck, { pull: pullRequest(), env: identityEnv() });
		expect(run.exitCode).toBe(0);
		expect(outputs(run).base_sha).toBe(baseSha);
	});

	const rejected: Array<{
		name: string;
		overrides?: PullOverrides;
		env?: Record<string, string>;
		ghFails?: boolean;
	}> = [
		{
			name: "an event head that no longer matches the live PR head",
			overrides: { headSha: movedSha },
		},
		{ name: "an invalid event head SHA", env: { HEAD_SHA: "not-a-sha" } },
		{ name: "a short event head SHA", env: { HEAD_SHA: "a".repeat(39) } },
		{ name: "a long event head SHA", env: { HEAD_SHA: "a".repeat(41) } },
		{ name: "an empty event head SHA", env: { HEAD_SHA: "" } },
		{ name: "a non-numeric PR number", env: { PR: "not-a-number" } },
		{
			name: "a fork head reported by the event",
			env: { EVENT_HEAD_REPO: "contributor/opencode-providers-usage" },
		},
		{
			name: "a fork head returned by the live API with matching event fields",
			overrides: { headRepo: "contributor/opencode-providers-usage" },
			env: { EVENT_HEAD_REPO: "contributor/opencode-providers-usage" },
		},
		{ name: "a closed PR", overrides: { state: "closed" } },
		{
			name: "a live PR targeting another base branch",
			overrides: { baseRef: "develop" },
			env: { EVENT_BASE_REF: "develop" },
		},
		{
			name: "an event base branch that differs from the live base",
			env: { EVENT_BASE_REF: "develop" },
		},
		{
			name: "a live head ref that is not a release-please branch",
			overrides: { headRef: "feature/not-a-release" },
			env: { EVENT_HEAD_REF: "feature/not-a-release" },
		},
		{
			name: "an event head ref that differs from the live head ref",
			env: { EVENT_HEAD_REF: "feature/other" },
		},
		{ name: "a malformed base SHA", overrides: { baseSha: "not-a-sha" } },
		{ name: "a short base SHA", overrides: { baseSha: "b".repeat(39) } },
		{ name: "an empty live head SHA", overrides: { headSha: "" } },
		{ name: "a GitHub API failure", ghFails: true },
	];

	for (const fixture of rejected) {
		test(`rejects ${fixture.name}`, () => {
			const run = runStep(precheck, {
				pull: pullRequest(fixture.overrides),
				env: identityEnv(fixture.env),
				ghFails: fixture.ghFails,
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.output).not.toContain("base_sha=");
		});
	}
});

describe("current PR head verification", () => {
	test("records the current validated head", () => {
		const run = runStep(freshness, {
			pull: pullRequest(),
			env: freshnessEnv(),
		});
		expect(run.exitCode).toBe(0);
		expect(headStatus(run)).toEqual({
			expected_sha: headSha,
			observed_sha: headSha,
			pr_state: "open",
			outcome: "current",
		});
	});

	test("fails and records a stale head", () => {
		const run = runStep(freshness, {
			pull: pullRequest({ headSha: movedSha }),
			env: freshnessEnv(),
		});
		expect(run.exitCode).not.toBe(0);
		expect(headStatus(run)).toEqual({
			expected_sha: headSha,
			observed_sha: movedSha,
			pr_state: "open",
			outcome: "stale",
		});
	});

	test("fails and records a closed PR", () => {
		const run = runStep(freshness, {
			pull: pullRequest({ state: "closed" }),
			env: freshnessEnv(),
		});
		expect(run.exitCode).not.toBe(0);
		expect(headStatus(run)).toEqual({
			expected_sha: headSha,
			observed_sha: headSha,
			pr_state: "closed",
			outcome: "closed",
		});
	});

	test("records unverified before failing when the API call fails", () => {
		const run = runStep(freshness, { ghFails: true, env: freshnessEnv() });
		expect(run.exitCode).not.toBe(0);
		expect(headStatus(run)).toEqual({
			expected_sha: headSha,
			observed_sha: null,
			pr_state: null,
			outcome: "unverified",
		});
	});

	const unusableResponses: Array<{
		name: string;
		raw: string;
		observed?: string | null;
		state?: string | null;
	}> = [
		{ name: "malformed JSON", raw: "{not-json" },
		{ name: "an empty response body", raw: "" },
		{ name: "a non-object response", raw: "[]" },
		{ name: "a null response", raw: "null" },
		{
			name: "a non-string live head SHA",
			raw: JSON.stringify({ head: { sha: 42 }, state: "open" }),
		},
		{
			name: "a non-string PR state",
			raw: JSON.stringify({ head: { sha: headSha }, state: null }),
		},
		{
			name: "a malformed live head SHA",
			raw: JSON.stringify({ head: { sha: "not-a-sha" }, state: "open" }),
			observed: "not-a-sha",
			state: "open",
		},
		{
			name: "an unknown PR state",
			raw: JSON.stringify({ head: { sha: headSha }, state: "merged" }),
			observed: headSha,
			state: "merged",
		},
	];

	for (const fixture of unusableResponses) {
		test(`fails closed with an unverified snapshot for ${fixture.name}`, () => {
			const run = runStep(freshness, {
				pullRaw: fixture.raw,
				env: freshnessEnv(),
			});
			expect(run.exitCode).not.toBe(0);
			expect(headStatus(run)).toEqual({
				expected_sha: headSha,
				observed_sha: fixture.observed ?? null,
				pr_state: fixture.state ?? null,
				outcome: "unverified",
			});
		});
	}
});

const gateEnv = (overrides: Record<string, string | undefined> = {}) => ({
	ACCEPTANCE: "success",
	ARTIFACT: "accepted",
	AUDIT: "no-high-critical",
	FRESHNESS: "success",
	...overrides,
});

describe("accepted evidence gate", () => {
	test("accepts an exact package with a clean consumer audit and a current head", () => {
		const run = runStep(evidence, { env: gateEnv() });
		expect(run.exitCode).toBe(0);
	});

	test("rejects the retired exception-applied audit outcome", () => {
		const run = runStep(evidence, {
			env: gateEnv({ AUDIT: "exception-applied" }),
		});
		expect(run.exitCode).not.toBe(0);
	});

	const rejected: Array<{
		name: string;
		env: Record<string, string | undefined>;
	}> = [
		{
			name: "failed artifact acceptance",
			env: gateEnv({ ACCEPTANCE: "failure" }),
		},
		{
			name: "skipped artifact acceptance",
			env: gateEnv({ ACCEPTANCE: "skipped" }),
		},
		{
			name: "acceptance that never ran",
			env: gateEnv({ ACCEPTANCE: "not-run" }),
		},
		{ name: "an empty acceptance outcome", env: gateEnv({ ACCEPTANCE: "" }) },
		{
			name: "an unavailable artifact",
			env: gateEnv({ ARTIFACT: "unavailable" }),
		},
		{
			name: "an artifact that was not produced",
			env: gateEnv({ ARTIFACT: "not-produced" }),
		},
		{
			name: "an unreadable artifact",
			env: gateEnv({ ARTIFACT: "unreadable" }),
		},
		{ name: "a blocking audit", env: gateEnv({ AUDIT: "blocking" }) },
		{ name: "an unverified audit", env: gateEnv({ AUDIT: "unverified" }) },
		{ name: "an unusable audit", env: gateEnv({ AUDIT: "unusable" }) },
		{ name: "an empty audit outcome", env: gateEnv({ AUDIT: "" }) },
		{ name: "an unknown audit outcome", env: gateEnv({ AUDIT: "clean" }) },
		{ name: "failed head freshness", env: gateEnv({ FRESHNESS: "failure" }) },
		{ name: "skipped head freshness", env: gateEnv({ FRESHNESS: "skipped" }) },
		{
			name: "head freshness that never ran",
			env: gateEnv({ FRESHNESS: "not-run" }),
		},
		{ name: "missing evidence outputs", env: {} },
	];

	for (const fixture of rejected) {
		test(`rejects ${fixture.name}`, () => {
			const run = runStep(evidence, { env: fixture.env });
			expect(run.exitCode).not.toBe(0);
		});
	}
});

const artifactJson = JSON.stringify({
	name: "opencode-providers-usage",
	version: "7.7.7",
	filename: "opencode-providers-usage-7.7.7.tgz",
	integrity: "sha512-abc",
});

const cleanAudit = JSON.stringify({
	metadata: { vulnerabilities: { high: 0, critical: 0 } },
});

function summaryEnv(overrides: Record<string, string | undefined> = {}) {
	return {
		GITHUB_REPOSITORY: repository,
		PR: "1",
		HEAD_SHA: headSha,
		ACCEPTANCE: "success",
		INSTALL: "success",
		TEST: "success",
		LINT: "success",
		TYPECHECK: "success",
		BUILD: "success",
		SUBJECTS: "success",
		FRESHNESS: "success",
		EVIDENCE_ARTIFACT: "release-pr-evidence-1-1",
		...overrides,
	};
}

function headStatusFile(overrides: Record<string, string | null> = {}) {
	return JSON.stringify({
		expected_sha: headSha,
		observed_sha: headSha,
		pr_state: "open",
		outcome: "current",
		...overrides,
	});
}

describe("validation and acceptance summary", () => {
	test("labels a skipped freshness check not-run and keeps earlier failures visible", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv({
				ACCEPTANCE: "failure",
				TEST: "failure",
				LINT: "skipped",
				BUILD: "skipped",
				SUBJECTS: "skipped",
				FRESHNESS: "not-run",
			}),
		});
		expect(run.exitCode).toBe(0);
		expect(run.summary).toContain("Head freshness");
		expect(run.summary).toContain("not-run");
		expect(run.summary).toContain("no accepted artifact was preserved");
		expect(run.summary).toContain(
			"install=success test=failure lint=skipped typecheck=success build=skipped subjects=skipped",
		);
		expect(run.summary).toContain("**failure**");
	});

	test("reports a failed lint step", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv({ LINT: "failure", FRESHNESS: "not-run" }),
		});
		expect(run.summary).toContain("lint=failure");
	});

	test("distinguishes an accepted package from a stale PR head", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv({ FRESHNESS: "failure" }),
			artifactFiles: {
				"artifact.json": artifactJson,
				"npm-audit-omit-dev.json": cleanAudit,
				"head-status.json": headStatusFile({
					observed_sha: movedSha,
					outcome: "stale",
				}),
			},
		});
		expect(run.exitCode).toBe(0);
		expect(run.summary).toContain("accepted opencode-providers-usage@7.7.7");
		expect(run.summary).toContain("stale");
		expect(run.summary).toContain(movedSha);
		expect(run.summary).toContain("does not verify publication");
	});

	test("distinguishes a closed PR from an accepted package", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv({ FRESHNESS: "failure" }),
			artifactFiles: {
				"artifact.json": artifactJson,
				"npm-audit-omit-dev.json": cleanAudit,
				"head-status.json": headStatusFile({
					pr_state: "closed",
					outcome: "closed",
				}),
			},
		});
		expect(run.summary).toContain("accepted opencode-providers-usage@7.7.7");
		expect(run.summary).toContain("closed");
	});

	test("distinguishes an unverified head from an accepted package", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv({ FRESHNESS: "failure" }),
			artifactFiles: {
				"artifact.json": artifactJson,
				"npm-audit-omit-dev.json": cleanAudit,
				"head-status.json": headStatusFile({
					observed_sha: null,
					pr_state: null,
					outcome: "unverified",
				}),
			},
		});
		expect(run.summary).toContain("accepted opencode-providers-usage@7.7.7");
		expect(run.summary).toContain("unverified");
	});

	test("reports a current package as current without claiming publication", () => {
		const run = runStep(summaryStep, {
			env: summaryEnv(),
			artifactFiles: {
				"artifact.json": artifactJson,
				"npm-audit-omit-dev.json": cleanAudit,
				"head-status.json": headStatusFile(),
			},
		});
		expect(run.summary).toContain("accepted opencode-providers-usage@7.7.7");
		expect(run.summary).toContain("current");
		expect(outputs(run)).toEqual({
			acceptance: "success",
			artifact: "accepted",
			audit: "no-high-critical",
		});
		expect(run.summary).not.toContain("publication verified");
		expect(run.summary).not.toContain("publish verified");
	});

	test("keeps blocking audit values and ignores a fake exception file", () => {
		const blockingAudit = JSON.stringify({
			metadata: { vulnerabilities: { high: 1, critical: 2 } },
		});
		const blocking = runStep(summaryStep, {
			env: summaryEnv({ ACCEPTANCE: "failure", FRESHNESS: "not-run" }),
			artifactFiles: { "npm-audit-omit-dev.json": blockingAudit },
		});
		expect(outputs(blocking).audit).toBe("blocking");
		expect(blocking.summary).toContain("blocking high=1 critical=2");

		const faked = runStep(summaryStep, {
			env: summaryEnv({ FRESHNESS: "not-run" }),
			artifactFiles: {
				"artifact.json": artifactJson,
				"npm-audit-omit-dev.json": blockingAudit,
				"accepted-audit-exceptions.json": "{}",
				"head-status.json": headStatusFile(),
			},
		});
		expect(outputs(faked).audit).toBe("blocking");
		expect(faked.summary).not.toContain("exception");

		const fakeOnly = runStep(summaryStep, {
			env: summaryEnv({ FRESHNESS: "not-run" }),
			artifactFiles: {
				"artifact.json": artifactJson,
				"accepted-audit-exceptions.json": "{}",
				"head-status.json": headStatusFile(),
			},
		});
		expect(outputs(fakeOnly).audit).toBe("not-run");
	});
});

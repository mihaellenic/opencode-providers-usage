import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Built without a literal dollar-brace so Biome does not flag GitHub expression text.
const OPEN_EXPR = `\${{`;
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const ci = read(".github/workflows/ci.yml");

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

describe("CI workflow triggers and permissions", () => {
	test("runs on pull requests and pushes to main only", () => {
		expect(ci).toContain("on:\n  push:\n    branches: [main]\n  pull_request:");
		for (const forbidden of [
			"pull_request_target",
			"workflow_dispatch",
			"workflow_run",
		]) {
			expect(ci).not.toContain(forbidden);
		}
	});

	test("grants only read access to the repository", () => {
		expect(ci).toContain("permissions:\n  contents: read\n");
		for (const forbidden of [
			"contents: write",
			"actions: write",
			"pull-requests: write",
			"id-token",
			"secrets.",
		]) {
			expect(ci).not.toContain(forbidden);
		}
	});

	test("never executes checkout code with privileged triggers or credentials", () => {
		expect(ci).not.toContain("pull_request_target");
		expect(ci).not.toContain("NPM_TOKEN");
		expect(ci).not.toContain("NODE_AUTH_TOKEN");
		expect(ci).not.toContain("continue-on-error");
		expect(ci).not.toContain("|| true");
	});
});

describe("CI quality job", () => {
	const quality = jobBlock(ci, "quality");

	test("uses the pinned action majors and the supported Bun runtime", () => {
		expect(quality).toContain("uses: actions/checkout@v5");
		expect(quality).toContain("uses: oven-sh/setup-bun@v2");
		expect(quality).toContain("bun-version: 1.4.4");
		expect(ci).not.toContain("1.1.3");
	});

	test("checks out without persisting credentials", () => {
		expect(quality).toContain("persist-credentials: false");
	});

	test("installs from the committed lockfile with lifecycle scripts disabled", () => {
		expect(quality).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(quality).not.toContain("npm install");
		expect(quality).not.toContain("npm ci");
		expect(quality).not.toContain("pnpm");
		expect(quality).not.toContain("yarn");
	});

	test("runs the release-acceptance command sequence in order", () => {
		const commands = [
			"bun install --frozen-lockfile --ignore-scripts",
			"bun test",
			"bun run lint",
			"bun run typecheck",
			"bun run build",
			"bun scripts/bun-audit-gate.ts",
		];
		const positions = commands.map((command) => quality.indexOf(command));
		for (const [index, position] of positions.entries()) {
			expect(position, commands[index]).toBeGreaterThan(-1);
		}
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	test("has no shell that interpolates event context", () => {
		expect(runBlocks(quality).length).toBeGreaterThan(0);
		for (const block of runBlocks(quality))
			expect(block).not.toContain(OPEN_EXPR);
	});
});

describe("CI source audit gate", () => {
	const quality = jobBlock(ci, "quality");

	test("runs the JSON-parsing gate and not a bare exit-code audit", () => {
		expect(quality).toContain("run: bun scripts/bun-audit-gate.ts");
		expect(ci).not.toContain("--audit-level");
		expect(ci).not.toContain("bun audit");
	});

	test("the gate step cannot be bypassed", () => {
		const step = quality.slice(
			quality.indexOf("bun scripts/bun-audit-gate.ts"),
		);
		expect(step.slice(0, 80)).not.toContain("continue-on-error");
		expect(quality).not.toContain("|| true");
	});
});

describe("CI commit subject job", () => {
	const subjects = jobBlock(ci, "subjects");

	test("documents new-branch and force-push range behavior", () => {
		expect(subjects).toContain("new branch");
		expect(subjects).toContain("force push");
		expect(subjects).toContain("no longer exists");
		expect(subjects).toContain("fails closed");
	});

	test("validates the exact pull request head against the exact base SHA", () => {
		expect(subjects).toContain("uses: actions/checkout@v5");
		expect(subjects).toContain("fetch-depth: 0");
		expect(subjects).toContain(
			`ref: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}`,
		);
		expect(subjects).toContain(
			`PR_BASE: \${{ github.event.pull_request.base.sha }}`,
		);
		expect(subjects).toContain(
			`PR_HEAD: \${{ github.event.pull_request.head.sha }}`,
		);
		expect(subjects).toContain("git log --format='%s' \"$base..$head\"");
		expect(subjects).not.toContain("github.base_ref");
	});

	test("handles all-zero and empty before SHAs by validating reachable history", () => {
		expect(subjects).toContain(`PUSH_BEFORE: \${{ github.event.before }}`);
		expect(subjects).toContain("*[!0]*)");
		expect(subjects).toContain("all reachable history");
		expect(subjects).toContain("new branch push");
		expect(subjects).toContain("git log --format='%s' \"$head\"");
	});

	test("fails closed on missing SHAs and a mismatched checkout", () => {
		expect(subjects).toContain('test -n "$base"');
		expect(subjects).toContain('test -n "$head"');
		expect(subjects).toContain('test "$(git rev-parse HEAD)" = "$head"');
		expect(subjects).not.toContain("|| echo");
		expect(subjects).not.toContain("skipping subject check");
	});

	test("checks every subject with the shared checker", () => {
		expect(subjects).toContain("sh scripts/commit-subject-ok.sh");
	});

	test("passes event values through env instead of shell interpolation", () => {
		expect(runBlocks(subjects).length).toBeGreaterThan(0);
		for (const block of runBlocks(subjects))
			expect(block).not.toContain(OPEN_EXPR);
	});
});

describe("runBlocks parser", () => {
	test("extracts single-line run steps as well as multi-line bodies", () => {
		const blocks = runBlocks(
			"      - run: echo ok\n      - run: |\n          echo two\n",
		);
		expect(blocks).toContain("echo ok");
		expect(blocks[1]).toContain("echo two");
	});
});

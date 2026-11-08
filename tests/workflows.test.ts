import { describe, expect, test } from "bun:test";
import { jobBlock, read, runBlocks } from "./workflow-helpers";

const ci = read(".github/workflows/ci.yml");

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
});

describe("CI quality job", () => {
	const quality = jobBlock(ci, "quality");

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
			"bun run test",
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

	test("both CI and clean-export acceptance invoke the unit and GUI suites", () => {
		const manifest = JSON.parse(read("package.json"));
		expect(manifest.scripts.test).toBe("bun test && bun run test:gui");
		expect(manifest.scripts["test:gui"]).toBe(
			"bun test --conditions browser --preload ./tests/gui/dom-setup.ts ./tests/gui/*.gui.*",
		);
		expect(quality).toContain("run: bun run test\n");
		const acceptance = read("scripts/release-acceptance.ts");
		expect(acceptance).toContain(
			"testEnv = prepareCommittedInventory({ root, scratch, source });",
		);
		expect(acceptance).toContain(
			'exec(["bun", "run", "test"], source, testEnv)',
		);
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

	test("validates the exact pull request head against the exact base SHA", () => {
		expect(subjects).toContain("uses: actions/checkout@v7");
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
		expect(subjects).toContain("git log --format='%H %s' \"$base..$head\"");
		expect(subjects).not.toContain("github.base_ref");
	});

	test("handles all-zero and empty before SHAs by validating reachable history", () => {
		expect(subjects).toContain(`PUSH_BEFORE: \${{ github.event.before }}`);
		expect(subjects).toContain("*[!0]*)");
		expect(subjects).toContain("all reachable history");
		expect(subjects).toContain("new branch push");
		expect(subjects).toContain("git log --format='%H %s' \"$head\"");
	});

	test("fails closed on missing SHAs and a mismatched checkout", () => {
		expect(subjects).toContain('test -n "$base"');
		expect(subjects).toContain('test -n "$head"');
		expect(subjects).toContain('test "$(git rev-parse HEAD)" = "$head"');
		expect(subjects).not.toContain("|| echo");
		expect(subjects).not.toContain("skipping subject check");
	});

	test("checks every subject with the shared checker", () => {
		expect(subjects).toContain('sh scripts/commit-subject-ok.sh "$s" "$id"');
		expect(subjects).toContain("IFS=' ' read -r id s");
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

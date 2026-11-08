import { describe, expect, test } from "bun:test";
import { jobBlock, OPEN_EXPR, read, runBlocks } from "./workflow-helpers";

const workflows = {
	ci: read(".github/workflows/ci.yml"),
	release: read(".github/workflows/release.yml"),
	"validate-release-pr": read(".github/workflows/validate-release-pr.yml"),
};
const entries = Object.entries(workflows);

// Jobs that check out code; ci "subjects" only reads history for commit subjects.
const persistGuarded: Array<[string, string, string]> = [
	["ci", workflows.ci, "quality"],
	["release", workflows.release, "accept"],
	["release", workflows.release, "publish"],
	["validate-release-pr", workflows["validate-release-pr"], "validate"],
];

describe("shared workflow guards", () => {
	test.each(entries)(
		"%s defaults to read-only repository access",
		(_n, src) => {
			const header = src.slice(0, src.indexOf("\njobs:\n"));
			expect(header).toContain("\npermissions:\n  contents: read\n");
			expect(header).not.toContain("write");
			expect(header).not.toContain("id-token");
		},
	);

	test.each(entries)(
		"%s has no credentials, bypasses or privileged triggers",
		(name, src) => {
			for (const forbidden of [
				"NPM_TOKEN",
				"NODE_AUTH_TOKEN",
				"secrets.",
				".npmrc",
				"continue-on-error",
				"|| true",
				"pull_request_target",
				"workflow_run",
			]) {
				expect(src, `${name}: ${forbidden}`).not.toContain(forbidden);
			}
		},
	);

	test.each(entries)(
		"%s shell never interpolates event or step context",
		(_n, src) => {
			const blocks = runBlocks(src);
			expect(blocks.length).toBeGreaterThan(0);
			for (const block of blocks) expect(block).not.toContain(OPEN_EXPR);
		},
	);

	test.each(persistGuarded)(
		"%s/%s checks out without persisting credentials",
		(_n, src, job) => {
			const block = jobBlock(src, job);
			expect(block).toContain("uses: actions/checkout@v7");
			expect(block).toContain("persist-credentials: false");
		},
	);

	test.each(entries)(
		"%s pins action majors and runtimes consistently",
		(_n, src) => {
			const expected: Array<[RegExp, string[]]> = [
				[/uses: actions\/checkout@(\S+)/g, ["v7"]],
				[/uses: actions\/setup-node@(\S+)/g, ["v7"]],
				[/uses: oven-sh\/setup-bun@(\S+)/g, ["v2"]],
				[/uses: actions\/upload-artifact@(\S+)/g, ["v7"]],
				[/uses: actions\/download-artifact@(\S+)/g, ["v8"]],
				[/uses: googleapis\/release-please-action@(\S+)/g, ["v5"]],
				[/bun-version: (\S+)/g, ["1.4.4"]],
				[/node-version: (\S+)/g, ["24"]],
				[/npm install -g npm@(\S+)/g, ["11.16.0"]],
				[/npm --version\)" = "(\S+)"/g, ["11.16.0"]],
			];
			for (const [pattern, allowed] of expected) {
				for (const match of src.matchAll(pattern)) {
					expect(allowed, pattern.source).toContain(match[1] as string);
				}
			}
			// setup-node always opts out of the package-manager cache.
			const nodeSetups = src.match(/uses: actions\/setup-node@/g)?.length ?? 0;
			expect(src.match(/package-manager-cache: false/g)?.length ?? 0).toBe(
				nodeSetups,
			);
		},
	);

	test("id-token is granted only to the release publish job", () => {
		expect(workflows.release.match(/id-token/g)?.length).toBe(1);
		expect(jobBlock(workflows.release, "publish")).toContain(
			"permissions:\n      contents: read\n      id-token: write\n",
		);
		for (const name of ["ci", "validate-release-pr"] as const) {
			expect(workflows[name]).not.toContain("id-token");
			expect(workflows[name]).not.toMatch(/^\s+[a-z-]+: write\s*$/m);
			expect(workflows[name]).not.toContain("write-all");
		}
	});
});

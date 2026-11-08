import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMMITTED_INVENTORY_ENV,
	committedPaths,
	createInventory,
	isCommittedPath,
	parseInventory,
	parseTreeListing,
} from "../scripts/release-inventory";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scratchBase =
	process.env.TMPDIR && existsSync(process.env.TMPDIR)
		? process.env.TMPDIR
		: "/tmp";
const COMMIT = "a".repeat(40);
const HASH = "b".repeat(64);
const make = (paths: string[], extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		schema: 1,
		commit: COMMIT,
		packageJsonSha256: HASH,
		paths,
		...extra,
	});

describe("parseTreeListing", () => {
	test("splits NUL-terminated names and keeps unusual characters", () => {
		expect(parseTreeListing("a.md\0docs/b c.md\0docs/é.md\0")).toEqual([
			"a.md",
			"docs/b c.md",
			"docs/é.md",
		]);
	});
	test.each([
		["empty listing", ""],
		["missing final terminator", "a.md"],
		["empty name", "a.md\0\0"],
	])("parseTreeListing rejects %s", (_name, listing) => {
		expect(() => parseTreeListing(listing)).toThrow();
	});
});

describe("parseInventory", () => {
	test("accepts a valid inventory", () => {
		const inv = parseInventory(make(["README.md", "docs/a.md"]));
		expect(inv.commit).toBe(COMMIT);
		expect(inv.paths.has("docs/a.md")).toBe(true);
	});
	test("createInventory round-trips", () => {
		const text = createInventory({
			commit: COMMIT,
			packageJsonSha256: HASH,
			paths: ["b", "a"],
		});
		expect([...parseInventory(text).paths].sort()).toEqual(["a", "b"]);
	});
	test.each([
		["empty text", ""],
		["truncated JSON", "{"],
		["null", "null"],
		["array", "[]"],
		["wrong schema", make(["a"], { schema: 2 })],
		["bad commit", make(["a"], { commit: "xyz" })],
		["short hash", make(["a"], { packageJsonSha256: "short" })],
		["extra key", make(["a"], { extra: true })],
		["empty paths", make([])],
		["string paths", make("a" as never)],
		["non-string path", make([1 as never])],
		[
			"missing hash",
			JSON.stringify({ schema: 1, commit: COMMIT, paths: ["a"] }),
		],
	])("parseInventory rejects %s", (_name, bad) => {
		expect(() => parseInventory(bad)).toThrow();
	});
	test.each([
		"",
		"/abs",
		"./a",
		"a/./b",
		"a/../b",
		"../a",
		"a//b",
		"a/",
		"a\\b",
		"a\0b",
		"a\nb",
	])("parseInventory rejects noncanonical path %p", (bad) => {
		expect(() => parseInventory(make(["ok", bad]))).toThrow();
	});
	test("rejects duplicate paths", () => {
		expect(() => parseInventory(make(["a", "a"]))).toThrow(/duplicate/i);
	});
	test("binds to the package.json hash when requested", () => {
		expect(
			parseInventory(make(["a"]), { packageJsonSha256: HASH }).paths.size,
		).toBe(1);
		expect(() =>
			parseInventory(make(["a"]), { packageJsonSha256: "c".repeat(64) }),
		).toThrow(/package\.json/);
	});
});

const sha = (text: string): string =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");

describe("committedPaths", () => {
	let dir = "";
	let inv = "";
	let noGit = "";
	beforeAll(() => {
		dir = mkdtempSync(join(scratchBase, "inv-test."));
		inv = join(dir, "inventory.json");
		noGit = join(dir, "tree");
		mkdirSync(noGit);
		writeFileSync(join(noGit, "package.json"), "{}\n");
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reads the explicit inventory in a tree without .git", () => {
		writeFileSync(inv, make(["README.md"], { packageJsonSha256: sha("{}\n") }));
		const paths = committedPaths(noGit, { [COMMITTED_INVENTORY_ENV]: inv });
		expect(isCommittedPath(paths, "README.md")).toBe(true);
		expect(isCommittedPath(paths, "other.md")).toBe(false);
	});
	test("fails closed without .git and without inventory", () => {
		expect(() => committedPaths(noGit, {})).toThrow();
	});
	test("fails closed on missing, relative, or malformed inventory files", () => {
		expect(() =>
			committedPaths(noGit, { [COMMITTED_INVENTORY_ENV]: join(dir, "nope") }),
		).toThrow();
		expect(() =>
			committedPaths(noGit, { [COMMITTED_INVENTORY_ENV]: "inventory.json" }),
		).toThrow();
		writeFileSync(inv, "garbage");
		expect(() =>
			committedPaths(noGit, { [COMMITTED_INVENTORY_ENV]: inv }),
		).toThrow();
	});
	test("rejects an inventory bound to a different package.json", () => {
		writeFileSync(inv, make(["README.md"]));
		expect(() =>
			committedPaths(noGit, { [COMMITTED_INVENTORY_ENV]: inv }),
		).toThrow(/package\.json/);
	});
	test("rejects an inventory located inside the tree", () => {
		writeFileSync(join(noGit, "inv.json"), make(["README.md"]));
		expect(() =>
			committedPaths(noGit, {
				[COMMITTED_INVENTORY_ENV]: join(noGit, "inv.json"),
			}),
		).toThrow(/outside the source tree/);
	});
	test("treats an internal '..foo' directory as inside the tree", () => {
		const source = join(dir, "source");
		mkdirSync(join(source, "..foo"), { recursive: true });
		writeFileSync(join(source, "package.json"), "{}\n");
		const file = join(source, "..foo", "inventory.json");
		writeFileSync(
			file,
			make(["README.md"], { packageJsonSha256: sha("{}\n") }),
		);
		expect(() =>
			committedPaths(source, { [COMMITTED_INVENTORY_ENV]: file }),
		).toThrow(/outside the source tree/);
		const sibling = join(dir, "..foo-sibling.json");
		writeFileSync(
			sibling,
			make(["README.md"], { packageJsonSha256: sha("{}\n") }),
		);
		expect(
			committedPaths(source, { [COMMITTED_INVENTORY_ENV]: sibling }).has(
				"README.md",
			),
		).toBe(true);
	});
	test("uses git ls-files in an isolated fixture repository", () => {
		const fixture = join(dir, "fixture");
		mkdirSync(fixture);
		writeFileSync(join(fixture, "package.json"), "{}\n");
		writeFileSync(join(fixture, "tracked.md"), "x\n");
		writeFileSync(join(fixture, "untracked.md"), "y\n");
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				[
					"-C",
					fixture,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.invalid",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ encoding: "utf8" },
			);
		git("init", "-q");
		git("add", "package.json", "tracked.md");
		git("commit", "-q", "-m", "fixture");
		const paths = committedPaths(fixture, {});
		expect([...paths].sort()).toEqual(["package.json", "tracked.md"]);
		expect(isCommittedPath(paths, "untracked.md")).toBe(false);
	});
	test("isCommittedPath rejects traversal and non-canonical lookups", () => {
		const paths = new Set(["a/b.md"]);
		expect(isCommittedPath(paths, "a/b.md")).toBe(true);
		expect(isCommittedPath(paths, "a/../a/b.md")).toBe(false);
		expect(isCommittedPath(paths, "./a/b.md")).toBe(false);
		expect(isCommittedPath(paths, "")).toBe(false);
	});
});

describe("docs link test inside a git-less archive copy", () => {
	let dir = "";
	let tree = "";
	let tracked: string[] = [];
	beforeAll(() => {
		dir = mkdtempSync(join(scratchBase, "inv-archive."));
		tree = join(dir, "tree");
		mkdirSync(join(tree, "tests"), { recursive: true });
		mkdirSync(join(tree, "scripts"));
		mkdirSync(join(tree, ".github/workflows"), { recursive: true });
		for (const f of ["README.md", "package.json", "docs"])
			cpSync(join(repo, f), join(tree, f), { recursive: true });
		for (const f of [
			"tests/releasing-doc.test.ts",
			"scripts/release-inventory.ts",
			"scripts/release-acceptance.ts",
			".github/workflows/release.yml",
		])
			cpSync(join(repo, f), join(tree, f));
		tracked = [...committedPaths(repo)];
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const inventory = (p: string[]): string =>
		createInventory({
			commit: COMMIT,
			packageJsonSha256: new Bun.CryptoHasher("sha256")
				.update(readFileSync(join(tree, "package.json")))
				.digest("hex"),
			paths: p,
		});
	const run = (env: Record<string, string>) =>
		spawnSync("bun", ["test", "--cwd", tree, "tests/releasing-doc.test.ts"], {
			cwd: tree,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: tree, ...env },
		});

	test("has no .git", () => {
		expect(existsSync(join(tree, ".git"))).toBe(false);
	});
	test("passes with the exported inventory", () => {
		const f = join(dir, "inv-ok.json");
		writeFileSync(f, inventory(tracked));
		const r = run({ [COMMITTED_INVENTORY_ENV]: f });
		expect(r.stderr + r.stdout).not.toMatch(/^\(fail\)/m);
		expect(r.status).toBe(0);
	});
	test("fails without an inventory", () => {
		expect(run({}).status).not.toBe(0);
	});
	test("rejects linked files that exist but are not in the inventory", () => {
		const f = join(dir, "inv-missing.json");
		writeFileSync(f, inventory(tracked.filter((p) => p !== "docs/support.md")));
		expect(existsSync(join(tree, "docs/support.md"))).toBe(true);
		expect(run({ [COMMITTED_INVENTORY_ENV]: f }).status).not.toBe(0);
	});
	test("rejects a malformed inventory", () => {
		const f = join(dir, "inv-bad.json");
		writeFileSync(f, "{}");
		expect(run({ [COMMITTED_INVENTORY_ENV]: f }).status).not.toBe(0);
	});
});

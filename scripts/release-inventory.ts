/**
 * Committed-path inventory for release acceptance.
 *
 * Acceptance runs the test suite inside a `git archive` export, which has no
 * `.git`. Tests that need "is this file committed" therefore read an explicit
 * inventory exported from `git ls-tree -rz --name-only HEAD` into scratch space
 * outside the exported tree. In the real repository (a `.git` present at the
 * root) they use `git ls-files`. Anything else fails closed: there is no
 * filesystem-exists fallback.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const COMMITTED_INVENTORY_ENV = "RELEASE_ACCEPTANCE_COMMITTED_INVENTORY";
const SCHEMA = 1;

export interface CommittedInventory {
	commit: string;
	packageJsonSha256: string;
	paths: Set<string>;
}

/** Parse `git ls-tree -rz --name-only` / `git ls-files -z` output. */
export function parseTreeListing(stdout: string): string[] {
	if (!stdout.endsWith("\0"))
		throw new Error("tree listing is empty or not NUL-terminated");
	const names = stdout.slice(0, -1).split("\0");
	if (names.some((n) => n === ""))
		throw new Error("tree listing has an empty entry");
	return names;
}

function canonicalPathProblem(path: unknown): string | null {
	if (typeof path !== "string" || path === "") return "not a non-empty string";
	if (/[\0\\\n\r]/.test(path)) return "contains a forbidden character";
	if (path.startsWith("/")) return "is absolute";
	if (path.split("/").some((s) => s === "" || s === "." || s === ".."))
		return "is not a canonical relative path";
	return null;
}

export function createInventory(input: {
	commit: string;
	packageJsonSha256: string;
	paths: readonly string[];
}): string {
	return `${JSON.stringify({
		schema: SCHEMA,
		commit: input.commit,
		packageJsonSha256: input.packageJsonSha256,
		paths: [...input.paths].sort(),
	})}\n`;
}

export function parseInventory(
	text: string,
	expect: { packageJsonSha256?: string } = {},
): CommittedInventory {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("committed inventory is not valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("committed inventory must be an object");
	const rec = value as Record<string, unknown>;
	const keys = Object.keys(rec).sort().join(",");
	if (keys !== "commit,packageJsonSha256,paths,schema")
		throw new Error(`committed inventory has unexpected keys: ${keys}`);
	if (rec.schema !== SCHEMA)
		throw new Error(`committed inventory schema must be ${SCHEMA}`);
	if (typeof rec.commit !== "string" || !/^[0-9a-f]{40}$/.test(rec.commit))
		throw new Error("committed inventory commit must be a 40-hex object id");
	const hash = rec.packageJsonSha256;
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
		throw new Error("committed inventory packageJsonSha256 must be 64 hex");
	if (
		expect.packageJsonSha256 !== undefined &&
		expect.packageJsonSha256 !== hash
	)
		throw new Error("committed inventory is bound to a different package.json");
	if (!Array.isArray(rec.paths) || rec.paths.length === 0)
		throw new Error("committed inventory paths must be a non-empty array");
	const paths = new Set<string>();
	for (const p of rec.paths) {
		const problem = canonicalPathProblem(p);
		if (problem)
			throw new Error(
				`committed inventory path ${JSON.stringify(p)} ${problem}`,
			);
		if (paths.has(p as string))
			throw new Error(`committed inventory has duplicate path ${p}`);
		paths.add(p as string);
	}
	return { commit: rec.commit, packageJsonSha256: hash, paths };
}

function sha256Hex(path: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(readFileSync(path))
		.digest("hex");
}

/**
 * Committed paths for `root`: the explicit inventory when the env names one,
 * otherwise `git ls-files` when `root` has its own `.git`. Throws otherwise.
 */
export function committedPaths(
	root: string,
	env: Record<string, string | undefined> = process.env,
): Set<string> {
	const file = env[COMMITTED_INVENTORY_ENV];
	if (file !== undefined) {
		if (!isAbsolute(file))
			throw new Error(`${COMMITTED_INVENTORY_ENV} must be an absolute path`);
		const rel = relative(resolve(root), resolve(file));
		const inside =
			rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		if (rel === "" || inside)
			throw new Error("committed inventory must live outside the source tree");
		if (!existsSync(file))
			throw new Error(`committed inventory not found: ${file}`);
		return parseInventory(readFileSync(file, "utf8"), {
			packageJsonSha256: sha256Hex(resolve(root, "package.json")),
		}).paths;
	}
	if (!existsSync(resolve(root, ".git")))
		throw new Error(
			`no .git in ${root} and ${COMMITTED_INVENTORY_ENV} is not set; cannot determine committed files`,
		);
	return new Set(
		parseTreeListing(
			execFileSync("git", ["-C", root, "ls-files", "-z"], {
				encoding: "utf8",
			}),
		),
	);
}

/** Strict membership: only canonical relative paths present in the set. */
export function isCommittedPath(
	paths: ReadonlySet<string>,
	path: string,
): boolean {
	return canonicalPathProblem(path) === null && paths.has(path);
}

/** Environment for a child process that must see the inventory. */
export function inventoryEnv(
	inventoryFile: string,
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	return { ...base, [COMMITTED_INVENTORY_ENV]: inventoryFile };
}

/** Build inventory text for HEAD of `root` (git ls-tree -rz --name-only HEAD). */
export function inventoryForHead(
	root: string,
	packageJsonSha256: string,
): string {
	const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const listing = execFileSync(
		"git",
		["-C", root, "ls-tree", "-rz", "--name-only", "HEAD"],
		{ encoding: "utf8" },
	);
	return createInventory({
		commit,
		packageJsonSha256,
		paths: parseTreeListing(listing),
	});
}

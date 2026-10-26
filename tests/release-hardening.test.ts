import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	expectedBunVersion,
	requireBunRuntime,
	validateOutputDir,
} from "../scripts/release-acceptance";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Fixtures live under the approved scratch root; each test removes only its own. */
function fixture(): { dir: string; cleanup: () => void } {
	const base = process.env.SCRATCH_ROOT ?? tmpdir();
	const dir = mkdtempSync(join(base, "release-hardening."));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("expectedBunVersion", () => {
	test("returns the version when packageManager and engines agree", () => {
		expect(
			expectedBunVersion({
				packageManager: "bun@1.4.4",
				engines: { bun: "1.4.4" },
			}),
		).toBe("1.4.4");
	});

	test("rejects missing, disagreeing, and malformed pins", () => {
		const bad: unknown[] = [
			{},
			{ packageManager: "bun@1.4.4" },
			{ engines: { bun: "1.4.4" } },
			{ packageManager: "bun@1.4.4", engines: { bun: "1.4.5" } },
			{ packageManager: "bun@^1.4.4", engines: { bun: "^1.4.4" } },
			{ packageManager: "bun@1.4", engines: { bun: "1.4" } },
			{ packageManager: "bun@>=1.4.4", engines: { bun: ">=1.4.4" } },
			{ packageManager: "pnpm@1.4.4", engines: { bun: "1.4.4" } },
			{ packageManager: "bun@1.4.4+sha", engines: { bun: "1.4.4+sha" } },
			{ packageManager: 144, engines: { bun: "1.4.4" } },
			{ packageManager: "bun@1.4.4", engines: "1.4.4" },
			null,
			"bun@1.4.4",
		];
		for (const manifest of bad) {
			expect(() => expectedBunVersion(manifest)).toThrow();
		}
	});
});

describe("requireBunRuntime", () => {
	const manifest = { packageManager: "bun@1.4.4", engines: { bun: "1.4.4" } };

	test("accepts exactly the pinned runtime", () => {
		expect(() => requireBunRuntime(manifest, "1.4.4")).not.toThrow();
	});

	test("rejects any other runtime", () => {
		for (const actual of [
			"1.4.3",
			"1.4.5",
			"1.5.0",
			"2.0.0",
			"1.4.4-canary",
			"",
			undefined,
		]) {
			expect(() => requireBunRuntime(manifest, actual)).toThrow(/1\.4\.4/);
		}
	});

	test("rejects when the pins are unusable even if runtime looks right", () => {
		expect(() => requireBunRuntime({}, "1.4.4")).toThrow();
	});
});

describe("validateOutputDir", () => {
	test("accepts a new directory and an existing empty directory", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(source);
			expect(() => validateOutputDir(join(dir, "fresh"), source)).not.toThrow();
			expect(() =>
				validateOutputDir(join(dir, "a", "b", "c"), source),
			).not.toThrow();
			const empty = join(dir, "empty");
			mkdirSync(empty);
			expect(() => validateOutputDir(empty, source)).not.toThrow();
			// validation itself never creates anything
			expect(existsSync(join(dir, "fresh"))).toBe(false);
			expect(existsSync(join(dir, "a"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("rejects non-empty directories without touching them", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(source);
			for (const name of [
				"opencode-providers-usage-0.1.0.tgz",
				"artifact.json",
				"bun-audit.json",
				"npm-audit-omit-dev.json",
				".hidden",
				"other.txt",
			]) {
				const out = join(dir, `out-${name}`);
				mkdirSync(out);
				writeFileSync(join(out, name), "keep");
				expect(() => validateOutputDir(out, source)).toThrow(/not empty/);
				expect(readdirSync(out)).toEqual([name]);
				expect(readFileSync(join(out, name), "utf8")).toBe("keep");
			}
			const nested = join(dir, "out-nested");
			mkdirSync(join(nested, "sub"), { recursive: true });
			expect(() => validateOutputDir(nested, source)).toThrow(/not empty/);
		} finally {
			cleanup();
		}
	});

	test("rejects a regular file and a file ancestor", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(source);
			const file = join(dir, "file");
			writeFileSync(file, "x");
			expect(() => validateOutputDir(file, source)).toThrow(/directory/);
			expect(() => validateOutputDir(join(file, "child"), source)).toThrow();
			expect(readFileSync(file, "utf8")).toBe("x");
		} finally {
			cleanup();
		}
	});

	test("rejects a symlink output directory, even to an empty directory", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(source);
			const target = join(dir, "target");
			mkdirSync(target);
			const link = join(dir, "link");
			symlinkSync(target, link);
			expect(() => validateOutputDir(link, source)).toThrow(/symlink/);
			const dangling = join(dir, "dangling");
			symlinkSync(join(dir, "missing"), dangling);
			expect(() => validateOutputDir(dangling, source)).toThrow(/symlink/);
			expect(readdirSync(target)).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("rejects the source repository, paths inside it, and aliases of it", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(join(source, "sub"), { recursive: true });
			const alias = join(dir, "alias");
			symlinkSync(source, alias);
			for (const candidate of [
				source,
				join(source, "sub"),
				join(source, "new-dir"),
				join(source, "sub", "deep", "new"),
				join(alias, "new-dir"),
				join(alias, "sub", "x"),
			]) {
				expect(() => validateOutputDir(candidate, source)).toThrow(/source/);
			}
			// the alias spelling of the source also counts as the source
			expect(() => validateOutputDir(join(dir, "fresh"), alias)).not.toThrow();
			expect(() => validateOutputDir(join(source, "x"), alias)).toThrow(
				/source/,
			);
			expect(existsSync(join(source, "new-dir"))).toBe(false);
			expect(readdirSync(source)).toEqual(["sub"]);
		} finally {
			cleanup();
		}
	});

	test("rejects relative paths", () => {
		const { dir, cleanup } = fixture();
		try {
			expect(() => validateOutputDir("relative/out", dir)).toThrow(/absolute/);
		} finally {
			cleanup();
		}
	});

	test("a sibling that shares the source name prefix is allowed", () => {
		const { dir, cleanup } = fixture();
		try {
			const source = join(dir, "source");
			mkdirSync(source);
			expect(() =>
				validateOutputDir(join(dir, "source-evidence"), source),
			).not.toThrow();
		} finally {
			cleanup();
		}
	});
});

describe("real entrypoint rejects before any side effect", () => {
	const script = read("scripts/release-acceptance.ts");

	/** Build a throwaway git repo that holds a copy of the script and a chosen pin set. */
	function repoWithPins(pin: string): {
		dir: string;
		repo: string;
		cleanup: () => void;
	} {
		const f = fixture();
		const repo = join(f.dir, "repo");
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({
				name: "opencode-providers-usage",
				version: "0.1.0",
				packageManager: `bun@${pin}`,
				engines: { bun: pin },
			}),
		);
		writeFileSync(join(repo, "scripts", "release-acceptance.ts"), script);
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", "-C", repo, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
		git("init", "-q");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		// Shim every network/registry tool so any call is recorded instead of run.
		const bin = join(f.dir, "bin");
		mkdirSync(bin);
		const log = join(f.dir, "calls.log");
		for (const tool of ["npm", "npx", "bun-shim"]) {
			const path = join(bin, tool);
			writeFileSync(path, `#!/bin/sh\necho "${tool} $@" >> "${log}"\nexit 1\n`);
			Bun.spawnSync(["chmod", "+x", path]);
		}
		return { dir: f.dir, repo, cleanup: f.cleanup };
	}

	function runEntry(repo: string, dir: string, args: string[]) {
		const proc = Bun.spawnSync(
			[process.execPath, "scripts/release-acceptance.ts", ...args],
			{
				cwd: repo,
				env: {
					...process.env,
					PATH: `${join(dir, "bin")}:${process.env.PATH}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return {
			code: proc.exitCode,
			out: `${proc.stdout}${proc.stderr}`,
			calls: existsSync(join(dir, "calls.log"))
				? readFileSync(join(dir, "calls.log"), "utf8")
				: "",
		};
	}

	test("accept mode with a wrong-runtime pin makes no calls and creates nothing", () => {
		const { dir, repo, cleanup } = repoWithPins("9.9.9");
		try {
			const out = join(dir, "evidence");
			const r = runEntry(repo, dir, ["--output-dir", out]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("9.9.9");
			expect(r.calls).toBe("");
			expect(existsSync(out)).toBe(false);
			expect(readdirSync(repo).sort()).toEqual([
				".git",
				"package.json",
				"scripts",
			]);
		} finally {
			cleanup();
		}
	});

	test("verify mode with a wrong-runtime pin makes no registry call", () => {
		const { dir, repo, cleanup } = repoWithPins("9.9.9");
		try {
			const meta = join(dir, "artifact.json");
			writeFileSync(meta, "{}");
			const r = runEntry(repo, dir, ["--verify-published", meta]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("9.9.9");
			expect(r.calls).toBe("");
			expect(readFileSync(meta, "utf8")).toBe("{}");
		} finally {
			cleanup();
		}
	});

	test("a non-empty output dir fails before any registry call and is untouched", () => {
		const { dir, repo, cleanup } = repoWithPins(Bun.version);
		try {
			const out = join(dir, "evidence");
			mkdirSync(out);
			writeFileSync(join(out, "artifact.json"), "old");
			const r = runEntry(repo, dir, ["--output-dir", out]);
			expect(r.code).toBe(1);
			expect(r.out).toMatch(/not empty/);
			expect(r.calls).toBe("");
			expect(readdirSync(out)).toEqual(["artifact.json"]);
			expect(readFileSync(join(out, "artifact.json"), "utf8")).toBe("old");
		} finally {
			cleanup();
		}
	});

	test("an output dir inside the source repo fails before any registry call", () => {
		const { dir, repo, cleanup } = repoWithPins(Bun.version);
		try {
			const out = join(repo, "evidence");
			const r = runEntry(repo, dir, ["--output-dir", out]);
			expect(r.code).toBe(1);
			expect(r.out).toMatch(/source/);
			expect(r.calls).toBe("");
			expect(existsSync(out)).toBe(false);
		} finally {
			cleanup();
		}
	});
});

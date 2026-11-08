import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const checkSubject = (subject: string) =>
	spawnSync("sh", ["scripts/commit-subject-ok.sh", subject], {
		cwd: root,
		encoding: "utf8",
	});

const checkMessage = (firstLine: string) => {
	const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
	const messagePath = join(dir, "COMMIT_EDITMSG");
	try {
		writeFileSync(messagePath, `${firstLine}\n\nbody text\n`);
		return spawnSync("sh", ["githooks/commit-msg", messagePath], {
			cwd: root,
			encoding: "utf8",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("commit subject checker", () => {
	test("accepts each of the eleven allowed types", () => {
		for (const type of [
			"feat",
			"fix",
			"perf",
			"revert",
			"docs",
			"test",
			"build",
			"ci",
			"chore",
			"refactor",
			"style",
		]) {
			const result = checkSubject(`${type}: describe the change`);
			expect(result.status, type).toBe(0);
		}
	});

	test("accepts scopes, breaking markers, and combinations", () => {
		for (const subject of [
			"feat(providers): add quota view",
			"fix(chart)!: handle empty history",
			"feat!: drop legacy config",
			"chore(main): release 9.9.9",
			"refactor(release-acceptance): split audit gate",
		]) {
			expect(checkSubject(subject).status, subject).toBe(0);
		}
	});

	test("accepts merge and revert subjects git creates on its own", () => {
		for (const subject of [
			"Merge branch 'main' into feature",
			"Merge pull request #12 from miha/topic",
			"Merge remote-tracking branch 'origin/main'",
			'Revert "feat: add provider filtering"',
		]) {
			expect(checkSubject(subject).status, subject).toBe(0);
		}
	});

	test("rejects empty and malformed subjects with guidance on stderr", () => {
		for (const subject of [
			"",
			"feat",
			"feat:",
			"feat:no space",
			"feat: ",
			"fix(scope):",
			"feat():  x",
			"feat(a(b)): nested scope",
			"feat!:no space",
			"FEAT: upper case type",
			" feat: leading space",
			"updated stuff",
			"wip: unknown type",
			"release: 1.0.0",
			"Merge something unrelated",
		]) {
			const result = checkSubject(subject);
			expect(result.status, JSON.stringify(subject)).toBe(1);
			expect(result.stderr, JSON.stringify(subject)).toContain(
				"Allowed commit subjects",
			);
		}
	});

	test("rejects a missing subject argument", () => {
		const result = spawnSync("sh", ["scripts/commit-subject-ok.sh"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
	});
});

const git = (cwd: string, args: string[]): string => {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};

describe("commit subject checker with commit identity", () => {
	const customMerge = "Merge feature/topic into main";
	let repo = "";
	let ordinary = "";
	let merge = "";
	let otherMerge = "";

	const check = (subject: string, ...rest: string[]) =>
		spawnSync(
			"sh",
			[join(root, "scripts/commit-subject-ok.sh"), subject, ...rest],
			{ cwd: repo, encoding: "utf8" },
		);

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "subject-fixture-"));
		git(repo, ["init", "-q", "-b", "main"]);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "feat: base"]);
		git(repo, ["checkout", "-q", "-b", "topic"]);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "feat: topic"]);
		git(repo, ["checkout", "-q", "main"]);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "fix: main work"]);
		ordinary = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["merge", "-q", "--no-ff", "topic", "-m", customMerge]);
		merge = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["checkout", "-q", "-b", "other", ordinary]);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "Merge other into main"]);
		otherMerge = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["checkout", "-q", "main"]);
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("accepts a custom merge subject verified as a multi-parent commit", () => {
		const result = check(customMerge, merge);
		expect(result.status, result.stderr).toBe(0);
	});

	test("rejects a custom merge subject without commit identity", () => {
		expect(check(customMerge).status).toBe(1);
		expect(check(customMerge, "").status).toBe(1);
	});

	test("rejects identity for an ordinary single-parent commit", () => {
		expect(check("Merge other into main", otherMerge).status).toBe(1);
		expect(check("Merge feature/topic into main", ordinary).status).toBe(1);
	});

	test("rejects mismatched subject or identity", () => {
		expect(check("Merge feature/other into main", merge).status).toBe(1);
		expect(check(`${customMerge} `, merge).status).toBe(1);
		expect(check(customMerge, ordinary).status).toBe(1);
		expect(check(customMerge, "0".repeat(40)).status).toBe(1);
		expect(check(customMerge, merge.slice(0, 12)).status).toBe(1);
		expect(check(customMerge, "main").status).toBe(1);
		expect(check(customMerge, "HEAD").status).toBe(1);
	});

	test("rejects malformed custom merge subjects even for a merge commit", () => {
		for (const subject of [
			"Merge  into main",
			"Merge into main",
			"Merge a into ",
			"Merge a into",
			"Merge something unrelated",
			"merge a into b",
		]) {
			expect(check(subject, merge).status, subject).toBe(1);
		}
	});

	test("rejects option injection through the identity argument", () => {
		for (const id of [
			"--help",
			"-n1",
			"--output=/tmp/x",
			`--end-of-options ${merge}`,
			`${merge} --all`,
			`${merge}\n${merge}`,
			`${merge}^{commit}`,
			`${merge}~0`,
			`${merge}^@`,
		]) {
			expect(check(customMerge, id).status, id).toBe(1);
		}
	});

	test("rejects extra arguments and still honours conventional subjects", () => {
		expect(check(customMerge, merge, "extra").status).toBe(1);
		expect(check("feat: fine", ordinary).status).toBe(0);
		expect(check("feat: fine", "--bogus").status).toBe(0);
	});
});

describe("commit-msg hook", () => {
	test("passes a conventional first line", () => {
		expect(checkMessage("fix: ok").status).toBe(0);
	});

	test("fails a non-conventional first line", () => {
		const result = checkMessage("nope");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("commit subject rejected: nope");
	});

	test("checker and hook are executable so git and CI can run them", () => {
		for (const path of [
			"scripts/commit-subject-ok.sh",
			"githooks/commit-msg",
		]) {
			expect(statSync(join(root, path)).mode & 0o111, path).not.toBe(0);
		}
	});
});

describe("hook setup script", () => {
	test("is owner-run only, with no npm lifecycle hooks", () => {
		const manifest = JSON.parse(read("package.json"));
		expect(manifest.scripts.setup).toBe("git config core.hooksPath githooks");
		for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
			expect(manifest.scripts[hook]).toBeUndefined();
		}
	});
});

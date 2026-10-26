import { describe, expect, test } from "bun:test";
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
			"chore(main): release 0.1.1",
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

	test("hook delegates to the shared checker instead of duplicating the policy", () => {
		const hook = read("githooks/commit-msg");
		expect(hook).toContain("scripts/commit-subject-ok.sh");
		expect(hook).not.toContain("allowlist");
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

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateBunAudit } from "../scripts/bun-audit-gate";

const root = fileURLToPath(new URL("..", import.meta.url));
const gateScript = join(root, "scripts", "bun-audit-gate.ts");

const advisory = (severity: string) => ({
	id: 1,
	url: "https://github.com/advisories/GHSA-test",
	severity,
	title: "test advisory",
});

const report = (severity: string) =>
	JSON.stringify({ "vulnerable-pkg": [advisory(severity)] });

describe("bun audit gate decisions", () => {
	test("passes a clean audit", () => {
		const decision = gateBunAudit({ code: 0, stdout: "{}", stderr: "" });
		expect(decision.ok).toBe(true);
	});

	test("passes moderate and low advisories, which do not block", () => {
		for (const severity of ["moderate", "low"]) {
			const decision = gateBunAudit({
				code: 1,
				stdout: report(severity),
				stderr: "",
			});
			expect(decision.ok, severity).toBe(true);
		}
	});

	test("fails any high advisory, even when the exit code is zero", () => {
		const decision = gateBunAudit({
			code: 0,
			stdout: report("high"),
			stderr: "",
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toContain("high");
	});

	test("fails any critical advisory", () => {
		const decision = gateBunAudit({
			code: 1,
			stdout: report("critical"),
			stderr: "",
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toContain("critical");
	});

	test("fails malformed JSON", () => {
		const decision = gateBunAudit({ code: 0, stdout: "{not json", stderr: "" });
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toContain("not JSON");
	});

	test("fails network-error text instead of treating it as clean", () => {
		const decision = gateBunAudit({
			code: 0,
			stdout: "error: POST https://registry ConnectionRefused",
			stderr: "",
		});
		expect(decision.ok).toBe(false);
	});

	test("fails an unknown severity", () => {
		const decision = gateBunAudit({
			code: 1,
			stdout: report("urgent"),
			stderr: "",
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toContain("unknown severity");
	});

	test("fails exit code 1 with no advisories as unknown", () => {
		const decision = gateBunAudit({ code: 1, stdout: "{}", stderr: "boom" });
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toContain("unknown");
	});

	test("fails any exit code other than 0 or 1", () => {
		for (const code of [2, 127, 255]) {
			const decision = gateBunAudit({ code, stdout: "{}", stderr: "" });
			expect(decision.ok, String(code)).toBe(false);
		}
	});
});

describe("bun audit gate CLI as run by CI", () => {
	const withFakeBun = (
		stdout: string,
		code: number,
		run: (env: Record<string, string>) => void,
	) => {
		const dir = mkdtempSync(join(tmpdir(), "fake-bun-"));
		try {
			const payload = join(dir, "payload.txt");
			writeFileSync(payload, stdout);
			const fake = join(dir, "bun");
			writeFileSync(
				fake,
				`#!/bin/sh\nif [ "$1" = "audit" ] && [ "$2" = "--json" ]; then cat "${payload}"; exit ${code}; fi\nexit 99\n`,
			);
			chmodSync(fake, 0o755);
			run({ PATH: `${dir}:${process.env.PATH ?? ""}` });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	const runGate = (env: Record<string, string>) =>
		spawnSync(process.execPath, [gateScript], {
			cwd: root,
			env: { ...process.env, ...env },
			encoding: "utf8",
		});

	test("exits zero on a clean audit", () => {
		withFakeBun("{}", 0, (env) => {
			const result = runGate(env);
			expect(result.status, result.stderr).toBe(0);
		});
	});

	test("exits nonzero on high advisories parsed from JSON", () => {
		withFakeBun(report("high"), 1, (env) => {
			const result = runGate(env);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain("high");
		});
	});

	test("exits nonzero on malformed JSON", () => {
		withFakeBun("{oops", 0, (env) => {
			expect(runGate(env).status).not.toBe(0);
		});
	});

	test("exits nonzero on unknown severity", () => {
		withFakeBun(report("urgent"), 1, (env) => {
			expect(runGate(env).status).not.toBe(0);
		});
	});

	test("exits nonzero on exit 1 with no advisories", () => {
		withFakeBun("{}", 1, (env) => {
			expect(runGate(env).status).not.toBe(0);
		});
	});

	test("exits zero when only moderate advisories are present", () => {
		withFakeBun(report("moderate"), 1, (env) => {
			expect(runGate(env).status).toBe(0);
		});
	});
});

/**
 * Source-lockfile audit gate for CI. Runs `bun audit --json` and applies the
 * same strict parsing and blocking rules as release acceptance: unusable
 * output, unknown severities, exit 1 with no entries, and any high or critical
 * advisory all fail closed. There is no waiver mechanism.
 */
import {
	type AuditSummary,
	auditGate,
	type CommandResult,
	summarizeBunAudit,
} from "./release-acceptance";

export type BunAuditDecision =
	| { ok: true; summary: AuditSummary }
	| { ok: false; reason: string };

/** Decide whether a completed `bun audit --json` run passes the gate. */
export function gateBunAudit(result: CommandResult): BunAuditDecision {
	if (result.code !== 0 && result.code !== 1) {
		return {
			ok: false,
			reason: `bun audit exited ${result.code}; stderr (tail):\n${result.stderr.slice(-2000)}`,
		};
	}
	let summary: AuditSummary;
	try {
		summary = summarizeBunAudit(result.stdout);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `bun audit output is not usable: ${reason}` };
	}
	try {
		auditGate("bun audit", result.code, summary);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	return { ok: true, summary };
}

if (import.meta.main) {
	const proc = Bun.spawnSync({
		cmd: ["bun", "audit", "--json"],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const decision = gateBunAudit({
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	});
	if (decision.ok) {
		const counts = Object.entries(decision.summary.counts)
			.map(([severity, count]) => `${severity}=${count}`)
			.join(" ");
		console.log(
			`bun audit: no high/critical advisories (${counts || "no advisories"})`,
		);
	} else {
		console.error(`✗ bun audit gate failed:\n${decision.reason}`);
		process.exitCode = 1;
	}
}

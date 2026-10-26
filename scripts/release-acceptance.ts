/**
 * Release artifact acceptance for opencode-providers-usage.
 *
 * One gate that runs before any publish step:
 *   - export HEAD with `git archive` into a fresh scratch directory (no dist/,
 *     no node_modules/, no working-tree edits)
 *   - install the export with a frozen Bun lockfile and lifecycle scripts
 *     disabled, then prove tests, lint, typecheck, and build pass
 *   - audit the source lockfile with native `bun audit`
 *   - pack exactly one tarball with `npm pack` (its prepack runs the build)
 *   - inspect the tarball paths, manifest, root shims, and dist imports strictly
 *   - install the tarball plus the host peers into a scratch consumer and import
 *     all four export paths from that consumer
 *   - audit the consumer production tree with `npm audit --omit=dev --json`
 *   - preserve the validated tarball, artifact.json, and raw audit evidence in
 *     the explicit --output-dir
 *
 * The script never publishes and never modifies the repository. Unknown
 * registry, audit, network, or auth results fail closed. There is no waiver
 * mechanism. `--allow-published` is local validation only and is refused in CI.
 *
 * `--verify-published <artifact.json>` checks that the registry version and
 * dist.integrity match the metadata acceptance produced, with a bounded retry
 * for npm propagation.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** The package this gate accepts. Acceptance refuses any other manifest name. */
export const EXPECTED_PACKAGE_NAME = "opencode-providers-usage";

/** The only paths the published tarball may contain (Task 1 artifact contract). */
export const ALLOWED_ARTIFACT_FILES = [
	"package/package.json",
	"package/README.md",
	"package/LICENSE",
	"package/index.js",
	"package/tui.js",
	"package/rpc.js",
	"package/dist/index.js",
	"package/dist/rpc.js",
	"package/dist/tui.js",
] as const;

/** Runtime bundles produced by `scripts/build.ts`. */
export const EXPECTED_BUNDLES = [
	"dist/index.js",
	"dist/rpc.js",
	"dist/tui.js",
] as const;

export const EXPECTED_MAIN = "./dist/index.js";

/** The four public export paths, each a plain string target. */
export const EXPECTED_EXPORTS: Readonly<Record<string, string>> = {
	".": "./dist/index.js",
	"./server": "./dist/index.js",
	"./tui": "./dist/tui.js",
	"./rpc": "./dist/rpc.js",
};

/** Root JS shims shipped for local discovery. Their exact text is part of the contract. */
export const ROOT_SHIMS: Readonly<Record<string, string>> = {
	"index.js": 'export { default } from "./dist/index.js"',
	"tui.js": 'export { default } from "./dist/tui.js"',
	"rpc.js": 'export * from "./dist/rpc.js"',
};

/**
 * Host runtimes each bundle must keep as external imports. This list mirrors
 * the imports the built bundles actually contain, not a generic template.
 */
export const REQUIRED_EXTERNAL_IMPORTS: Readonly<
	Record<string, readonly string[]>
> = {
	"dist/index.js": ["@opencode/plugin"],
	"dist/rpc.js": ["@opencode/plugin"],
	"dist/tui.js": [
		"@opencode/plugin",
		"@opencode/plugin/tui",
		"@opentui/core",
		"@opentui/solid/jsx-runtime",
		"solid-js",
	],
};

const BANNED_CONTENT_PATTERNS: readonly RegExp[] = [
	/task-[0-9]+-report/, // internal task reports
	/BEGIN [A-Z ]*PRIVATE KEY/, // PEM private key blocks
];

const LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall"] as const;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ArtifactMetadata {
	name: string;
	version: string;
	filename: string;
	path: string;
	integrity: string;
	shasum: string;
	sha256: string;
}

export type AcceptanceOptions =
	| { mode: "accept"; outputDir: string; allowPublished: boolean }
	| { mode: "verify"; metadataPath: string };

export type RegistryLookup =
	| { status: "unpublished" }
	| { status: "published"; version: string }
	| { status: "error"; code?: string; detail: string };

export type PublishedLookup =
	| { status: "published"; version: unknown; integrity: unknown }
	| { status: "error"; code?: string; detail: string };

export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface AuditEntry {
	name: string;
	severity: AuditSeverity;
	advisories: string[];
}

export interface AuditSummary {
	entries: AuditEntry[];
	counts: Record<AuditSeverity, number>;
	high: number;
	critical: number;
}

export interface VerificationOutcome {
	ok: boolean;
	detail: string;
	attempts: number;
}

export interface ConsumerExportResult {
	specifier: string;
	resolved: string;
	hasDefault: boolean;
	keys: string[];
}

export function allowedArtifactFile(path: string): boolean {
	return (ALLOWED_ARTIFACT_FILES as readonly string[]).includes(path);
}

export function bannedArtifactContent(
	content: string,
	sourceRoot: string,
): boolean {
	if (BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(content)))
		return true;
	return sourceRoot.length > 0 && content.includes(sourceRoot);
}

class AcceptanceFailure extends Error {
	readonly check: string;

	constructor(check: string, message: string) {
		super(message);
		this.name = "AcceptanceFailure";
		this.check = check;
	}
}

function exec(
	cmd: string[],
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): CommandResult {
	const proc = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function tail(text: string, lines = 20): string {
	const trimmed = text.trimEnd();
	if (!trimmed) return "";
	return trimmed.split("\n").slice(-lines).join("\n");
}

function describeFailure(label: string, result: CommandResult): string {
	const parts = [`${label} exited ${result.code}`];
	const stdout = tail(result.stdout);
	const stderr = tail(result.stderr);
	if (stdout) parts.push(`stdout (tail):\n${stdout}`);
	if (stderr) parts.push(`stderr (tail):\n${stderr}`);
	return parts.join("\n");
}

function requireOk(check: string, label: string, result: CommandResult): void {
	if (result.code !== 0)
		throw new AcceptanceFailure(check, describeFailure(label, result));
}

function require(
	condition: unknown,
	check: string,
	message: string,
): asserts condition {
	if (!condition) throw new AcceptanceFailure(check, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the first JSON object/array in command output that may have a log prefix. */
function parseJsonDocument(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("command produced no JSON output");
	const start = trimmed.search(/[[{"]/);
	if (start === -1)
		throw new Error(`command output has no JSON:\n${tail(text)}`);
	return JSON.parse(trimmed.slice(start)) as unknown;
}

/** Audit output must be exactly one JSON document. Any extra text is malformed. */
function parseAuditJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`audit output is not JSON (${reason}):\n${tail(stdout)}`);
	}
}

/** Extract the JSON array from `npm pack --json`, tolerating prepack stdout. */
function parsePackOutput(
	stdout: string,
): Array<{ filename: string; integrity: string; shasum: string }> {
	const lines = stdout.split("\n");
	const start = lines.findIndex((line) => line.trimStart().startsWith("["));
	if (start === -1)
		throw new Error(`npm pack output has no JSON array:\n${tail(stdout)}`);
	const parsed: unknown = JSON.parse(lines.slice(start).join("\n"));
	if (!Array.isArray(parsed)) throw new Error("npm pack JSON is not an array");
	return parsed as Array<{
		filename: string;
		integrity: string;
		shasum: string;
	}>;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root)) {
		const full = join(root, entry);
		if (statSync(full).isDirectory()) files.push(...walkFiles(full));
		else files.push(full);
	}
	return files;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** npm pack reports SRI sha512; recompute it to prove the preserved bytes. */
export function sha512SriFile(path: string): string {
	const digest = createHash("sha512")
		.update(readFileSync(path))
		.digest("base64");
	return `sha512-${digest}`;
}

export { sha256File };

export function createArtifactMetadata(input: {
	name: string;
	version: string;
	filename: string;
	path: string;
	integrity: string;
	shasum: string;
	sha256: string;
}): ArtifactMetadata {
	for (const [field, value] of Object.entries(input)) {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error(`artifact metadata field ${field} is missing`);
		}
	}
	const packagePart = input.name.replace(/^@/, "").replace(/\//g, "-");
	const expectedFilename = `${packagePart}-${input.version}.tgz`;
	if (input.filename !== expectedFilename) {
		throw new Error(
			`artifact filename ${input.filename} does not match ${expectedFilename}`,
		);
	}
	if (!input.integrity.startsWith("sha512-")) {
		throw new Error(
			`artifact integrity is not an npm sha512 SRI: ${input.integrity}`,
		);
	}
	return { ...input };
}

export function validateArtifactMetadata(value: unknown): ArtifactMetadata {
	if (!isRecord(value)) throw new Error("artifact metadata is not an object");
	const fields = [
		"name",
		"version",
		"filename",
		"path",
		"integrity",
		"shasum",
		"sha256",
	];
	const input: Record<string, string> = {};
	for (const field of fields) {
		const item = value[field];
		if (typeof item !== "string")
			throw new Error(`artifact metadata field ${field} is missing`);
		input[field] = item;
	}
	return createArtifactMetadata(
		input as Parameters<typeof createArtifactMetadata>[0],
	);
}

/**
 * Copy the accepted tarball to the explicit output directory and write
 * artifact.json. The source bytes, the copied bytes, and npm's pack integrity
 * must all agree before any file is written.
 */
export function preserveArtifact(input: {
	source: string;
	outputDir: string;
	name: string;
	version: string;
	filename: string;
	integrity: string;
	shasum: string;
}): ArtifactMetadata {
	const sourceIntegrity = sha512SriFile(input.source);
	if (sourceIntegrity !== input.integrity) {
		throw new Error(
			`tarball integrity ${sourceIntegrity} does not match npm pack integrity ${input.integrity}`,
		);
	}
	const outputDir = resolve(input.outputDir);
	const metadata = createArtifactMetadata({
		name: input.name,
		version: input.version,
		filename: input.filename,
		path: join(outputDir, input.filename),
		integrity: input.integrity,
		shasum: input.shasum,
		sha256: sha256File(input.source),
	});
	mkdirSync(outputDir, { recursive: true });
	copyFileSync(input.source, metadata.path);
	const copiedIntegrity = sha512SriFile(metadata.path);
	if (copiedIntegrity !== input.integrity) {
		throw new Error(
			`preserved tarball integrity ${copiedIntegrity} does not match accepted ${input.integrity}`,
		);
	}
	writeFileSync(
		join(outputDir, "artifact.json"),
		`${JSON.stringify(metadata, null, 2)}\n`,
	);
	return metadata;
}

function jsonError(text: string): { code?: string; detail: string } {
	try {
		const parsed = parseJsonDocument(text);
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const code =
				typeof parsed.error.code === "string" ? parsed.error.code : undefined;
			const summary =
				typeof parsed.error.summary === "string"
					? parsed.error.summary
					: undefined;
			const detail =
				typeof parsed.error.detail === "string"
					? parsed.error.detail
					: undefined;
			return {
				code,
				detail: [summary, detail].filter(Boolean).join(": ") || tail(text, 5),
			};
		}
	} catch {
		// Fall through to the raw output tail.
	}
	return { detail: tail(text, 5) };
}

/** Distinguish "version not published" (E404) from registry/auth/network outages. */
export function classifyRegistryLookup(result: CommandResult): RegistryLookup {
	if (result.code === 0) {
		try {
			const parsed = parseJsonDocument(result.stdout);
			if (typeof parsed === "string" && parsed.length > 0) {
				return { status: "published", version: parsed };
			}
			if (
				Array.isArray(parsed) &&
				typeof parsed[0] === "string" &&
				parsed[0].length > 0
			) {
				return { status: "published", version: parsed[0] };
			}
			return {
				status: "error",
				detail: "npm view succeeded without a version",
			};
		} catch (error) {
			return {
				status: "error",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const info = jsonError(result.stdout);
	const fallback = info.detail ? info : jsonError(result.stderr);
	if (fallback.code === "E404") return { status: "unpublished" };
	return {
		status: "error",
		code: fallback.code,
		detail: fallback.detail || tail(result.stderr, 5),
	};
}

export function registryGuardDecision(
	lookup: RegistryLookup,
	options: { allowPublished: boolean },
):
	| { ok: true; detail: string; warning?: string }
	| { ok: false; detail: string } {
	if (lookup.status === "unpublished")
		return { ok: true, detail: "version is not published" };
	if (lookup.status === "error") {
		const code = lookup.code ? ` (${lookup.code})` : "";
		return {
			ok: false,
			detail: `registry lookup failed${code}; refusing to guess whether the version is available: ${lookup.detail}`,
		};
	}
	if (!options.allowPublished) {
		return {
			ok: false,
			detail: `version ${lookup.version} is already published; published versions are immutable. Use --allow-published only for explicit local validation.`,
		};
	}
	return {
		ok: true,
		detail: "already published (explicit --allow-published local bypass)",
		warning: `version ${lookup.version} is already published; continuing because --allow-published was passed`,
	};
}

export function parseAcceptanceArgs(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
): AcceptanceOptions {
	let outputDir: string | undefined;
	let verifyPublished: string | undefined;
	let allowPublished = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--output-dir") {
			const value = argv[index + 1];
			if (!value) throw new Error("--output-dir requires a directory");
			outputDir = value;
			index += 1;
		} else if (argument?.startsWith("--output-dir=")) {
			outputDir = argument.slice("--output-dir=".length);
		} else if (argument === "--verify-published") {
			const value = argv[index + 1];
			if (!value)
				throw new Error("--verify-published requires an artifact.json path");
			verifyPublished = value;
			index += 1;
		} else if (argument?.startsWith("--verify-published=")) {
			verifyPublished = argument.slice("--verify-published=".length);
		} else if (argument === "--allow-published") {
			allowPublished = true;
		} else {
			throw new Error(`unknown argument: ${argument ?? "<empty>"}`);
		}
	}

	if (allowPublished && (env.CI === "true" || env.GITHUB_ACTIONS === "true")) {
		throw new Error(
			"--allow-published is for explicit local validation only; CI must always fail on duplicate versions",
		);
	}
	if (verifyPublished) {
		if (outputDir)
			throw new Error(
				"--verify-published cannot be combined with --output-dir",
			);
		if (allowPublished)
			throw new Error(
				"--verify-published cannot be combined with --allow-published",
			);
		return { mode: "verify", metadataPath: verifyPublished };
	}
	if (!outputDir) {
		throw new Error(
			"--output-dir is required so the accepted tarball and audit evidence are preserved",
		);
	}
	if (!isAbsolute(outputDir)) {
		throw new Error(`--output-dir must be an absolute directory: ${outputDir}`);
	}
	return { mode: "accept", outputDir, allowPublished };
}

const AUDIT_SEVERITIES: readonly AuditSeverity[] = [
	"info",
	"low",
	"moderate",
	"high",
	"critical",
];

function isAuditSeverity(value: unknown): value is AuditSeverity {
	return (
		typeof value === "string" &&
		(AUDIT_SEVERITIES as readonly string[]).includes(value)
	);
}

function zeroCounts(): Record<AuditSeverity, number> {
	return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

/** The advisory identifier for one report item, or undefined when it has none. */
function advisoryIdentifier(item: Record<string, unknown>): string | undefined {
	if (typeof item.url === "string" && item.url.length > 0) return item.url;
	if (typeof item.title === "string" && item.title.length > 0)
		return item.title;
	if (
		typeof item.github_advisory_id === "string" &&
		item.github_advisory_id.length > 0
	) {
		return item.github_advisory_id;
	}
	if (typeof item.id === "string" && item.id.length > 0) return item.id;
	if (typeof item.id === "number" && Number.isInteger(item.id))
		return String(item.id);
	return undefined;
}

/**
 * Parse `npm audit --json` and reject malformed or internally inconsistent
 * output. Every entry is returned so the caller can block on high/critical.
 * This function has no waiver mechanism.
 */
export function summarizeNpmAudit(stdout: string): AuditSummary {
	const parsed = parseAuditJson(stdout);
	if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities)) {
		throw new Error("npm audit JSON has no vulnerabilities object");
	}
	if (
		!isRecord(parsed.metadata) ||
		!isRecord(parsed.metadata.vulnerabilities)
	) {
		throw new Error("npm audit JSON has no metadata.vulnerabilities object");
	}

	const counts = zeroCounts();
	const entries: AuditEntry[] = [];
	for (const [key, value] of Object.entries(parsed.vulnerabilities)) {
		if (!isRecord(value))
			throw new Error(`npm audit vulnerability ${key} is not an object`);
		if (!isAuditSeverity(value.severity)) {
			throw new Error(`npm audit vulnerability ${key} has an unknown severity`);
		}
		if (!Array.isArray(value.via)) {
			throw new Error(`npm audit vulnerability ${key} has no via array`);
		}
		const advisories: string[] = [];
		for (const item of value.via) {
			if (typeof item === "string") {
				advisories.push(item);
			} else if (isRecord(item)) {
				const identifier = advisoryIdentifier(item);
				if (!identifier)
					throw new Error(
						`npm audit vulnerability ${key} has malformed advisory data`,
					);
				advisories.push(identifier);
			} else {
				throw new Error(
					`npm audit vulnerability ${key} has malformed advisory data`,
				);
			}
		}
		const name =
			typeof value.name === "string" && value.name.length > 0
				? value.name
				: key;
		entries.push({ name, severity: value.severity, advisories });
		counts[value.severity] += 1;
	}

	for (const severity of AUDIT_SEVERITIES) {
		const reported = parsed.metadata.vulnerabilities[severity];
		if (
			typeof reported !== "number" ||
			!Number.isInteger(reported) ||
			reported < 0
		) {
			throw new Error(
				`npm audit metadata is missing a valid ${severity} count`,
			);
		}
		if (reported !== counts[severity]) {
			throw new Error(
				`npm audit ${severity} count ${reported} disagrees with entries (${counts[severity]})`,
			);
		}
	}

	return { entries, counts, high: counts.high, critical: counts.critical };
}

/**
 * Parse `bun audit --json`. Bun reports `{}` when clean and otherwise maps each
 * package to its advisories. Any shape outside that is malformed and fails closed.
 */
export function summarizeBunAudit(stdout: string): AuditSummary {
	const parsed = parseAuditJson(stdout);
	if (!isRecord(parsed)) throw new Error("bun audit JSON is not an object");

	const counts = zeroCounts();
	const entries: AuditEntry[] = [];
	for (const [name, value] of Object.entries(parsed)) {
		if (!Array.isArray(value))
			throw new Error(`bun audit entry ${name} is malformed`);
		for (const item of value) {
			if (!isRecord(item))
				throw new Error(`bun audit entry ${name} has malformed advisory data`);
			if (!isAuditSeverity(item.severity))
				throw new Error(`bun audit entry ${name} has an unknown severity`);
			const identifier = advisoryIdentifier(item);
			if (!identifier)
				throw new Error(`bun audit entry ${name} has malformed advisory data`);
			entries.push({ name, severity: item.severity, advisories: [identifier] });
			counts[item.severity] += 1;
		}
	}

	return { entries, counts, high: counts.high, critical: counts.critical };
}

/** A null result means the audit has no unhandled high or critical advisory. */
export function blockingAuditDetail(summary: AuditSummary): string | null {
	if (summary.high === 0 && summary.critical === 0) return null;
	const blocking = summary.entries.filter(
		(entry) => entry.severity === "high" || entry.severity === "critical",
	);
	const lines = blocking.map((entry) => {
		const advisories =
			entry.advisories.length > 0 ? ` via ${entry.advisories.join("; ")}` : "";
		return `- ${entry.severity}: ${entry.name}${advisories}`;
	});
	const noun = summary.high + summary.critical === 1 ? "entry" : "entries";
	return `${summary.high} high and ${summary.critical} critical advisory ${noun} block release:\n${lines.join("\n")}`;
}

export function classifyPublishedLookup(
	result: CommandResult,
): PublishedLookup {
	if (result.code === 0) {
		try {
			const parsed = parseJsonDocument(result.stdout);
			if (!isRecord(parsed))
				return { status: "error", detail: "npm view returned a non-object" };
			return {
				status: "published",
				version: parsed.version,
				integrity: parsed["dist.integrity"],
			};
		} catch (error) {
			return {
				status: "error",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const info = jsonError(result.stdout);
	const fallback = info.detail ? info : jsonError(result.stderr);
	return {
		status: "error",
		code: fallback.code,
		detail: fallback.detail || tail(result.stderr, 5),
	};
}

export function publishedArtifactProblem(
	actual: { version?: unknown; integrity?: unknown },
	expected: Pick<ArtifactMetadata, "version" | "integrity">,
): string | null {
	if (actual.version !== expected.version) {
		return `registry version ${String(actual.version)} does not match accepted ${expected.version}`;
	}
	if (actual.integrity !== expected.integrity) {
		return `registry integrity ${String(actual.integrity)} does not match accepted ${expected.integrity}`;
	}
	return null;
}

/**
 * Retry propagation failures every five seconds for up to 61 lookups (five
 * minutes of waits; registry request time is additional). Fail immediately on
 * a wrong published artifact.
 */
export async function verifyPublishedArtifact(
	metadata: ArtifactMetadata,
	lookup: () => PublishedLookup,
	options: {
		attempts?: number;
		delayMs?: number;
		wait?: (ms: number) => Promise<void>;
	} = {},
): Promise<VerificationOutcome> {
	const attempts = options.attempts ?? 61;
	const delayMs = options.delayMs ?? 5_000;
	const wait =
		options.wait ??
		((ms: number) =>
			new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
	let last = "no registry response";

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = lookup();
		if (result.status === "published") {
			const problem = publishedArtifactProblem(result, metadata);
			if (!problem) {
				return {
					ok: true,
					detail: `registry ${metadata.name}@${metadata.version} matches accepted integrity`,
					attempts: attempt,
				};
			}
			return { ok: false, detail: problem, attempts: attempt };
		}
		last = `${result.code ? `${result.code}: ` : ""}${result.detail}`;
		if (attempt < attempts) await wait(delayMs);
	}
	return {
		ok: false,
		detail: `registry did not report ${metadata.name}@${metadata.version} with the accepted integrity after ${attempts} attempt(s): ${last}`,
		attempts,
	};
}

/** The only tarball entries allowed are the approved paths; nothing else may appear or repeat. */
export function validateArtifactListing(entries: readonly string[]): void {
	const seen = new Set<string>();
	const duplicates: string[] = [];
	for (const entry of entries) {
		if (seen.has(entry)) duplicates.push(entry);
		seen.add(entry);
	}
	if (duplicates.length > 0)
		throw new Error(`duplicate artifact path(s): ${duplicates.join(", ")}`);

	const unexpected = entries.filter((entry) => !allowedArtifactFile(entry));
	if (unexpected.length > 0)
		throw new Error(`undeclared artifact path(s): ${unexpected.join(", ")}`);

	const missing = ALLOWED_ARTIFACT_FILES.filter((entry) => !seen.has(entry));
	if (missing.length > 0)
		throw new Error(`missing artifact path(s): ${missing.join(", ")}`);
}

/** Identity, license, access, the exact export map, main, and absence of consumer install hooks. */
export function validateArtifactManifest(
	manifest: unknown,
	expected: { name: string; version: string },
): void {
	if (!isRecord(manifest))
		throw new Error("artifact manifest is not an object");
	if (
		manifest.name !== expected.name ||
		manifest.version !== expected.version
	) {
		throw new Error(
			`wrong package identity ${String(manifest.name)}@${String(manifest.version)}; expected ${expected.name}@${expected.version}`,
		);
	}
	if (manifest.license !== "MIT")
		throw new Error("artifact license is not MIT");
	const publishConfig = isRecord(manifest.publishConfig)
		? manifest.publishConfig
		: {};
	if (publishConfig.access !== "public")
		throw new Error("artifact publish access is not public");
	if (manifest.main !== EXPECTED_MAIN)
		throw new Error(`artifact main entry changed: ${String(manifest.main)}`);

	const exportsField = isRecord(manifest.exports)
		? manifest.exports
		: undefined;
	const actualKeys = exportsField ? Object.keys(exportsField).sort() : [];
	const expectedKeys = Object.keys(EXPECTED_EXPORTS).sort();
	const matches =
		actualKeys.length === expectedKeys.length &&
		expectedKeys.every(
			(key, index) =>
				actualKeys[index] === key &&
				exportsField?.[key] === EXPECTED_EXPORTS[key],
		);
	if (!matches) {
		throw new Error(
			`artifact export map changed; expected exactly ${JSON.stringify(EXPECTED_EXPORTS)}`,
		);
	}

	const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
	for (const hook of LIFECYCLE_HOOKS) {
		if (scripts[hook])
			throw new Error(`consumer lifecycle hook present: ${hook}`);
	}
}

const packageNameOf = (specifier: string): string => {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? specifier);
};

const importedSpecifiers = (code: string): string[] =>
	[
		...code.matchAll(
			/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
		),
	].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

/**
 * A bundle may import only node builtins and declared host packages, never
 * relative or checkout-only paths, and must keep its required host runtimes as
 * external imports.
 */
export function validateBundleImports(
	file: string,
	code: string,
	hostPackages: ReadonlySet<string>,
): void {
	const specifiers = importedSpecifiers(code);
	for (const specifier of specifiers) {
		if (specifier.startsWith(".") || specifier.startsWith("/")) {
			throw new Error(
				`${file} has a relative or absolute import: ${specifier}`,
			);
		}
		if (specifier.startsWith("node:")) continue;
		if (!hostPackages.has(packageNameOf(specifier))) {
			throw new Error(`${file} has an undeclared import: ${specifier}`);
		}
	}
	if (/["'](?:\.\.?\/)?src\//.test(code) || /\.tsx?["']/.test(code)) {
		throw new Error(`${file} references checkout-only source`);
	}
	for (const required of REQUIRED_EXTERNAL_IMPORTS[file] ?? []) {
		if (!specifiers.includes(required)) {
			throw new Error(`host runtime is not external: ${required} (${file})`);
		}
	}
}

/** Root shims must re-export the dist modules with their exact approved text. */
export function validateRootShims(
	contents: Readonly<Record<string, string | undefined>>,
): void {
	for (const [file, expected] of Object.entries(ROOT_SHIMS)) {
		const actual = contents[file];
		if (actual === undefined) throw new Error(`root shim ${file} is missing`);
		if (actual.trim() !== expected)
			throw new Error(
				`root shim ${file} does not match the approved re-export`,
			);
	}
}

/** Escape a package name for use inside a RegExp. */
const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Read each named package's top-level resolved version from bun.lock. Bun keys
 * top-level entries by bare name at four-space indent; nested copies are keyed
 * as "parent/name" and never match. A missing or ambiguous entry fails closed.
 */
export function lockedVersions(
	bunLockText: string,
	names: readonly string[],
): Map<string, string> {
	const versions = new Map<string, string>();
	for (const name of names) {
		const escaped = escapeRegExp(name);
		const pattern = new RegExp(
			`^ {4}"${escaped}": \\["${escaped}@([^"]+)"`,
			"gm",
		);
		const found = [...bunLockText.matchAll(pattern)].map((match) => match[1]);
		if (found.length > 1)
			throw new Error(
				`multiple locked versions for ${name} in the source lockfile`,
			);
		const version = found[0];
		if (!version)
			throw new Error(`no locked version for ${name} in the source lockfile`);
		versions.set(name, version);
	}
	return versions;
}

/**
 * Pin each declared host peer to the version the source lockfile resolves. That
 * set is the configuration the package is built and tested against. Each locked
 * version must satisfy the declared peer range, checked with Bun's semver.
 */
export function pinnedPeerSpecs(
	peerDependencies: Record<string, string>,
	locked: ReadonlyMap<string, string>,
): string[] {
	return Object.entries(peerDependencies).map(([name, range]) => {
		const version = locked.get(name);
		if (!version)
			throw new Error(
				`host peer ${name} is not resolved in the source lockfile`,
			);
		if (!Bun.semver.satisfies(version, range)) {
			throw new Error(
				`locked host peer ${name}@${version} does not satisfy ${range}`,
			);
		}
		return `${name}@${version}`;
	});
}

/** The installed consumer must hold exactly the pinned peer versions. */
export function validateInstalledVersions(
	installed: ReadonlyMap<string, string | undefined>,
	expected: ReadonlyMap<string, string>,
): void {
	for (const [name, version] of expected) {
		const actual = installed.get(name);
		if (actual !== version)
			throw new Error(
				`installed ${name}@${actual} does not match pinned ${version}`,
			);
	}
}

/** npm pack must produce exactly one tarball with the expected filename. */
export function requireSingleTarball(
	names: readonly string[],
	expected: string,
): void {
	if (names.length !== 1) {
		throw new Error(
			`expected exactly one tarball, npm pack reported ${names.length}`,
		);
	}
	if (names[0] !== expected) {
		throw new Error(`unexpected artifact ${names[0]}; expected ${expected}`);
	}
}

/**
 * Every export must resolve from the installed consumer copy, not from the
 * source checkout, to its approved dist target, and must expose a usable module.
 */
export function validateConsumerExports(
	results: readonly ConsumerExportResult[],
	options: {
		consumerDir: string;
		name: string;
		exports: Readonly<Record<string, string>>;
	},
): void {
	const installedRoot = normalize(
		join(options.consumerDir, "node_modules", options.name),
	);
	for (const [specifier, target] of Object.entries(options.exports)) {
		const result = results.find((entry) => entry.specifier === specifier);
		if (!result)
			throw new Error(`export ${specifier} was not imported in the consumer`);

		const resolved = normalize(result.resolved);
		if (!resolved.startsWith(installedRoot + sep)) {
			throw new Error(
				`export ${specifier} resolves outside the consumer install: ${result.resolved}`,
			);
		}
		const expectedPath = normalize(join(installedRoot, target));
		if (resolved !== expectedPath) {
			throw new Error(
				`export ${specifier} resolved to ${result.resolved}, expected ${expectedPath}`,
			);
		}
		if (!result.hasDefault && result.keys.length === 0) {
			throw new Error(`export ${specifier} exposes no usable module`);
		}
	}
}

/** Fail closed on an audit: unusable output, an exit code that disagrees with the findings, or any high/critical advisory. */
export function auditGate(
	label: string,
	exitCode: number,
	summary: AuditSummary,
): void {
	if (exitCode === 1 && summary.entries.length === 0) {
		throw new Error(
			`${label} exited 1 but reported no advisories; treating the audit as unknown`,
		);
	}
	const blocking = blockingAuditDetail(summary);
	if (blocking) throw new Error(blocking);
}

/** Host packages whose resolution the consumer pins with an npm override (see consumerManifest). */
export const CONSUMER_OVERRIDE_PACKAGES: readonly string[] = ["solid-js"];

/** A package as installed in the consumer, read from its node_modules package.json. */
export interface InstalledPackage {
	version?: string;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * Resolve each override name to its locked version. Every occurrence of the
 * package in the consumer tree, including the exact solid-js peer declared by
 * @opentui/solid, is then forced to that version. This is an explicit, reviewed
 * resolution of the tested configuration, not a relaxed install.
 */
export function consumerOverrides(
	lockedHost: ReadonlyMap<string, string>,
	names: readonly string[] = CONSUMER_OVERRIDE_PACKAGES,
): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const name of names) {
		const version = lockedHost.get(name);
		if (!version)
			throw new Error(
				`override ${name} has no locked version in the source lockfile`,
			);
		overrides[name] = version;
	}
	return overrides;
}

/** The consumer package.json: a private scratch project that carries the npm overrides. */
export function consumerManifest(
	overrides: Readonly<Record<string, string>>,
): Record<string, unknown> {
	return {
		name: "release-acceptance-consumer",
		private: true,
		version: "0.0.0",
		overrides: { ...overrides },
	};
}

/** npm install arguments for the consumer. The strict peer check stays on; no legacy flag. */
export function consumerInstallArgs(input: {
	consumer: string;
	tarball: string;
	peers: readonly string[];
}): string[] {
	return [
		"npm",
		"install",
		"--prefix",
		input.consumer,
		"--omit=dev",
		"--ignore-scripts",
		"--save-exact",
		"--no-audit",
		"--no-fund",
		input.tarball,
		...input.peers,
	];
}

/**
 * Verify the installed peer closure. Every declared, non-optional peer of each
 * root host package must be installed. A peer with an override or a locked
 * version must match that pin exactly. Otherwise it must satisfy its declared range.
 */
export function validatePeerClosure(input: {
	installed: ReadonlyMap<string, InstalledPackage>;
	roots: readonly string[];
	locked: ReadonlyMap<string, string>;
	overrides: ReadonlyMap<string, string>;
}): void {
	for (const root of input.roots) {
		const rootPackage = input.installed.get(root);
		if (!rootPackage?.version)
			throw new Error(`host peer ${root} is not installed`);
		for (const [peer, range] of Object.entries(
			rootPackage.peerDependencies ?? {},
		)) {
			if (rootPackage.peerDependenciesMeta?.[peer]?.optional) continue;
			const dependency = input.installed.get(peer);
			if (!dependency?.version)
				throw new Error(`${root} requires peer ${peer} which is not installed`);
			const pin = input.overrides.get(peer) ?? input.locked.get(peer);
			if (pin !== undefined) {
				if (dependency.version !== pin) {
					throw new Error(
						`peer ${peer}@${dependency.version} does not match pinned ${pin} required by ${root}`,
					);
				}
			} else if (!Bun.semver.satisfies(dependency.version, range)) {
				throw new Error(
					`peer ${peer}@${dependency.version} does not satisfy ${range} required by ${root}`,
				);
			}
		}
	}
}

function repoRoot(): string {
	const result = exec(["git", "rev-parse", "--show-toplevel"], process.cwd());
	requireOk("repo", "git rev-parse --show-toplevel", result);
	return resolve(result.stdout.trim());
}

function readArtifactMetadataFile(path: string): ArtifactMetadata {
	const absolute = resolve(path);
	if (!existsSync(absolute))
		throw new Error(`artifact metadata not found: ${absolute}`);
	return validateArtifactMetadata(readJson<unknown>(absolute));
}

async function runVerification(metadataPath: string): Promise<number> {
	try {
		const metadata = readArtifactMetadataFile(metadataPath);
		const outcome = await verifyPublishedArtifact(metadata, () =>
			classifyPublishedLookup(
				exec(
					[
						"npm",
						"view",
						`${metadata.name}@${metadata.version}`,
						"version",
						"dist.integrity",
						"--json",
					],
					process.cwd(),
				),
			),
		);
		if (!outcome.ok) {
			console.error(
				`✗ registry verification failed after ${outcome.attempts} attempt(s): ${outcome.detail}`,
			);
			return 1;
		}
		console.log(
			`✓ registry verification passed after ${outcome.attempts} attempt(s): ${outcome.detail}`,
		);
		return 0;
	} catch (error) {
		console.error(
			`✗ registry verification failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}

/**
 * Runs inside a separate Bun process from the scratch checks directory, with the
 * consumer as its argument. Each export is resolved through the consumer's own
 * node_modules, so the source checkout is never consulted.
 */
const EXPORT_CHECK_SCRIPT = `const [consumerDir, name, keysJson] = process.argv.slice(2);
const keys = JSON.parse(keysJson);
const results = [];
for (const key of keys) {
  const resolved = Bun.resolveSync(name + key.slice(1), consumerDir);
  const mod = await import(resolved);
  results.push({ specifier: key, resolved, hasDefault: mod.default !== undefined, keys: Object.keys(mod).sort() });
}
console.log("EXPORT_CHECK_JSON:" + JSON.stringify(results));
`;

function parseExportCheck(stdout: string): ConsumerExportResult[] {
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith("EXPORT_CHECK_JSON:"));
	if (!line)
		throw new Error(`export check produced no result line:\n${tail(stdout)}`);
	const parsed: unknown = JSON.parse(line.slice("EXPORT_CHECK_JSON:".length));
	if (!Array.isArray(parsed))
		throw new Error("export check result is not an array");
	return parsed as ConsumerExportResult[];
}

function jsonSummary(counts: Record<AuditSeverity, number>): string {
	return AUDIT_SEVERITIES.map(
		(severity) => `${severity}=${counts[severity]}`,
	).join(" ");
}

function runAcceptance(
	options: Extract<AcceptanceOptions, { mode: "accept" }>,
): number {
	const passed: string[] = [];
	const warnings: string[] = [];
	const outputDir = resolve(options.outputDir);
	let scratch: string | undefined;

	const pass = (name: string, detail?: string): void => {
		passed.push(name);
		console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
	};
	const warn = (message: string): void => {
		warnings.push(message);
		console.log(`! ${message}`);
	};

	try {
		mkdirSync(outputDir, { recursive: true });
		const root = repoRoot();

		// 1. Preflight: this exact package, in-scope final version, clean tracked tree.
		const manifest = readJson<{ name?: string; version?: string }>(
			join(root, "package.json"),
		);
		const name = manifest.name;
		const version = manifest.version;
		require(name ===
			EXPECTED_PACKAGE_NAME, "preflight", `package name ${String(name)} is not ${EXPECTED_PACKAGE_NAME}`);
		require(typeof version === "string" &&
			version.length > 0, "preflight", "package.json has no version");
		require(!version.includes(
			"-",
		), "preflight", `version ${version} is a prerelease; acceptance only covers final releases`);

		const dirty = exec(
			["git", "status", "--porcelain", "--untracked-files=no"],
			root,
		);
		requireOk("preflight", "git status --porcelain", dirty);
		require(!dirty.stdout.trim(), "preflight", "tracked working tree has uncommitted changes; commit first, acceptance exports HEAD only");
		const head = exec(["git", "rev-parse", "HEAD"], root);
		requireOk("preflight", "git rev-parse HEAD", head);
		const commit = head.stdout.trim();
		pass("preflight", `${name}@${version} at ${commit}`);

		// 2. Registry guard. Versions are immutable. A duplicate is a hard failure
		// unless the caller explicitly opts into local validation. Registry, auth,
		// and network failures are never bypassable.
		const lookup = classifyRegistryLookup(
			exec(["npm", "view", `${name}@${version}`, "version", "--json"], root),
		);
		if (lookup.status === "published" && lookup.version !== version) {
			throw new AcceptanceFailure(
				"registry-guard",
				`registry reported ${lookup.version} for ${name}@${version}; refusing to continue`,
			);
		}
		const decision = registryGuardDecision(lookup, {
			allowPublished: options.allowPublished,
		});
		if (!decision.ok)
			throw new AcceptanceFailure("registry-guard", decision.detail);
		if (decision.warning) warn(decision.warning);
		pass("registry-guard", decision.detail);

		// 3. Clean export of HEAD, in two steps so each command's status is checked.
		const scratchRoot = process.env.SCRATCH_ROOT ?? tmpdir();
		require(existsSync(
			scratchRoot,
		), "clean-export", `scratch root does not exist: ${scratchRoot}`);
		scratch = mkdtempSync(join(scratchRoot, "release-acceptance."));
		require(!outputDir.startsWith(
			`${resolve(scratch)}${sep}`,
		), "clean-export", "output directory must not be inside the scratch directory");
		const source = join(scratch, "source");
		mkdirSync(source, { recursive: true });
		const archive = join(scratch, "source.tar");
		requireOk(
			"clean-export",
			"git archive",
			exec(
				["git", "-C", root, "archive", "--format=tar", "-o", archive, "HEAD"],
				root,
			),
		);
		requireOk(
			"clean-export",
			"tar -x",
			exec(["tar", "-x", "-f", archive, "-C", source], root),
		);
		rmSync(archive, { force: true });
		require(!existsSync(
			join(source, "dist"),
		), "clean-export", "exported tree already contains dist/");
		require(existsSync(
			join(source, "LICENSE"),
		), "clean-export", "exported tree is missing LICENSE");
		require(existsSync(
			join(source, "README.md"),
		), "clean-export", "exported tree is missing README.md");
		const exported = readJson<{ name?: string; version?: string }>(
			join(source, "package.json"),
		);
		require(exported.name === name &&
			exported.version ===
				version, "clean-export", `exported manifest ${exported.name}@${exported.version} differs from working tree ${name}@${version}`);
		pass("clean-export", `HEAD exported to ${source}`);

		// 4. The export must stand on its own. Frozen install with dependency lifecycle
		// scripts disabled. The package's own prepack still runs during npm pack.
		requireOk(
			"export-install",
			"bun install --frozen-lockfile --ignore-scripts",
			exec(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], source),
		);
		pass("export-install", "bun install --frozen-lockfile --ignore-scripts");

		requireOk("export-test", "bun test", exec(["bun", "test"], source));
		pass("export-test", "bun test");

		requireOk(
			"export-lint",
			"bun run lint",
			exec(["bun", "run", "lint"], source),
		);
		pass("export-lint", "bun run lint");

		requireOk(
			"export-typecheck",
			"bun run typecheck",
			exec(["bun", "run", "typecheck"], source),
		);
		pass("export-typecheck", "bun run typecheck");

		requireOk(
			"export-build",
			"bun run build",
			exec(["bun", "run", "build"], source),
		);
		const builtFiles = readdirSync(join(source, "dist")).sort();
		require(JSON.stringify(builtFiles) ===
			JSON.stringify(
				EXPECTED_BUNDLES.map((file) => file.slice("dist/".length)).sort(),
			), "export-build", `unexpected dist contents: ${builtFiles.join(", ")}`);
		pass("export-build", `dist: ${builtFiles.join(", ")}`);

		// 5. Native Bun audit of the source lockfile. Raw evidence is preserved.
		const bunAudit = exec(["bun", "audit", "--json"], source);
		const bunAuditPath = join(outputDir, "bun-audit.json");
		writeFileSync(bunAuditPath, bunAudit.stdout);
		if (bunAudit.stderr.trim())
			writeFileSync(join(outputDir, "bun-audit.stderr.txt"), bunAudit.stderr);
		require(bunAudit.code === 0 ||
			bunAudit.code ===
				1, "bun-audit", `bun audit exited ${bunAudit.code}; stderr (tail):\n${tail(bunAudit.stderr)}`);
		let bunSummary: AuditSummary;
		try {
			bunSummary = summarizeBunAudit(bunAudit.stdout);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AcceptanceFailure(
				"bun-audit",
				`bun audit output is not usable: ${reason}\nEvidence: ${bunAuditPath}`,
			);
		}
		try {
			auditGate("bun audit", bunAudit.code, bunSummary);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AcceptanceFailure(
				"bun-audit",
				`${reason}\nEvidence: ${bunAuditPath}`,
			);
		}
		pass(
			"bun-audit",
			`source lockfile, no high/critical advisories (${jsonSummary(bunSummary.counts)})`,
		);

		// 6. Pack once. Exactly one tarball may exist in the scratch directory.
		// Lifecycle scripts are not disabled for this step, so the package prepack runs.
		const pack = exec(
			["npm", "pack", "--json", "--pack-destination", scratch],
			source,
		);
		requireOk("pack", "npm pack --json", pack);
		const packed = parsePackOutput(pack.stdout);
		const tarballs = readdirSync(scratch).filter((entry) =>
			entry.endsWith(".tgz"),
		);
		const expectedFilename = `${name}-${version}.tgz`;
		requireSingleTarball(tarballs, expectedFilename);
		require(packed.length ===
			1, "pack", `expected exactly one tarball, npm pack reported ${packed.length}`);
		const pkg = packed[0];
		require(pkg !== undefined, "pack", "npm pack reported no tarball");
		require(pkg.filename ===
			expectedFilename, "pack", `unexpected artifact ${pkg.filename}; expected ${expectedFilename}`);
		require(typeof pkg.integrity === "string" &&
			pkg.integrity.length > 0, "pack", "artifact has no integrity");
		require(typeof pkg.shasum === "string" &&
			pkg.shasum.length > 0, "pack", "artifact has no shasum");
		const tarball = join(scratch, pkg.filename);
		require(sha512SriFile(tarball) ===
			pkg.integrity, "pack", `tarball SRI ${sha512SriFile(tarball)} does not match npm pack integrity ${pkg.integrity}`);
		pass("pack", `${pkg.filename} (integrity ${pkg.integrity})`);

		// 7. Tar listing must contain exactly the approved artifact paths.
		const listing = exec(["tar", "-tzf", tarball], scratch);
		requireOk("artifact-allowlist", "tar -tzf", listing);
		const entries = listing.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		try {
			validateArtifactListing(entries);
		} catch (error) {
			throw new AcceptanceFailure(
				"artifact-allowlist",
				error instanceof Error ? error.message : String(error),
			);
		}
		pass(
			"artifact-allowlist",
			`${entries.length} file(s), exactly the approved set`,
		);

		// 8. Unpack and validate identity, license, access, export map, and hooks.
		const unpacked = join(scratch, "unpacked");
		mkdirSync(unpacked, { recursive: true });
		requireOk(
			"manifest",
			"tar -xzf",
			exec(["tar", "-xzf", tarball, "-C", unpacked], scratch),
		);
		const packageDir = join(unpacked, "package");
		const installedManifest = readJson<{
			name?: string;
			version?: string;
			license?: string;
			main?: string;
			publishConfig?: { access?: string };
			exports?: Record<string, unknown>;
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		}>(join(packageDir, "package.json"));
		try {
			validateArtifactManifest(installedManifest, { name, version });
		} catch (error) {
			throw new AcceptanceFailure(
				"manifest",
				error instanceof Error ? error.message : String(error),
			);
		}
		const rootShims: Record<string, string | undefined> = {};
		for (const shim of Object.keys(ROOT_SHIMS)) {
			const shimPath = join(packageDir, shim);
			rootShims[shim] = existsSync(shimPath)
				? readFileSync(shimPath, "utf8")
				: undefined;
		}
		try {
			validateRootShims(rootShims);
		} catch (error) {
			throw new AcceptanceFailure(
				"manifest",
				error instanceof Error ? error.message : String(error),
			);
		}
		pass(
			"manifest",
			`${name}@${version}, MIT, public, exact export map, no lifecycle hooks, root shims intact`,
		);

		// 9. Strict import inspection. Host runtimes stay external and nothing checkout-only leaks in.
		const hostPackages = new Set([
			...Object.keys(installedManifest.dependencies ?? {}),
			...Object.keys(installedManifest.peerDependencies ?? {}),
		]);
		for (const bundleFile of EXPECTED_BUNDLES) {
			const code = readFileSync(join(packageDir, bundleFile), "utf8");
			try {
				validateBundleImports(bundleFile, code, hostPackages);
			} catch (error) {
				throw new AcceptanceFailure(
					"host-runtime-externals",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		pass("host-runtime-externals", JSON.stringify(REQUIRED_EXTERNAL_IMPORTS));

		// 10. No internal reports, secrets, or absolute checkout paths.
		const artifactText = walkFiles(packageDir)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		const leaks = [root, source].filter((rootPath) =>
			bannedArtifactContent(artifactText, rootPath),
		);
		require(leaks.length ===
			0, "content-scan", `artifact contains internal, secret, or checkout-path material: ${leaks.join(", ")}`);
		pass(
			"content-scan",
			"no internal report, private key, or absolute checkout path",
		);

		// 11. Consumer install: the tarball, the locked host peers, and an npm override
		// that pins solid-js to the locked version. Strict peer resolution stays on.
		// Nothing else is installed, and the consumer tree is audited in step 13.
		const consumer = join(scratch, "consumer");
		mkdirSync(consumer, { recursive: true });
		const bunLockText = readFileSync(join(source, "bun.lock"), "utf8");
		const hostPeers = installedManifest.peerDependencies ?? {};
		const lockedPeers = lockedVersions(bunLockText, Object.keys(hostPeers));
		const peers = pinnedPeerSpecs(hostPeers, lockedPeers);
		const overrides = consumerOverrides(lockedPeers);
		writeFileSync(
			join(consumer, "package.json"),
			`${JSON.stringify(consumerManifest(overrides), null, 2)}\n`,
		);
		requireOk(
			"consumer-install",
			"npm install tarball with locked host peers and the solid-js override",
			exec(consumerInstallArgs({ consumer, tarball, peers }), consumer),
		);
		require(existsSync(
			join(consumer, "package-lock.json"),
		), "consumer-install", "consumer install did not produce a package-lock.json");
		const installedDir = join(consumer, "node_modules", name);
		require(existsSync(
			join(installedDir, "dist", "tui.js"),
		), "consumer-install", `installed package is missing dist/tui.js at ${installedDir}`);
		const consumerManifestRead = readJson<{ version?: string }>(
			join(installedDir, "package.json"),
		);
		require(consumerManifestRead.version ===
			version, "consumer-install", `installed version ${consumerManifestRead.version} != ${version}`);

		const readInstalled = (pkg: string): InstalledPackage | undefined => {
			const manifestPath = join(consumer, "node_modules", pkg, "package.json");
			return existsSync(manifestPath)
				? readJson<InstalledPackage>(manifestPath)
				: undefined;
		};
		const installed = new Map<string, InstalledPackage>();
		for (const peer of lockedPeers.keys()) {
			const peerPackage = readInstalled(peer);
			if (!peerPackage) continue;
			installed.set(peer, peerPackage);
			// A required peer that is absent stays out of the map, so validatePeerClosure reports it.
			for (const child of Object.keys(peerPackage.peerDependencies ?? {})) {
				if (peerPackage.peerDependenciesMeta?.[child]?.optional) continue;
				const childPackage = readInstalled(child);
				if (childPackage) installed.set(child, childPackage);
			}
		}
		const closureLock = lockedVersions(bunLockText, [...installed.keys()]);
		try {
			validateInstalledVersions(
				new Map(
					[...lockedPeers.keys()].map((peer) => [
						peer,
						installed.get(peer)?.version,
					]),
				),
				lockedPeers,
			);
			validatePeerClosure({
				installed,
				roots: Object.keys(hostPeers),
				locked: closureLock,
				overrides: new Map(Object.entries(overrides)),
			});
		} catch (error) {
			throw new AcceptanceFailure(
				"consumer-install",
				error instanceof Error ? error.message : String(error),
			);
		}
		pass(
			"consumer-install",
			`${name}@${version} with locked host peers (${peers.join(", ")}), solid-js override ${JSON.stringify(overrides)}, peer closure verified, installed with --omit=dev --ignore-scripts`,
		);

		// 12. Import all four export paths from the consumer, not the checkout.
		const checks = join(scratch, "checks");
		mkdirSync(checks, { recursive: true });
		const checkScript = join(checks, "export-check.mjs");
		writeFileSync(checkScript, EXPORT_CHECK_SCRIPT);
		const exportKeys = Object.keys(EXPECTED_EXPORTS);
		const exportCheck = exec(
			[
				"bun",
				checkScript,
				realpathSync(consumer),
				name,
				JSON.stringify(exportKeys),
			],
			checks,
		);
		requireOk("consumer-exports", "bun export check", exportCheck);
		let exportResults: ConsumerExportResult[];
		try {
			exportResults = parseExportCheck(exportCheck.stdout);
			validateConsumerExports(exportResults, {
				consumerDir: realpathSync(consumer),
				name,
				exports: EXPECTED_EXPORTS,
			});
		} catch (error) {
			throw new AcceptanceFailure(
				"consumer-exports",
				error instanceof Error ? error.message : String(error),
			);
		}
		pass(
			"consumer-exports",
			exportResults
				.map(
					(result) =>
						`${result.specifier} -> ${result.resolved.slice(realpathSync(consumer).length + 1)}`,
				)
				.join("; "),
		);

		// 13. Advisory audit of the production consumer. Raw evidence is preserved.
		const audit = exec(["npm", "audit", "--omit=dev", "--json"], consumer);
		const auditJsonPath = join(outputDir, "npm-audit-omit-dev.json");
		writeFileSync(auditJsonPath, audit.stdout);
		if (audit.stderr.trim()) {
			writeFileSync(
				join(outputDir, "npm-audit-omit-dev.stderr.txt"),
				audit.stderr,
			);
		}
		require(audit.code === 0 ||
			audit.code ===
				1, "consumer-audit", `npm audit exited ${audit.code}; stderr (tail):\n${tail(audit.stderr)}`);
		let npmSummary: AuditSummary;
		try {
			npmSummary = summarizeNpmAudit(audit.stdout);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AcceptanceFailure(
				"consumer-audit",
				`npm audit output is not usable: ${reason}\nstdout (tail):\n${tail(audit.stdout)}\nstderr (tail):\n${tail(audit.stderr)}\nEvidence: ${auditJsonPath}`,
			);
		}
		try {
			auditGate("npm audit", audit.code, npmSummary);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AcceptanceFailure(
				"consumer-audit",
				`${reason}\nEvidence: ${auditJsonPath}`,
			);
		}
		pass(
			"consumer-audit",
			`npm audit --omit=dev, no high/critical advisories (${jsonSummary(npmSummary.counts)})`,
		);

		// 14. Preserve exactly the validated tarball plus machine-readable metadata.
		const metadata = preserveArtifact({
			source: tarball,
			outputDir,
			name,
			version,
			filename: pkg.filename,
			integrity: pkg.integrity,
			shasum: pkg.shasum,
		});
		pass(
			"artifact-output",
			`${metadata.path} (integrity ${metadata.integrity})`,
		);

		// 15. Summary. The artifact hashes and audit evidence are part of release evidence.
		console.log("");
		console.log("Release acceptance summary");
		console.log(`  commit:    ${commit}`);
		console.log(`  artifact:  ${metadata.filename}`);
		console.log(`  path:      ${metadata.path}`);
		console.log(`  shasum:    ${metadata.shasum}`);
		console.log(`  integrity: ${metadata.integrity}`);
		console.log(`  sha256:    ${metadata.sha256}`);
		console.log(
			`  bun audit: ${jsonSummary(bunSummary.counts)} (evidence ${bunAuditPath})`,
		);
		console.log(
			`  npm audit: ${jsonSummary(npmSummary.counts)} (evidence ${auditJsonPath})`,
		);
		if (warnings.length > 0) {
			console.log(`  warnings (${warnings.length}):`);
			for (const warning of warnings) console.log(`    - ${warning}`);
		} else {
			console.log("  warnings:  none");
		}
		console.log(`  checks passed (${passed.length}):`);
		for (const check of passed) console.log(`    ✓ ${check}`);
		console.log("");
		console.log(
			options.allowPublished
				? "Local validation passed. --allow-published is NOT a publish approval."
				: "Artifact accepted for publication.",
		);
		return 0;
	} catch (error) {
		if (error instanceof AcceptanceFailure) {
			console.error(`✗ FAILED CHECK: ${error.check}`);
			console.error(error.message);
			for (const warning of warnings) console.error(`! ${warning}`);
		} else {
			console.error("✗ FAILED CHECK: unexpected-error");
			console.error(
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			);
		}
		console.error(
			`✗ Release acceptance failed; ${passed.length} check(s) passed before the failure.`,
		);
		return 1;
	} finally {
		if (scratch) {
			rmSync(scratch, { recursive: true, force: true });
			console.log(`scratch cleaned up: ${scratch}`);
		}
	}
}

export async function run(options: AcceptanceOptions): Promise<number> {
	return options.mode === "verify"
		? runVerification(options.metadataPath)
		: runAcceptance(options);
}

if (import.meta.main) {
	try {
		process.exitCode = await run(parseAcceptanceArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(
			`✗ ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}

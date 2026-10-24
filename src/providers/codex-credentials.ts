import { createHash } from "node:crypto";
import type {
	CodexCompanion,
	CompanionOptions,
	CompanionRead,
	CredentialReadDeps,
} from "../core/contracts";

/**
 * Credential material is read from a bounded file; the bound is enforced while
 * reading through `CredentialReadDeps.readUtf8`, never trusted from a prior
 * size check.
 */
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const AUTH_FILE = "auth.json";
const CONFIG_FILE = "config.toml";
const STORAGE_KEY = "cli_auth_credentials_store";
const FILE_STORAGE = "file";

type BoundedText =
	| { state: "ok"; text: string }
	| { state: "missing" }
	| { state: "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}
	if (error.code === "ENOENT") {
		return true;
	}
	const message = error instanceof Error ? error.message : "";
	return /ENOENT|no such file/i.test(message);
}

async function readBounded(
	path: string,
	deps: CredentialReadDeps,
): Promise<BoundedText> {
	let text: string;
	try {
		text = await deps.readUtf8(path, MAX_CREDENTIAL_BYTES);
	} catch (error) {
		return isMissingError(error) ? { state: "missing" } : { state: "error" };
	}
	if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIAL_BYTES) {
		return { state: "error" };
	}
	return { state: "ok", text };
}

function normalizeDirectory(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return undefined;
	}
	const withoutTrailing = trimmed.replace(/\/+$/, "");
	return withoutTrailing === "" ? "/" : withoutTrailing;
}

function joinPath(base: string, name: string): string {
	return base === "/" ? `/${name}` : `${base}/${name}`;
}

/**
 * Resolution order is the trusted server-side option first, then `CODEX_HOME`,
 * then the conventional `~/.codex` directory. The TUI never supplies this.
 */
function resolveHome(
	optionHome: string | undefined,
	deps: CredentialReadDeps,
): string {
	const configured = normalizeDirectory(optionHome);
	if (configured !== undefined) {
		return configured;
	}
	const fromEnv = normalizeDirectory(deps.env.CODEX_HOME);
	if (fromEnv !== undefined) {
		return fromEnv;
	}
	const homeDirectory =
		normalizeDirectory(deps.homeDirectory) ?? deps.homeDirectory;
	return joinPath(homeDirectory, ".codex");
}

/** Strips a TOML comment while respecting quoted strings. */
function stripComment(line: string): string {
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (quote === '"') {
			if (character === "\\") {
				index += 1;
			} else if (character === '"') {
				quote = undefined;
			}
		} else if (quote === "'") {
			if (character === "'") {
				quote = undefined;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "#") {
			return line.slice(0, index);
		}
	}
	return line;
}

function unquoteKey(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length < 2) {
		return trimmed;
	}
	const first = trimmed[0];
	if (
		(first === '"' || first === "'") &&
		trimmed[trimmed.length - 1] === first
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseStringValue(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed.length < 2) {
		return undefined;
	}
	const quote = trimmed[0];
	if (quote !== '"' && quote !== "'") {
		return undefined;
	}
	if (trimmed[trimmed.length - 1] !== quote) {
		return undefined;
	}
	const inner = trimmed.slice(1, -1);
	// Escaped or embedded quotes do not occur in the supported literal enum;
	// treating them as ambiguous is safer than decoding them here.
	if (inner.includes("\\") || inner.includes(quote)) {
		return undefined;
	}
	return inner;
}

/**
 * Inspects only the effective top-level `cli_auth_credentials_store` setting.
 * File-backed storage and the absent setting default are supported; every
 * other explicit or unreadable value is rejected as ambiguous so a leftover
 * `auth.json` from another storage backend is never read. The absent-config
 * default is File in the Codex versions this reader targets; if Codex changes
 * that default, this assumption must be revalidated before enabling the reader.
 */
function resolveStorageMode(text: string): "file" | "unsupported" {
	let inTable = false;
	let found: string | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripComment(rawLine).trim();
		if (line === "") {
			continue;
		}
		if (line.startsWith("[")) {
			inTable = true;
			continue;
		}
		const equals = line.indexOf("=");
		if (equals < 0) {
			continue;
		}
		if (unquoteKey(line.slice(0, equals)) !== STORAGE_KEY) {
			continue;
		}
		// Keys after a table header belong to that table, not the root.
		if (inTable) {
			continue;
		}
		if (found !== undefined) {
			return "unsupported";
		}
		const value = parseStringValue(line.slice(equals + 1));
		if (value === undefined) {
			return "unsupported";
		}
		found = value;
	}
	if (found === undefined || found === FILE_STORAGE) {
		return "file";
	}
	return "unsupported";
}

/**
 * JWT decoding is a validation convenience only: signatures are not verified,
 * and no decoded value is treated as proof of cryptographic identity.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}
	const segment = parts[1];
	if (segment === undefined || segment === "") {
		return undefined;
	}
	let decoded: string;
	try {
		decoded = Buffer.from(segment, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	return isRecord(value) ? value : undefined;
}

function accountIDsFromClaims(claims: Record<string, unknown>): string[] {
	const ids = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value.trim() !== "") {
			ids.add(value);
		}
	};
	const auth = claims["https://api.openai.com/auth"];
	if (isRecord(auth)) {
		add(auth.chatgpt_account_id);
	}
	add(claims.chatgpt_account_id);
	add(claims.account_id);
	return [...ids];
}

function matchesAccount(
	claims: Record<string, unknown>,
	accountID: string,
): boolean {
	return accountIDsFromClaims(claims).every((id) => id === accountID);
}

/**
 * A nonsecret internal fingerprint. It changes when the account or the cached
 * access token changes so late results for an obsolete identity are discarded,
 * without retaining or returning either value as the key.
 */
function identityKeyFor(accountID: string, accessToken: string): string {
	return createHash("sha256")
		.update(`${accountID}\u0000${accessToken}`)
		.digest("hex");
}

function unavailable(reason: string): CompanionRead {
	return { state: "unavailable", reason };
}

function parseCredential(text: string, now: number): CompanionRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return unavailable("invalid_companion");
	}
	if (!isRecord(parsed)) {
		return unavailable("invalid_companion");
	}

	const authMode = parsed.auth_mode;
	if (authMode !== undefined && authMode !== "chatgpt") {
		return unavailable("invalid_companion");
	}

	const tokens = parsed.tokens;
	if (!isRecord(tokens)) {
		return unavailable("invalid_companion");
	}

	// Legacy caches omit `auth_mode`; a stored API key is not a quota
	// credential and makes the file ambiguous rather than ChatGPT-backed.
	if (authMode === undefined) {
		const apiKey = parsed.OPENAI_API_KEY;
		if (typeof apiKey === "string" && apiKey.trim() !== "") {
			return unavailable("invalid_companion");
		}
	}

	const accessToken = tokens.access_token;
	if (typeof accessToken !== "string" || accessToken.trim() === "") {
		return unavailable("invalid_companion");
	}

	const accountID = tokens.account_id;
	if (typeof accountID !== "string" || accountID.trim() === "") {
		return unavailable("invalid_companion");
	}

	const payload = decodeJwtPayload(accessToken);
	if (payload === undefined || !matchesAccount(payload, accountID)) {
		return unavailable("invalid_companion");
	}

	const idToken = tokens.id_token;
	if (idToken !== undefined) {
		if (typeof idToken !== "string") {
			return unavailable("invalid_companion");
		}
		const idPayload = decodeJwtPayload(idToken);
		if (idPayload === undefined || !matchesAccount(idPayload, accountID)) {
			return unavailable("invalid_companion");
		}
	}

	const exp = payload.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) {
		return unavailable("invalid_companion");
	}
	const expiresAt = exp * 1000;
	if (!Number.isFinite(expiresAt)) {
		return unavailable("invalid_companion");
	}
	if (expiresAt <= now) {
		return unavailable("companion_expired");
	}

	const credential: CodexCompanion = {
		accessToken,
		accountID,
		expiresAt,
		identityKey: identityKeyFor(accountID, accessToken),
	};
	return { state: "available", credential };
}

/**
 * Reads the cached ChatGPT companion credential without executing Codex,
 * writing anything, or renewing an expired token. Every call starts from disk
 * so Codex's own renewal is observed. The refresh token is never retained.
 */
export async function readCodexCompanion(
	options: CompanionOptions,
	deps: CredentialReadDeps,
): Promise<CompanionRead> {
	if (options.enabled !== true) {
		return unavailable("companion_disabled");
	}

	const home = resolveHome(options.home, deps);

	const config = await readBounded(joinPath(home, CONFIG_FILE), deps);
	if (config.state === "error") {
		return unavailable("unsupported_companion_storage");
	}
	if (
		config.state === "ok" &&
		resolveStorageMode(config.text) === "unsupported"
	) {
		return unavailable("unsupported_companion_storage");
	}

	const auth = await readBounded(joinPath(home, AUTH_FILE), deps);
	if (auth.state === "missing") {
		return unavailable("companion_missing");
	}
	if (auth.state === "error") {
		return unavailable("invalid_companion");
	}
	return parseCredential(auth.text, deps.now());
}

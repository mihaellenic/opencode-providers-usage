import { describe, expect, test } from "bun:test";
import type {
	CompanionOptions,
	CompanionRead,
	CredentialReadDeps,
} from "../../src/core/contracts";
import { readCodexCompanion } from "../../src/providers/codex-credentials";

const NOW = 1_790_000_000_000;
const MAX_BYTES = 256 * 1024;
const ACCESS_SENTINEL = "synthetic-access-token-sentinel";
const REFRESH_TOKEN = "synthetic-refresh-token-sentinel";
const ACCOUNT_ID = "synthetic-account-id";
const OTHER_ACCOUNT_ID = "synthetic-other-account-id";
const HOME = "/synthetic/codex";
const CONFIG_PATH = `${HOME}/config.toml`;
const AUTH_PATH = `${HOME}/auth.json`;
const FALLBACK_HOME = "/synthetic/home/.codex";

const ALLOWED_REASONS = new Set([
	"companion_disabled",
	"companion_missing",
	"companion_expired",
	"unsupported_companion_storage",
	"invalid_companion",
]);

type Observation = {
	paths: string[];
	limits: number[];
	calls: number;
};

function observation(): Observation {
	return { paths: [], limits: [], calls: 0 };
}

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function jwt(payload: Record<string, unknown>): string {
	const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
	return `${header}.${base64url(JSON.stringify(payload))}.${ACCESS_SENTINEL}`;
}

function claims(
	overrides: { accountID?: string; exp?: number | undefined } = {},
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: overrides.accountID ?? ACCOUNT_ID,
			chatgpt_user_id: "synthetic-user-id",
			chatgpt_plan_type: "plus",
		},
	};
	const exp =
		overrides.exp === undefined ? Math.floor(NOW / 1000) + 3600 : overrides.exp;
	if (exp !== null) {
		payload.exp = exp;
	}
	return payload;
}

const ACCESS_TOKEN = jwt(claims());

function authText(
	options: {
		tokenOverrides?: Record<string, unknown>;
		fileOverrides?: Record<string, unknown>;
	} = {},
): string {
	const file: Record<string, unknown> = {
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			id_token: jwt(claims()),
			access_token: ACCESS_TOKEN,
			refresh_token: REFRESH_TOKEN,
			account_id: ACCOUNT_ID,
			...options.tokenOverrides,
		},
		last_refresh: "2026-10-24T00:00:00Z",
		...options.fileOverrides,
	};
	return JSON.stringify(file);
}

function credentialDeps(
	files: Record<string, string>,
	options: {
		env?: Record<string, string | undefined>;
		homeDirectory?: string;
		observed?: Observation;
	} = {},
): { deps: CredentialReadDeps; observed: Observation } {
	const observed = options.observed ?? observation();
	return {
		observed,
		deps: {
			now: () => NOW,
			env: options.env ?? {},
			homeDirectory: options.homeDirectory ?? "/synthetic/home",
			async readUtf8(path, maxBytes) {
				observed.calls += 1;
				observed.paths.push(path);
				observed.limits.push(maxBytes);
				const content = files[path];
				if (content === undefined) {
					throw Object.assign(new Error(`ENOENT: ${path}`), {
						code: "ENOENT",
					});
				}
				if (Buffer.byteLength(content, "utf8") > maxBytes) {
					throw Object.assign(new Error(`too large: ${path}`), {
						code: "E2BIG",
					});
				}
				return content;
			},
		},
	};
}

async function read(
	files: Record<string, string>,
	options: CompanionOptions = { enabled: true, home: HOME },
	env: Record<string, string | undefined> = {},
	homeDirectory = "/synthetic/home",
): Promise<{ read: CompanionRead; observed: Observation }> {
	const setup = credentialDeps(files, {
		env,
		homeDirectory,
	});
	const result = await readCodexCompanion(options, setup.deps);
	return { read: result, observed: setup.observed };
}

/**
 * Diagnostics never contain credential material. An unavailable result must not
 * echo either synthetic token; an available result carries only the access
 * token (never the refresh token).
 */
function expectNoCredentialLeak(result: CompanionRead): void {
	const serialized = JSON.stringify(result);
	expect(serialized).not.toContain(REFRESH_TOKEN);
	if (result.state === "unavailable") {
		expect(serialized).not.toContain(ACCESS_SENTINEL);
	}
}

function expectReason(result: CompanionRead, reason: string): void {
	expect(result).toEqual({ state: "unavailable", reason });
	expect(ALLOWED_REASONS.has(reason)).toBe(true);
	expectNoCredentialLeak(result);
}

describe("explicit opt-out", () => {
	test("disabled_reader_never_accesses_disk", async () => {
		const files = {
			[CONFIG_PATH]: 'cli_auth_credentials_store = "file"\n',
			[AUTH_PATH]: authText(),
		};
		const disabled = await read(files, { enabled: false });
		expectReason(disabled.read, "companion_disabled");
		expect(disabled.observed.calls).toBe(0);
		expect(disabled.observed.paths).toEqual([]);

		const disabledWithHome = await read(files, {
			enabled: false,
			home: "/untrusted/ignored",
		});
		expectReason(disabledWithHome.read, "companion_disabled");
		expect(disabledWithHome.observed.calls).toBe(0);
	});
});

describe("Codex home resolution", () => {
	test("codex_home_env_selects_the_auth_directory", async () => {
		const envHome = "/synthetic/env-codex";
		const files = {
			[`${envHome}/config.toml`]: 'cli_auth_credentials_store = "file"\n',
			[`${envHome}/auth.json`]: authText(),
		};
		const { read: result, observed } = await read(
			files,
			{ enabled: true },
			{ CODEX_HOME: envHome },
		);
		expect(result.state).toBe("available");
		expect(observed.paths).toEqual([
			`${envHome}/config.toml`,
			`${envHome}/auth.json`,
		]);
		expect(observed.limits).toEqual([MAX_BYTES, MAX_BYTES]);
	});

	test("trusted_home_option_wins_over_codex_home", async () => {
		const envHome = "/synthetic/env-codex";
		const files = {
			[`${HOME}/auth.json`]: authText(),
			[`${envHome}/auth.json`]: authText(),
		};
		const { read: result, observed } = await read(
			files,
			{ enabled: true, home: `${HOME}/` },
			{ CODEX_HOME: envHome },
		);
		expect(result.state).toBe("available");
		expect(observed.paths).toEqual([CONFIG_PATH, AUTH_PATH]);
	});

	test("home_directory_fallback_is_dot_codex", async () => {
		const files = {
			[`${FALLBACK_HOME}/auth.json`]: authText(),
		};
		const { read: result, observed } = await read(files, { enabled: true });
		expect(result.state).toBe("available");
		expect(observed.paths).toEqual([
			`${FALLBACK_HOME}/config.toml`,
			`${FALLBACK_HOME}/auth.json`,
		]);
	});
});

describe("storage mode", () => {
	test("explicit_file_storage_is_supported", async () => {
		const files = {
			[CONFIG_PATH]: [
				'model = "synthetic-model"',
				'cli_auth_credentials_store = "file" # inline comment',
				"",
				"[tui]",
				'cli_auth_credentials_store = "keyring"',
			].join("\n"),
			[AUTH_PATH]: authText(),
		};
		const { read: result } = await read(files);
		expect(result.state).toBe("available");
	});

	test("absent_config_defaults_to_file_storage", async () => {
		const files = { [AUTH_PATH]: authText() };
		const { read: result, observed } = await read(files);
		expect(result.state).toBe("available");
		expect(observed.paths).toEqual([CONFIG_PATH, AUTH_PATH]);
	});

	test("commented_storage_key_is_ignored", async () => {
		const files = {
			[CONFIG_PATH]: [
				'# cli_auth_credentials_store = "keyring"',
				'model = "synthetic-model"',
			].join("\n"),
			[AUTH_PATH]: authText(),
		};
		const { read: result } = await read(files);
		expect(result.state).toBe("available");
	});

	for (const mode of [
		"keyring",
		"keychain",
		"encrypted",
		"ephemeral",
		"auto",
	]) {
		test(`explicit_${mode}_storage_is_unsupported_without_fallback`, async () => {
			const files = {
				[CONFIG_PATH]: `cli_auth_credentials_store = "${mode}"\n`,
				[AUTH_PATH]: authText(),
				[`${FALLBACK_HOME}/auth.json`]: authText(),
			};
			const { read: result, observed } = await read(
				files,
				{ enabled: true, home: HOME },
				{ CODEX_HOME: FALLBACK_HOME },
			);
			expectReason(result, "unsupported_companion_storage");
			// Only the configuration is inspected; no other credential store is
			// searched after the mode is known to be unsupported.
			expect(observed.paths).toEqual([CONFIG_PATH]);
			expect(observed.calls).toBe(1);
		});
	}

	test("ambiguous_storage_config_is_unsupported", async () => {
		const configs = [
			[
				'cli_auth_credentials_store = "file"',
				'cli_auth_credentials_store = "keyring"',
			].join("\n"),
			"cli_auth_credentials_store = 5\n",
			'cli_auth_credentials_store = ["file"]\n',
			'cli_auth_credentials_store = ""\n',
			'cli_auth_credentials_store = "FILE"\n',
		];
		for (const config of configs) {
			const files = { [CONFIG_PATH]: config, [AUTH_PATH]: authText() };
			const { read: result, observed } = await read(files);
			expectReason(result, "unsupported_companion_storage");
			expect(observed.paths).toEqual([CONFIG_PATH]);
		}
	});
});

describe("cached auth.json validation", () => {
	test("missing_cache_is_companion_missing", async () => {
		const { read: result, observed } = await read({});
		expectReason(result, "companion_missing");
		expect(observed.paths).toEqual([CONFIG_PATH, AUTH_PATH]);
		expect(observed.limits).toEqual([MAX_BYTES, MAX_BYTES]);
	});

	test("malformed_cache_is_invalid_companion", async () => {
		const { read: result } = await read({ [AUTH_PATH]: "{not json" });
		expectReason(result, "invalid_companion");
	});

	test("oversized_cache_is_rejected_with_the_bound_enforced_while_reading", async () => {
		const oversized = `{"padding":"${"x".repeat(MAX_BYTES)}"}`;
		expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_BYTES);
		const { read: result, observed } = await read({ [AUTH_PATH]: oversized });
		expectReason(result, "invalid_companion");
		expect(observed.limits).toEqual([MAX_BYTES, MAX_BYTES]);
	});

	test("api_key_login_is_not_a_chatgpt_companion", async () => {
		const files = {
			[AUTH_PATH]: JSON.stringify({
				auth_mode: "apikey",
				OPENAI_API_KEY: "synthetic-api-key-sentinel",
				tokens: null,
			}),
		};
		const { read: result } = await read(files);
		expectReason(result, "invalid_companion");
	});

	test("legacy_api_key_only_cache_is_rejected", async () => {
		const files = {
			[AUTH_PATH]: JSON.stringify({
				OPENAI_API_KEY: "synthetic-api-key-sentinel",
			}),
		};
		const { read: result } = await read(files);
		expectReason(result, "invalid_companion");
	});

	test("chatgpt_auth_mode_without_access_token_is_rejected", async () => {
		for (const accessToken of [undefined, "", "   "]) {
			const files = {
				[AUTH_PATH]: authText({
					tokenOverrides: { access_token: accessToken },
				}),
			};
			const { read: result } = await read(files);
			expectReason(result, "invalid_companion");
		}
	});

	test("absent_account_context_is_rejected", async () => {
		for (const accountID of [undefined, "", "   "]) {
			const files = {
				[AUTH_PATH]: authText({
					tokenOverrides: { account_id: accountID },
				}),
			};
			const { read: result } = await read(files);
			expectReason(result, "invalid_companion");
		}
	});

	test("conflicting_token_and_account_ids_are_rejected", async () => {
		const accessConflict = {
			[AUTH_PATH]: authText({
				tokenOverrides: {
					access_token: jwt(claims({ accountID: OTHER_ACCOUNT_ID })),
				},
			}),
		};
		expectReason((await read(accessConflict)).read, "invalid_companion");

		const idTokenConflict = {
			[AUTH_PATH]: authText({
				tokenOverrides: {
					id_token: jwt(claims({ accountID: OTHER_ACCOUNT_ID })),
				},
			}),
		};
		expectReason((await read(idTokenConflict)).read, "invalid_companion");
	});

	test("missing_exp_is_invalid", async () => {
		const payload = claims();
		delete payload.exp;
		const files = {
			[AUTH_PATH]: authText({
				tokenOverrides: { access_token: jwt(payload) },
			}),
		};
		expectReason((await read(files)).read, "invalid_companion");
	});

	test("expired_companion_never_refreshes_or_writes", async () => {
		const expired = authText({
			tokenOverrides: {
				access_token: jwt(claims({ exp: Math.floor(NOW / 1000) - 60 })),
			},
		});
		const files = { [AUTH_PATH]: expired };
		const setup = credentialDeps(files);
		const first = await readCodexCompanion(
			{ enabled: true, home: HOME },
			setup.deps,
		);
		expectReason(first, "companion_expired");
		expect(files[AUTH_PATH]).toBe(expired);

		// A second call rereads the unchanged cache; it neither refreshes nor
		// caches the expired credential away.
		const second = await readCodexCompanion(
			{ enabled: true, home: HOME },
			setup.deps,
		);
		expectReason(second, "companion_expired");
		expect(setup.observed.paths).toEqual([
			CONFIG_PATH,
			AUTH_PATH,
			CONFIG_PATH,
			AUTH_PATH,
		]);
		expect(setup.observed.limits).toEqual([
			MAX_BYTES,
			MAX_BYTES,
			MAX_BYTES,
			MAX_BYTES,
		]);
	});

	test("valid_file_login_yields_only_public_credential_fields", async () => {
		const expiresAt = (Math.floor(NOW / 1000) + 3600) * 1000;
		const { read: result, observed } = await read({
			[CONFIG_PATH]: 'cli_auth_credentials_store = "file"\n',
			[AUTH_PATH]: authText(),
		});
		if (result.state !== "available") {
			throw new Error(`expected available, got ${result.reason}`);
		}
		expect(result.credential.accessToken).toBe(ACCESS_TOKEN);
		expect(result.credential.accountID).toBe(ACCOUNT_ID);
		expect(result.credential.expiresAt).toBe(expiresAt);
		expect(result.credential.identityKey).toMatch(/^[0-9a-f]{64}$/);
		expect(result.credential.identityKey).not.toBe(ACCESS_TOKEN);
		expect(result.credential.identityKey).not.toBe(ACCOUNT_ID);
		expect(Object.keys(result.credential).sort()).toEqual([
			"accessToken",
			"accountID",
			"expiresAt",
			"identityKey",
		]);
		expectNoCredentialLeak(result);
		expect(JSON.stringify(result)).toContain(ACCESS_TOKEN);
		expect(observed.limits).toEqual([MAX_BYTES, MAX_BYTES]);
	});

	test("cache_replaced_between_reads_is_observed", async () => {
		const files: Record<string, string> = { [AUTH_PATH]: authText() };
		const setup = credentialDeps(files);
		const first = await readCodexCompanion(
			{ enabled: true, home: HOME },
			setup.deps,
		);
		if (first.state !== "available") {
			throw new Error(`expected available, got ${first.reason}`);
		}

		const renewedToken = jwt(claims({ exp: Math.floor(NOW / 1000) + 7200 }));
		files[AUTH_PATH] = authText({
			tokenOverrides: { access_token: renewedToken },
		});
		const second = await readCodexCompanion(
			{ enabled: true, home: HOME },
			setup.deps,
		);
		if (second.state !== "available") {
			throw new Error(`expected available, got ${second.reason}`);
		}

		expect(second.credential.accessToken).toBe(renewedToken);
		expect(second.credential.expiresAt).toBe(
			(Math.floor(NOW / 1000) + 7200) * 1000,
		);
		expect(second.credential.identityKey).not.toBe(
			first.credential.identityKey,
		);
		expect(setup.observed.calls).toBe(4);
	});
});

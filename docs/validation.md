# Release validation

This document records what was validated, what remains unverified, and the
repeatable procedure for checking a release. Evidence must stay sanitized:
record status codes, states, scopes, and timings — never tokens, account IDs,
client IDs, emails, credential-file contents, or personal quota values.

## Evidence dates

| Evidence | Date | Scope |
| --- | --- | --- |
| Source-plan live validations | **2026-10-24** | The original OpenCode, Ollama, OpenAI token-sharing, and Codex companion checks listed below. This date is not a claim about later runs. |
| Repository automated verification | 2026-10-24 | Unit/integration suites, typecheck, lint, build, frozen install, audit, package inspection, and a synthetic headless artifact smoke in this workspace. |
| Integrated live Checkpoint B | **Pending user consent** | The installed plugin against a real Codex cache and the real provider routes has not been re-run as an integrated Checkpoint B smoke. |
| Interactive terminal Checkpoint C | **Pending human review** | Placement, navigation, narrow/wide layout, and keybindings in a live OpenCode terminal. |

## Source-plan live validations (2026-10-24)

These are the original validations recorded by the source plan. No identifiers
or personal quota snapshots are reproduced here.

| Check | Recorded evidence |
| --- | --- |
| Ollama Cloud existing OpenCode connection | Integration `ollama-cloud` with a saved API key; `GET https://ollama.com/api/balance` returned `200` with included and purchased balances and a refill period. |
| Installed local Ollama | Version `0.34.1`; local `GET /api/balance` returned `404`. A newer upstream handler is not proof this installation supports it. |
| OpenCode's current OpenAI connection | OAuth method `chatgpt-token-sharing`, public API audience, direct token-sharing scope; `GET /v1/models` returned `200`. |
| Current OpenAI token on quota routes | Both `/backend-api/wham/usage` and `/backend-api/wham/usage/chatpass/apps` returned `401`, code `no_matching_rule`. |
| Existing Codex cache | File-backed ChatGPT login containing a valid access token and account context; read without modifying the file or refreshing tokens. |
| Codex companion app quota | `GET https://chatgpt.com/backend-api/wham/usage/chatpass/apps` returned `200` with an `{ items: [...] }` envelope. Exactly one `items[].id` matched the current OpenCode credential's `metadata.clientID` (which also matched its access-token `client_id`). |
| Codex companion shared-plan quota | After that unique match, `GET https://chatgpt.com/backend-api/wham/usage` returned `200` with primary and secondary plan windows. |
| Scope distinction | App-week and shared-plan-week values and reset timestamps differed. They are separate constraints, not interchangeable displays. |
| OpenCode Console | Device OAuth works; a reliable quota endpoint has not been validated. |

## Automated verification for this release

All commands use the pinned runtime via `npx bun@1.4.4`.

| Check | Result |
| --- | --- |
| `bun test` | `193 pass`, `0 fail`, `1575 expect()` calls, 10 files. |
| `bun run typecheck` | Exit 0 (`tsc --noEmit --jsx preserve`). |
| `bun run lint` | Exit 0; 23 files checked, no fixes applied. |
| `bun run build` | Exit 0; `dist/index.js`, `dist/tui.js`, `dist/rpc.js`; `build exports ok: ., ./tui, ./rpc`. |
| Frozen, script-disabled install | Scratch directory with only `package.json` + `bun.lock`: `bun install --frozen-lockfile --ignore-scripts` installed 359 packages and exited 0. |
| Package-manager audit | `bun audit --json` returned `{}`: no reachable advisories reported. No forced remediation, ignores, or suppressions were applied. |
| Package file list | `bun pm pack --dry-run` reports 21 files / 0.32 MB unpacked, including only `package.json`, `README.md`, `docs/*`, `dist/*`, and `src/*`; no tests, `.superpowers/`, `.env*`, auth caches, logs, previews, or home paths. |
| Security suite | `tests/integration/security.test.ts` — 4 tests pass: sentinel non-disclosure across success/malformed/credential-error/companion/late-cancelled paths, path/token RPC rejection, and the support-matrix contract. |
| Support-matrix contract | Two real adapters, seven declared capabilities; every capability has exactly one declarations row, and every frozen reason code is documented. |

### Headless artifact smoke (synthetic)

The built `dist/index.js`, `dist/tui.js`, and `dist/rpc.js` were loaded under Bun
`1.4.4` with a fake host, a temporary synthetic Codex home, and a stubbed
provider `fetch`. No real credential or provider was used.

| Path | Observed |
| --- | --- |
| Companion disabled | `state: "unavailable"`, reason `companion_disabled`, **0** provider requests. |
| Companion enabled with synthetic file-backed cache and synthetic app match | `state: "available"`, `authSource: "codex-companion"`, sections `app:available` and `shared-plan:available`, exactly **2** provider requests (app match first, then shared plan), no credential sentinels in the RPC result. |
| Artifact load | Server plugin exports and defines; TUI plugin id `provider-usage.tui`; RPC `provider-usage@1`. |

This smoke proves the packaged wiring, host bridge, file reader, two-step
retrieval protocol, RPC validation, and sanitization. It does **not** prove live
provider behavior.

## Unverified until live smoke

- **Integrated Checkpoint B.** The plugin has not been live-smoked end-to-end
  against a real Codex cache and the real `chatgpt.com` routes in this release
  (pending user consent). Do not advertise the companion opt-in as live-safe
  until that run is recorded.
- **Absent-config Codex file default.** The reader assumes Codex's documented
  default of file-backed storage when `config.toml` is absent or omits
  `cli_auth_credentials_store`. The offline unit test
  `absent_config_defaults_to_file_storage` pins the current software behavior;
  it is **not** evidence about the installed Codex version. Revalidate against
  that version before the live smoke; if the default has changed, the reader
  must be fixed before the opt-in is advertised as safe.
- **Missing, expired, and mismatched companion logins.** Covered by synthetic
  fixtures in `tests/providers/codex-credentials.test.ts`,
  `tests/providers/openai-companion.test.ts`, and
  `tests/integration/security.test.ts`. They must not be reproducer-tested by
  changing a real user's sign-ins.
- **Remote hosts and keychain/encrypted Codex stores.** Not supported and not
  claimed.
- **Interactive terminal layout.** Checkpoint C remains a human review item.

## Release checklist

- [ ] `npx bun@1.4.4 install --frozen-lockfile --ignore-scripts` in a clean
      scratch directory succeeds.
- [ ] `npx bun@1.4.4 test` exits 0.
- [ ] `npx bun@1.4.4 run typecheck` exits 0.
- [ ] `npx bun@1.4.4 run lint` exits 0.
- [ ] `npx bun@1.4.4 run build` exits 0 and `check:build` reports all exports.
- [ ] `npx bun@1.4.4 audit` shows no reachable advisories, or each advisory is
      triaged in writing with severity and reachability. Do not add suppressions
      or force upgrades to get green.
- [ ] `npx bun@1.4.4 pm pack --dry-run` lists only intended files.
- [ ] The security suite passes without weakening assertions.
- [ ] The support-matrix test passes for every registered adapter capability.
- [ ] The built artifact loads headlessly with the companion disabled and
      enabled using synthetic inputs.
- [ ] Both live quota routes return `200` and the companion app match is unique
      when a consented live run is performed. Record only status/scopes/states.
- [ ] The native OpenCode inference sign-in still works after enabling the
      companion; the companion path did not replace or refresh it.
- [ ] Missing/expired/mismatched companion scenarios were exercised with
      synthetic fixtures, not by mutating a real sign-in.
- [ ] The terminal UI was checked at narrow and wide widths, with selected-provider
      changes, page open/back, refresh, and no model request.
- [ ] Re-verify every number in this table against a fresh full run before
      publishing.

## Manual smoke procedure

### Companion disabled (default)

1. Install and load the plugin with the object/string form from `README.md`,
   without `codexCompanion`.
2. Confirm the sidebar follows the prompt's selected provider and the full page
   opens via `/usage` (or `/provider-usage` when `/usage` is occupied).
3. For a saved Ollama Cloud key, confirm the existing key is used with no extra
   setup and the reported included/purchased/total pools remain separate.
4. For OpenAI token-sharing, confirm the native-only explanation appears and no
   quota request is made for that provider.
5. Confirm no UI action triggers a model request.

### Companion enabled (consented)

1. Ensure Codex uses file-backed storage and has a current ChatGPT login. Do not
   copy or paste any token into OpenCode configuration.
2. Add `codexCompanion.enabled: true` (and optionally a trusted server-side
   `home`) to the plugin entry, then let OpenCode's normal configuration reload
   apply it. A restart is not required for the option change.
3. Refresh. Confirm the app and shared-plan sections appear separately, with
   their own durations and resets, and that the configured app cap is shown as a
   cap, not as remaining quota.
4. Confirm the OpenCode inference sign-in still works and the plugin's RPC
   output contains only provider/support descriptors and sanitized quota reads.
5. If the companion login is expired, confirm the exact recovery copy from
   `docs/support.md` appears and the plugin does not attempt renewal.

### Failure-path smoke without touching real sign-ins

Use the synthetic fixtures in the committed tests for missing, expired,
mismatched, malformed, rate-limited, timed-out, and cancelled paths. A manual
failure run may instead point `codexCompanion.home` at a disposable synthetic
directory; never edit the real Codex store, never paste a token into
configuration, and never commit captured provider responses.

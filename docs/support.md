# Support matrix and evidence

This document is the compatibility contract for `opencode-providers-usage`. It is
checked by `tests/integration/security.test.ts`: every adapter capability must
appear in the machine-checked declarations table, and a stale or missing row
fails CI.

## Baseline

| Item | Value |
| --- | --- |
| OpenCode baseline | `2.1.4` (V2 plugin, RPC, and terminal APIs) |
| Terminal | OpenCode V2 terminal only; no desktop/web extension, V1 support, or OpenCode fork |
| Development runtime | Bun `1.4.4` (pinned) |
| Validated platform | macOS, local shared server, file-backed Codex login |
| Remote server | Not promised for v1; see [No remote or keychain promise](#no-remote-or-keychain-promise) |
| Quota source | Provider responses only; no local-token estimates, guessed allowances, inferred refills, or API-spending substitution |

Live evidence in this document was gathered on **2026-10-24** and is recorded
in [`docs/validation.md`](docs/validation.md).

## Authentication and compatibility matrix

The rows below are the specification's matrix, with the ledger's legacy-window
clarification in the second row. "Supported" is never advertised for a provider
or auth method that is not named here.

| Provider / authentication | v1 behavior | Evidence level |
| --- | --- | --- |
| Ollama Cloud saved API key | Supported balance/refill retrieval using its existing connection; no extra key setup. | Live endpoint validated. |
| Ollama Cloud legacy session/weekly plan with API key | Parse reported legacy windows; clearly distinguish documentation/fixture coverage from live testing. Legacy windows render ONLY when the provider reports a duration; the documented legacy shape has no duration field, so a valid legacy response shows `partial` plus an unavailable section. No five-hour or seven-day window is assumed. | Official API schema; not live-validated. |
| Signed-in local Ollama cloud proxy | Unsupported in v1; installed endpoint absent. No automatic daemon upgrade or private-key extraction. | Local `404`; newer source only. |
| Purely local Ollama inference | Not applicable: no provider cloud allowance for that model. Never label this as unlimited. | Scope distinction. |
| OpenAI current ChatGPT token-sharing OAuth, companion explicitly opted out | Quota unavailable because the companion is disabled by configuration; explain the opt-out. | Live rejection and OpenAI maintainer statement. |
| Current token-sharing OAuth plus valid, file-backed, matching Codex companion login | Supported: current-app windows and shared-plan windows, separately labeled. Native inference login unchanged. | Live-validated combination. |
| Same combination, but missing/expired/mismatched companion login | Unavailable with the specific companion reason; no fallback to Codex totals, another app, or another saved account. | Required fail-closed behavior. |
| Keychain/encrypted Codex cache | Unsupported companion storage in v1. Never silently read a stale file that does not represent the configured active store. | Not live-validated. |
| OpenAI inference API key | Account/subscription quota reporting unsupported in v1. API spending/rate limits are not ChatGPT subscription allowance. | No implemented quota source. |
| Legacy Codex OAuth saved directly in OpenCode | Not independently implemented/validated in v1; do not confuse it with the supported external Codex companion source. | Separate future use case. |
| OpenCode Console device OAuth | Explicit quota unavailable: no validated quota API. | Connection verified, quota unverified. |
| Zen/Go inference API keys | Unsupported/unverified quota reporting; do not infer compatibility from Console OAuth. | No validated source. |
| Other providers / custom compatible endpoints | Unsupported until an explicit adapter and authentication/endpoint combination are validated. | No generic credential forwarding. |

### Evidence levels

- **live-validated** — the exact provider/auth combination was exercised against
  the real endpoint on 2026-10-24, with only sanitized status/scopes/values
  recorded (no identifiers, tokens, account IDs, or personal quota snapshots).
- **documented-only** — implemented from the provider's official schema or
  public documentation and covered by synthetic fixtures, but not observed
  against a live account.
- **unverified** — no validated quota source exists for this combination. It is
  declared unsupported so the UI can explain the gap instead of guessing.

### Live versus fixture-only evidence

| Behavior | Evidence |
| --- | --- |
| Ollama Cloud balance/refill (existing saved key) | Live `200` on 2026-10-24; synthetic decimal/refill fixtures in `tests/providers/ollama.test.ts`. |
| Ollama legacy session/weekly windows | Documentation/fixture-only. The documented shape has no duration, so the adapter reports a `partial` read with an unavailable section when no duration is present. |
| OpenAI token-sharing without companion consent | Live `401`/`no_matching_rule` on both quota routes on 2026-10-24; synthetic fixtures pin the `companion_disabled` path. |
| Codex companion app match then shared plan | Live `200` on both routes and exactly one matching app registration on 2026-10-24; synthetic fixtures pin match, mismatch, pagination, and window validation. |
| Missing/expired/mismatched companion login | Synthetic fixtures only. The committed tests never touch a real Codex sign-in. |
| OpenCode Console, Zen/Go, OpenAI inference keys, local Ollama proxy, keychain | No validated quota source; explicit unsupported/not-applicable declarations. |

## Machine-checked adapter declarations

This table is parsed by `support_matrix_covers_every_registered_capability`. The
`Match` column is the exact registry selector (`providerID:<id>` and/or
`integrationID:<id>`). `Reason codes` lists the frozen public reasons this
combination can produce; every code must be in `QUOTA_REASON_CODES`.

| Adapter | Capability | Match | Auth method | Support | Evidence | Reason codes |
| --- | --- | --- | --- | --- | --- | --- |
| `ollama-balance` | Ollama Cloud | `integrationID:ollama-cloud` | `key` | `supported` | `live-validated` | `no_validated_quota_source`, `unsupported_auth_method`, `rate_limited`, `timeout`, `network_error`, `invalid_response` |
| `ollama-balance` | Ollama Cloud legacy session/weekly plan | `integrationID:ollama-cloud` | `key` | `supported` | `documented-only` | `no_validated_quota_source`, `unsupported_auth_method`, `rate_limited`, `timeout`, `network_error`, `invalid_response` |
| `openai-companion` | OpenAI ChatGPT | `integrationID:openai` | `oauth` | `requires-companion` | `live-validated` | `companion_disabled`, `companion_missing`, `companion_expired`, `unsupported_companion_storage`, `invalid_companion`, `app_registration_mismatch`, `invalid_native_registration`, `unsupported_auth_method`, `rate_limited`, `timeout`, `network_error`, `invalid_response` |
| `openai-companion` | OpenAI ChatGPT token-sharing without companion consent | `integrationID:openai` | `oauth` | `unsupported` | `live-validated` | `companion_disabled` |
| `openai-companion` | OpenCode Console | `integrationID:opencode` | `oauth` | `unsupported` | `unverified` | `no_validated_quota_source` |
| `openai-companion` | OpenCode Zen and Go API keys | `integrationID:opencode` | `key` | `unsupported` | `unverified` | `no_validated_quota_source` |
| `openai-companion` | OpenAI inference API key | `integrationID:openai` | `key` | `unsupported` | `documented-only` | `no_validated_quota_source` |

## Codex companion (on by default)

Companion access is **on by default** and reads the existing server-side
login. A literal `enabled: false` opts out. Configuration is read from the
server plugin options:

```jsonc
{
  "codexCompanion": {
    "enabled": false,
    "home": "/path/to/codex-home"
  }
}
```

- `enabled` is on unless it is literally `false`; set `enabled: false` to opt
  out, which produces `companion_disabled` without touching disk.
- `home` is an optional **trusted server-side** directory. When omitted, the
  reader uses `CODEX_HOME`, then `~/.codex`. The TUI cannot supply this value
  through RPC.
- The reader supports **file-backed** Codex storage only. Explicit keychain,
  encrypted, ephemeral, or ambiguous storage is rejected with
  `unsupported_companion_storage`; it never searches another store for a
  leftover `auth.json`.
- The reader is read-only. It never uses the refresh token, starts a login,
  rotates tokens, modifies Codex's configuration, or writes its credential
  store.
- Credentials are reread on every resolve/read/currentness check so Codex's own
  renewal or an account change is observed without copying credentials into
  plugin storage.
- On OpenCode 2.1.4 the active OpenAI OAuth credential is stored in
  `opencode.db`. The plugin resolves it through the host APIs
  (`integration.connection.active` then `connection.resolve`). The
  file-backed `auth.json` entry remains the documented fallback for hosts where
  that file is the credential store.
- The absent-setting default (treating storage as file-backed when
  `config.toml` is absent or omits `cli_auth_credentials_store`) follows Codex's
  documented default for the versions this reader targets. It was
  live-validated against the installed Codex `0.150.1` on 2026-10-24
  (`config.toml` omitted the setting, the reader applied the file default, and
  the file-backed login was accepted by both live quota routes). That is a
  single-machine observation, so the evidence level here stays documented-only
  with that caveat; revalidate whenever the installed Codex version changes.

## Native sign-in preservation

Enabling the companion does **not** replace, refresh, or invalidate OpenCode's
current `openai` / `chatgpt-token-sharing` inference connection. The native
token-sharing bearer is never sent to `chatgpt.com`; both companion quota GETs
use only the companion access token and its existing `ChatGPT-Account-Id`.
OpenCode continues to use its own sign-in for inference.

## Expired and unavailable companion credentials

An expired or unusable companion credential is an explicit unavailable state.
The user renews that login through Codex, then refreshes. The plugin never
attempts renewal. The exact user-facing copy is pinned in
`src/ui/format.ts` and repeated below.

## Unavailable states and exact reason codes

The `state` field is authoritative; `reason` adds detail. In particular,
`no_validated_quota_source` has two meanings:

- with state `unsupported`: this provider/auth method was **never claimed** by
  any validated source;
- with state `unavailable`: the last result **expired or has not completed**, so
  no current validated quota exists.

`auth-required` with reason `unsupported_auth_method` means **the credentials
were rejected, invalid, or expired**. It does not mean the authentication
method itself is unsupported. Re-authenticate through `/connect`, then refresh.

| State / reason | Exact user-facing copy (from `src/ui/format.ts`) |
| --- | --- |
| state `unsupported` | Quota unavailable: no quota source is validated for this provider. |
| state `not-applicable` | Quota not applicable: this provider has no cloud quota to report. |
| state `unavailable`, reason `no_validated_quota_source` | Quota unavailable: no current validated quota. The last result expired or has not completed. Refresh to try again. |
| state `auth-required`, reason `companion_expired` | Quota unavailable: sign in with the ChatGPT/Codex app on this machine (using the same account), then refresh. |
| state `auth-required` or `unavailable`, reason `companion_disabled` | Quota unavailable: the Codex companion is turned off in this OpenCode configuration. Remove the codexCompanion opt-out to read the existing ChatGPT/Codex login. |
| state `auth-required`, reason `unsupported_auth_method` | Quota unavailable: credentials were rejected, invalid, or expired. Re-authenticate via `/connect`, then refresh. |
| `companion_missing` | Quota unavailable: sign in with the ChatGPT/Codex app on this machine (using the same account), then refresh. |
| `unsupported_companion_storage` | Quota unavailable: the ChatGPT/Codex login on this machine uses a storage mode this plugin does not support. Use the file-backed Codex login, then refresh. |
| `invalid_companion` | Quota unavailable: sign in with the ChatGPT/Codex app on this machine (using the same account), then refresh. |
| `app_registration_mismatch` | Quota unavailable: sign in with the ChatGPT/Codex app on this machine (using the same account), then refresh. |
| `invalid_native_registration` | Quota unavailable: the current OpenCode OpenAI sign-in could not be matched. Re-authenticate via `/connect`, then refresh. |
| `rate_limited` | Quota unavailable: the provider rate limit is active. Try again after the retry window. |
| `timeout` | Quota unavailable: the provider request timed out. Refresh to try again. |
| `network_error` | Quota unavailable: the provider could not be reached. Refresh to try again. |
| `invalid_response` | Quota unavailable: the provider returned an unusable response. Refresh to try again. |
| unrecognized reason | Quota unavailable: the provider could not be queried. Refresh to try again. |

The sidebar card and the usage-page card never render the `unsupported`
explanation as a second line. For that purely informational state both show
only the plain status line `Quota unavailable`; every other state keeps the copy
above because it carries actionable guidance.

Reason-specific copy is applied before the generic `auth-required` fallback.
In particular, a rejected OpenAI `401`/`403` that is not attributable to
companion expiry is reported as state `auth-required` with reason
`invalid_response`, so the `invalid_response` row above is displayed. The
frozen reason vocabulary has no separate "credentials rejected" code; the
`unsupported_auth_method` row is the explicit rejected-credentials case used by
the Ollama adapter.

## Freshness and request behavior

| Behavior | Value |
| --- | --- |
| Ordinary activity freshness threshold | `60_000` ms since last full success; initial sidebar activation loads once |
| Automatic successful-read polling | None; activity/completion driven |
| Minimum spacing between request starts for one provider/account | `15_000` ms |
| Request timeout | `10_000` ms |
| Maximum snapshot age treated as current | `90_000` ms, or earlier at a reset boundary or companion-token expiry |
| Transient-failure retries | Every `60_000` ms through the first three minutes, then capped backoff up to `300_000` ms; provider `Retry-After` wins when longer |
| Automatic retry | Only transient failures; unsupported, auth, matching, and companion errors do not loop |
| Idle server-side unwatch | After the last RPC read is older than `300_000` ms, checked every `60_000` ms; active recovery keeps its push watch |
| Sidebar stale indicator | `Data might be stale` only at age > `1_800_000` ms AND continuous failure >= `180_000` ms |
| RPC contract | Version **2** only; server/TUI must be reloaded together |
| Cross-process deduplication | **Not promised**; each OpenCode server process owns its own coordinator and may request the same quota |

A provider is watched when an RPC consumer first reads it. Successful reads
schedule no network timer. Without the server-side idle cleanup, a watcher
remains active until the plugin unloads because RPC has no unwatch method.
Keyboard input, terminal focus, route/session changes,
and model selection refresh old/missing data; completed/failed model steps refresh
their actual provider, using public event attribution or the assistant-message
cache (unattributed completions are skipped). Bursts share a throttle and trailing
completion request; input is observed without consuming it or reading key contents.

The server alone owns recovery retries, including with zero listeners and after
interaction stops. The idle sweep skips active recovery to keep pushes alive;
neither retries nor pushes renew the RPC idle clock. Once recovery ends, ordinary
five-minute watch cleanup applies. A later RPC read re-watches the provider.
Providers never read are never resolved; non-retryable authentication, unsupported,
matching, and companion failures do not automatically loop.
Stopping non-auth retries does not reset continuous failure timing; retained old
figures can still qualify for the stale indicator until success or invalidation.
Auth rejection in any scope clears history and stops recovery, including when
another scope succeeded in the same partial response.

Only the sidebar may use the sanitized last **fully successful** snapshot.
Failures and partial reads do not replace that coherent history or restart the
failure clock. Idle expiry alone never warns. The local stale-indicator deadline
is display-only, and full recovery clears it. Account/credential identity changes,
explicit invalidation, rejected successful-response currentness, and auth rejection
clear history immediately; historical data never becomes a current `available`
observation. History is runtime-only, not persisted across restart, and reset times
never imply replenishment. The usage page retains strict current-state
validation and never renders historical figures as current. V2 sources without
optional presentation metadata retain strict sidebar behavior too.
The detailed page owns a display-only currentness deadline, so its figures expire
even without another RPC or push. Coordinator-backed custom RPC sources must
provide the atomic `snapshot` hook: attaching a later revision to an earlier
read could otherwise resurrect another identity's quota during a switch.

## Security boundary

The adapter-owned transport allowlist is authoritative. A request may only use
these exact origin/path pairs; redirects are rejected, URLs with credentials,
query strings, or fragments are rejected, and response bodies are bounded to
1 MiB.

| Origin | Allowed paths |
| --- | --- |
| `https://ollama.com` | `/api/balance` |
| `https://chatgpt.com` | `/backend-api/wham/usage`, `/backend-api/wham/usage/chatpass/apps` |

- Only the server reads credentials. The TUI cannot supply a credential path or
  bearer token through plugin RPC; `get`/`refresh` accept exactly
  `{ providerID }` and `list` accepts no fields.
- Credential values, raw JWTs, account identifiers, emails, credential-file
  contents, and raw provider payloads never cross RPC or logs. RPC outputs are
  validated against the strict public `QuotaRead` allowlist, which rejects
  extra fields.
- No inference requests, browser-cookie access, website scraping, telemetry, or
  billing mutations are performed.
- Request failures are reduced to allowlisted reason codes; the original
  exception text, response body, and request are dropped.

## No remote or keychain promise

V1 makes no remote-server compatibility promise. A remote TUI must never upload
its own Codex cache or select arbitrary file paths. Companion consent is
server-specific, and credentials are read on the server.

Keychain, encrypted, ephemeral, and other non-file Codex stores are explicitly
unsupported in v1. The plugin never invokes Keychain, triggers an authorization
prompt, or silently reads a stale file for another storage backend.

## Out of scope

Model usage, cost, speed, historical charts, alerts, automatic provider
switching, and purchasing credits are out of scope. Their future data sources
must remain independent capabilities, never guessed quota inputs.

## Sidebar presentation

The sidebar appends one compact quota card to the `sidebar.footer` slot for the
prompt's currently selected provider.

- The card title is the host provider display name resolved by providerID from
  the host registry (for example `OpenAI` or `Ollama Cloud`) in the base color.
  If the registry has no entry and only the raw providerID is available, the
  card falls back to the declared summary name. Row labels, values, and detail
  text below the title are muted; the used bar fill is the one bright element.
- Window rows use duration-only labels (`5h`, `7d`) and the same compact bar:
  used (`━`, base color) versus remaining (`─`, muted), the used percentage,
  then an inline `· resets 8h` countdown. Rows sort by duration ascending
  (`5h` before `7d`); equal durations keep source order and de-dup suffixes.
  `shared-plan` sections are omitted from the sidebar card. Reported
  `remainingPercent` is inverted to used percent and keeps the percentage
  thresholds; `usedPercent`-only input stays neutral; no reported percentage
  keeps the muted `Unknown (not reported)` fallback without a bar.
- Included credits with a positive reported allowance render one compact bar
  row followed by one stat row. The bar row shows used (`━`, base color) versus
  remaining (`─`, muted), then the used percentage and an inline
  `· resets 25d 15h` countdown derived only from the reported reset timestamp
  (two units: days/hours, hours/minutes, then minutes or seconds; past resets
  read `resets now`). Only the percentage carries a threshold tone: 100% used
  keeps the error tone and at least 80% used keeps the warning tone; below that
  it stays muted. The stat row reads `$25.27 / $60.00 used` on the left and,
  when reported, `+$4.27 credits` on the right. The purchased pool is folded
  into that right cell and the derived total pool is intentionally omitted.
  Used is derived only as `allowance − remaining`. Without a positive allowance
  the actual money remaining is shown and no bar or used figure is invented;
  the existing purchased/total pair rendering stays in that fallback.
- Without coherent history every unavailable section keeps its exact recovery
  copy/retry delay and expired sections hide their figures. With server
  history, the sidebar retains those complete figures and optionally appends
  one muted `Data might be stale` line at both thresholds.
- The whole card is a click target for the existing `provider-usage` route.

## Usage page presentation

The `/usage` page renders one framed, padded card per connected provider, and
each card body is exactly the sidebar widget for that provider: same header
name, rows, tones, duration labels, and countdown resets. The page adds no
rows of its own; shared-plan windows, configured caps, and the derived total
pool stay hidden, exactly as the compact sidebar hides them.

Two quota cards share a row when the terminal is wide enough and stack when
narrow; a card that cannot share a row spans the full width. Page content is
bounded on very wide terminals, and short terminals scroll the whole page
instead of clipping cards. Cards contain no badges, support/evidence,
auth-method, auth-source, per-metric-detail, update-age, or footnote rows. An
unsupported card is only the provider name plus `Quota unavailable`. A missing
read shows `Not loaded yet. Refresh to load.` Expired sections are revalidated
before rendering, so they become per-scope unavailable explanations rather
than yesterday's figures. Footer hints are `esc` back and `ctrl+r` refresh.

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

Evidence dates in this document refer to the live validations on
**2026-10-24**: the source plan's checks plus the integrated, consented,
read-only Checkpoint B smoke recorded in `docs/validation.md`. Nothing in this
document claims a live validation performed after that date.

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
| OpenAI current ChatGPT token-sharing OAuth, no companion opt-in | Quota unavailable; explain that the current sign-in alone cannot read quota. | Live rejection and OpenAI maintainer statement. |
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
| `openai-companion` | OpenAI ChatGPT with Codex companion | `integrationID:openai` | `oauth` | `requires-companion` | `live-validated` | `companion_disabled`, `companion_missing`, `companion_expired`, `unsupported_companion_storage`, `invalid_companion`, `app_registration_mismatch`, `invalid_native_registration`, `unsupported_auth_method`, `rate_limited`, `timeout`, `network_error`, `invalid_response` |
| `openai-companion` | OpenAI ChatGPT token-sharing without companion consent | `integrationID:openai` | `oauth` | `unsupported` | `live-validated` | `companion_disabled` |
| `openai-companion` | OpenCode Console | `integrationID:opencode` | `oauth` | `unsupported` | `unverified` | `no_validated_quota_source` |
| `openai-companion` | OpenCode Zen and Go API keys | `integrationID:opencode` | `key` | `unsupported` | `unverified` | `no_validated_quota_source` |
| `openai-companion` | OpenAI inference API key | `integrationID:openai` | `key` | `unsupported` | `documented-only` | `no_validated_quota_source` |

## Codex companion opt-in

Companion access is **disabled by default** and requires an explicit
server-side opt-in. Configuration is read from the server plugin options:

```jsonc
{
  "codexCompanion": {
    "enabled": true,
    "home": "/path/to/codex-home"
  }
}
```

- `enabled` is true only when it is literally `true`.
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
| state `auth-required`, reason `companion_expired` | Quota unavailable: Codex companion login expired. Renew that login in Codex, then refresh. |
| state `auth-required` or `unavailable`, reason `companion_disabled` | Quota unavailable: the current OpenCode OpenAI sign-in alone cannot read quota. Enable the Codex companion option on the server to use that existing login. |
| state `auth-required`, reason `unsupported_auth_method` | Quota unavailable: credentials were rejected, invalid, or expired. Re-authenticate via `/connect`, then refresh. |
| `companion_missing` | Quota unavailable: no Codex companion login was found. Sign in with Codex on the server, then refresh. |
| `unsupported_companion_storage` | Quota unavailable: the Codex companion login uses a storage mode v1 does not support. Use the file-backed Codex login on the server. |
| `invalid_companion` | Quota unavailable: the Codex companion login could not be read. Renew that login in Codex, then refresh. |
| `app_registration_mismatch` | Quota unavailable: no unique Codex app matched the current OpenCode OpenAI sign-in. Sign in with the matching account in Codex, then refresh. |
| `invalid_native_registration` | Quota unavailable: the current OpenCode OpenAI sign-in could not be matched. Re-authenticate via `/connect`, then refresh. |
| `rate_limited` | Quota unavailable: the provider rate limit is active. Try again after the retry window. |
| `timeout` | Quota unavailable: the provider request timed out. Refresh to try again. |
| `network_error` | Quota unavailable: the provider could not be reached. Refresh to try again. |
| `invalid_response` | Quota unavailable: the provider returned an unusable response. Refresh to try again. |
| unrecognized reason | Quota unavailable: the provider could not be queried. Refresh to try again. |

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
| Poll cadence for visible supported connections | `60_000` ms |
| Minimum spacing between request starts for one provider/account | `15_000` ms |
| Request timeout | `10_000` ms |
| Maximum snapshot age treated as current | `90_000` ms, or earlier at a reset boundary or companion-token expiry |
| Transient-failure backoff | `60_000`, `120_000`, `240_000`, `300_000` ms, capped at the last; provider `Retry-After` wins when longer |
| Automatic retry | Only transient failures; unsupported, auth, matching, and companion errors do not loop |
| Idle server-side unwatch | After the last RPC read is older than `300_000` ms, checked by a sweep every `60_000` ms |
| Cross-process deduplication | **Not promised**; each OpenCode server process owns its own coordinator and may request the same quota |

A provider enters the poll lifecycle when an RPC consumer first reads it. The
frozen RPC surface has no unwatch method, so without a server-side policy a
watcher remains active until the plugin unloads. Instead, a server-side sweep
releases the watch once the last RPC read is older than `300_000` ms.
After the unwatch, polling stops and the last snapshot is no longer pushed; it
ages out through the normal freshness checks instead of being presented as
fresh. A later RPC read re-watches the provider. Providers never read by a
consumer are never resolved or polled, and unsupported or authentication
failures never get a timer. This is an operational fact, not a per-widget timer:
multiple widgets share the same server-owned request.

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

The earlier conservative workaround rendered the sidebar contribution as one
static text node with a plain string child. That avoided the host re-entrancy
crash seen with nested reactive component trees on OpenCode 2.1.4, but it could
not express the approved hierarchy: no accent rule, aligned cells, semantic
tones, paired credits, or clickable navigation. That workaround is retained
only as the `buildSidebarText` compatibility helper. Successful live quota now
appends a static nested OpenTUI Box/Text tree to the `sidebar.footer` slot,
built from the plain `SidebarModel` in `src/ui/sidebar-model.ts`.

The live path keeps the host safeguards that mattered:

- The selected provider, pushed snapshot, fetch result, and expiry check are
  resolved before the slot render. Required theme tokens are separately
  snapshotted into plugin-owned plain state by an effect outside the render, so
  both a replaced theme object and a reactive token update repaint the existing
  contribution. The slot render reads only that plain model/theme state and
  returns fresh renderable nodes. It passes no function-valued children and
  never reuses a disposed renderable.
- The model is a compact projection of reported quota data, not a second quota
  source. The card title is only the provider name (`OpenAI · Codex quota` for
  the validated Codex companion capability; arbitrary names unchanged) in the
  base color. Row labels, values, and detail text below the title are muted;
  the used bar fill is the one bright element.
- Window rows use duration-only labels (`5h`, `7d`) and the same compact bar:
  used (`━`, base color) versus remaining (`─`, muted), the used percentage,
  then an inline `· resets 8h` countdown. Rows sort by duration ascending
  (`5h` before `7d`); equal durations keep source order and de-dup suffixes.
  `shared-plan` sections are omitted from the sidebar card and remain available
  on the full usage page. Reported `remainingPercent` is inverted to used
  percent and keeps the percentage thresholds; `usedPercent`-only input stays
  neutral; no reported percentage keeps the muted `Unknown (not reported)`
  fallback without a bar.
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
- Every unavailable section keeps its exact reason/recovery copy and retry
  delay, painted in the muted row color. Expired sections hide their figures;
  partial reads keep valid rows. The compact sidebar no longer repeats an
  `updated`/`last attempt` timestamp; freshness stays on the full usage page.
- The whole card is a click target that opens the existing `provider-usage`
  page route. It triggers no new RPC read or refresh.
- Painted-line tests cover 24, 32, 40, and 60 columns. Rows honor the real
  parent width: compact bar rows align their label, bar, percent, and reset
  edges at normal widths, long labels and countdowns wrap instead of clipping,
  and the quota bar grows to the frame width while clipping its used/remaining
  glyph runs proportionally. Narrow panes wrap the reset countdown, labels, and
  title content instead of hiding a constraint. Semantic colors, including live
  theme repaints, are asserted from captured spans.

**Validation limitation:** these checks use OpenTUI's test renderer plus an
isolated `--conditions=browser` client-runtime probe with a fake host. They
prove repeated selection/snapshot updates, expiry, failure, mounted theme
replacement/token updates, disposal, and actionable navigation in that
harness. They are not an interactive OpenCode 2.1.4 session capture. Real-host
behavior after live sidebar reconciliation, a real host theme switch, and page
navigation must still be validated manually before claiming a live host
guarantee.

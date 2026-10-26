# opencode-providers-usage

Provider quota for the OpenCode **terminal**: a compact sidebar contribution and
a full-page provider dashboard for the quota each provider actually reports.
There are no local-token estimates, guessed allowances, inferred refills, or
API-spending substitutions.

Baseline: OpenCode `2.1.4` (V2 plugin, RPC, and terminal APIs), Bun `1.4.4`,
macOS local shared server. V1, desktop/web extensions, and OpenCode forks are not
supported.

## What it shows

- **Ollama Cloud** — included credits, purchased credits, and their separate
  total, read through the existing `ollama-cloud` API-key connection with
  `GET https://ollama.com/api/balance`. No extra key setup.
- **OpenAI ChatGPT token-sharing + Codex companion (on by default)** — current-app
  windows and shared-plan windows, kept separate with their own durations and
  reset times. Uses the existing file-backed Codex login read-only. OpenCode's
  native inference sign-in is preserved.
- **Everything else** — an explicit unsupported, not-applicable, or
  auth-required explanation. There is no generic credential forwarding and no
  advertised support for an unvalidated source.

The exact authentication/storage matrix, evidence levels, and reason-code copy
live in [`docs/support.md`](docs/support.md).

## Installation

The package is not published to a registry. Install from source:

```bash
git clone <this repository> opencode-providers-usage
cd opencode-providers-usage
npx bun@1.4.4 install --frozen-lockfile --ignore-scripts
npx bun@1.4.4 run build
```

The package exports four entrypoints:

| Export | Target | Purpose |
| --- | --- | --- |
| `.` | `./index.ts` | Server plugin: adapters, coordinator, RPC (`provider-usage`) |
| `./server` | `./index.ts` | Explicit alias for the server plugin |
| `./tui` | `./tui.tsx` | Terminal plugin: sidebar slot, `/usage` page, palette commands |
| `./rpc` | `./rpc.ts` | Versioned, validated RPC contract types |

Local plugin targets do not use this map: OpenCode resolves local plugins by
root-file convention (`index.ts`, `tui.tsx`, `rpc.ts`), and this repository
ships those root files re-exporting `src/*`. OpenCode loads the `./tui` export
beside the main plugin automatically; do not add a second plugin entry for it.

## Loading the plugin

OpenCode V2 resolves local plugins by root-file convention: the loader looks
for `<package>/index.ts`, `<package>/tui.tsx`, and `<package>/rpc.ts`. Use one
of the two forms below for a given plugin. Combining a directory symlink with
a config entry causes `Duplicate plugin ID: provider-usage`.

**Form A — symlink into the config plugins directory** (independent of config
arrays):

```bash
ln -sfn /absolute/path/to/opencode-providers-usage \
  ~/.config/opencode/plugins/opencode-providers-usage
```

**Form B — config `plugins` array with an object entry**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///absolute/path/to/opencode-providers-usage" }
  ]
}
```

The bare-string form (`"plugins": ["file:///absolute/path"]`) is accepted by
the config schema but silently ignored for local paths on `2.1.4`; prefer the
forms above.

### Codex companion (on by default, explicit opt-out)

OpenAI quota uses an existing **file-backed** Codex login on the server. The
companion is enabled without configuration; only a literal `enabled: false`
turns it off. Use the object form of the config entry so that opt-out and the
optional `home` can flow (Form B):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/opencode-providers-usage",
      "options": { "codexCompanion": { "enabled": false } }
    }
  ]
}
```

- The companion is on unless `enabled` is literally `false`.
- `home` is optional. It is a trusted server-side path; when omitted the reader
  uses `CODEX_HOME`, then `~/.codex`. The TUI cannot supply this path.
- Only file-backed Codex storage is supported. Keychain, encrypted, ephemeral,
  and ambiguous storage are rejected with `unsupported_companion_storage`.
- The reader never refreshes, rotates, or writes credentials. On expiry, renew
  the login in Codex and refresh.
- Never paste a token or credential path into plugin configuration. The plugin
  does not ask for or accept credential values there.
- On OpenCode 2.1.4 the active OpenAI OAuth credential lives in `opencode.db`;
  the plugin reads it through the host's connection APIs. `auth.json` remains
  the documented fallback for hosts where that file is the store.

### Reload after configuration changes

Editing `opencode.json(c)` goes through OpenCode's normal configuration reload;
a full OpenCode restart is not required for a plugin option change. Refresh the
quota view after enabling the companion. Source-code changes during local
development may still require a plugin/application reload because the module
has already been imported.

## Terminal UI

- The sidebar follows the **prompt's currently selected provider**, not the
  server's default model. With no selection it says “No provider selected”.
  The structured sidebar card shows the provider name, compact used-quota bars
  with reset countdowns, and dimmed detail rows. Clicking anywhere in the card
  opens the full page.
- `Show provider usage` (`provider-quota.usage`) opens the full page. The slash
  command is `/usage`; if that name is occupied at setup the plugin registers
  `/provider-usage` instead. The page renders one framed card per connected
  provider, and each card body is exactly the sidebar widget for that
  provider: same compact rows, duration labels, countdown resets, and tones,
  with no extra rows added by the page. Cards share a row when the terminal is
  wide enough and stack when narrow. Unsupported providers show only their
  name and `Quota unavailable`.
- `Refresh provider usage` (`provider-quota.refresh`) refreshes the selected
  provider and shows a short status toast.
- On the full page, `ctrl+r` refreshes every listed provider and `escape` goes
  back. A failed provider inventory shows a retry hint instead of fabricated
  figures.

No UI action triggers a model request or an inference call.

## Freshness and request behavior

- The sidebar loads once on activation. Keyboard input, terminal focus, route/session
  changes, and model-selection changes refresh when the last full success is at
  least `60_000` ms old (or missing). Model-step completion refreshes the provider
  that actually served that step, regardless of age. Bursts coalesce, with a
  trailing refresh for completions inside the request floor.
- Successful reads do **not** schedule polling. While idle, the sidebar keeps the
  last fully successful figures, even beyond normal expiry or a reported reset.
  It never estimates a refill. History is server-runtime memory only.
- Failed/partial refreshes retain that coherent history. `Data might be stale`
  appears only when the oldest figure is **over 30 minutes old** and refreshes
  have failed continuously for **at least 3 minutes**. Time passing alone can
  reveal the indicator but never triggers a network request. Recovery replaces
  the figures and clears failure timing and the indicator.
- Requests for the same provider/account are spaced at least `15_000` ms apart.
- Each request times out after `10_000` ms.
- The detailed page remains strict: snapshots are current for at most `90_000`
  ms, or less at a reset boundary or companion-token expiry. It shows real
  current-state diagnostics/timestamps, never historical figures as current.
- The server alone retries transient failures, even after activity stops or all
  presentation listeners leave: every `60_000` ms through the first three
  minutes, then capped backoff (up to `300_000` ms). A longer provider
  `Retry-After` wins. Non-retryable authentication/unsupported/matching errors
  stop automatic retries; stopping retries alone is not recovery and does not
  clear continuous failure timing. Identity changes, invalidation, and auth rejection
  immediately clear retained history.
- A provider starts its server-side watch on the first RPC read. A server-side
  idle sweep runs every `60_000` ms and releases the watch once the last RPC
  read is older than `300_000` ms, except during active recovery so recovery
  pushes keep arriving. Retries/pushes do not renew that idle clock. Releasing
  a watch does not erase history; a later read re-watches the provider.
  Providers never read are never resolved or polled.
- Quota RPC is now **version 2**. Reload server and TUI together; only matching
  versions are supported. Optional presentation metadata may be absent from
  v2 custom/test sources, in which case the sidebar uses the strict display.
  Coordinator-backed custom sources must implement the atomic `snapshot`
  source hook so quota and presentation always describe the same identity/revision.
- Request deduplication is in-process only. Separate OpenCode server processes
  are **not** deduplicated.

## Security and privacy

- Only the server reads credentials. The TUI can send `{ providerID }` and
  nothing else; it cannot select a credential file or supply a token.
- Credential values, raw JWTs, account identifiers, emails, credential-file
  contents, and raw provider payloads never cross plugin RPC or logs.
- Requests are limited to the exact allowlisted origin/path pairs:
  `https://ollama.com/api/balance`,
  `https://chatgpt.com/backend-api/wham/usage`, and
  `https://chatgpt.com/backend-api/wham/usage/chatpass/apps`. Redirects are
  rejected and response bodies are bounded.
- No inference requests, browser-cookie access, website scraping, telemetry, or
  billing mutations.
- V1 makes no remote-server compatibility promise; a remote TUI must never
  upload its own Codex cache or select arbitrary paths. Keychain/encrypted
  stores are not supported.
- The absent-config Codex file-storage default is not yet live-validated; see
  [`docs/validation.md`](docs/validation.md).

## Development

All commands use the pinned Bun release:

```bash
npx bun@1.4.4 install --frozen-lockfile --ignore-scripts
npx bun@1.4.4 test
npx bun@1.4.4 run typecheck
npx bun@1.4.4 run lint
npx bun@1.4.4 run build
```

Tests are hermetic: synthetic credentials, fixture files, and injected clocks
and transports. The default suite never reads a real home directory, real Codex
cache, or provider network.

To add a provider, follow [`docs/adding-a-provider.md`](docs/adding-a-provider.md).
Release evidence and the manual smoke checklist are in
[`docs/validation.md`](docs/validation.md).

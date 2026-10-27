# opencode-providers-usage

Provider quota for the OpenCode **terminal**: a compact sidebar contribution and
a full-page provider dashboard for the quota each provider actually reports.
There are no local-token estimates, guessed allowances, inferred refills, or
API-spending substitutions.

Baseline: OpenCode `2.1.4` (V2 plugin, RPC, and terminal APIs), Bun `1.4.4`,
macOS local shared server. The page-only Claude Code collector is verified only
on macOS arm64 with Claude Code CLI `2.1.308`; the live print-mode `/usage`
command was independently verified, but the full-page UI/RPC path was not
live-verified. V1, desktop/web extensions, and OpenCode forks are not supported.

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
- **Claude Code (full page only)** — current session and current week
  percentages and reset times from the locally authenticated Claude Code CLI's
  `/usage` command. It is a dedicated page-only source, not a provider: there is
  no sidebar card, inventory entry, or row in the provider support matrix or
  machine-checked adapter declarations. See
  [Claude Code usage](#claude-code-usage-full-page-only).

The exact authentication/storage matrix, evidence levels, and reason-code copy
live in [`docs/support.md`](docs/support.md).

## Installation

### Install from npm

```bash
npm install opencode-providers-usage
```

The published package exports four entrypoints. Named installs resolve them
through the `exports` map:

| Export | Target | Purpose |
| --- | --- | --- |
| `.` | `./dist/index.js` | Server plugin: adapters, coordinator, RPC (`provider-usage`) |
| `./server` | `./dist/index.js` | Explicit alias for the server plugin |
| `./tui` | `./dist/tui.js` | Terminal plugin: sidebar slot, `/usage` page, palette commands |
| `./rpc` | `./dist/rpc.js` | Versioned, validated RPC contract types |

OpenCode loads the `./tui` export beside the main plugin automatically; do not
add a second plugin entry for it. The package ships the built `dist/` files and
the root `index.js`, `tui.js`, and `rpc.js` shims. It declares no install
lifecycle scripts. Config entries that name the package directly are
not yet validated on OpenCode `2.1.4` in this repository; the local-path forms in
[Loading the plugin](#loading-the-plugin) are the verified ones.

### Install from a source checkout (development)

Use a checkout to develop or to test an unreleased revision. Build first: the
`exports` targets and the root JS shims load `dist/`, which is generated and not
committed.

```bash
git clone <this repository> opencode-providers-usage
cd opencode-providers-usage
npx bun@1.4.4 install --frozen-lockfile --ignore-scripts
npx bun@1.4.4 run build
```

## Loading the plugin

OpenCode V2 resolves local plugin directories by root-file convention. In a
source checkout the loader finds the TypeScript root files `index.ts`,
`tui.tsx`, and `rpc.ts`, which re-export `src/*`. In the npm package it finds the
root JS shims `index.js`, `tui.js`, and `rpc.js`, which re-export `dist/*`.
Named installs use the `exports` map instead. Use one of the two forms below
for a given plugin. Combining a directory symlink with
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
  provider and, when collection succeeds, a page-only Claude Code card. Each
  provider card body is exactly the sidebar widget for that provider: same
  compact rows, duration labels, countdown resets, and tones, with no extra rows
  added by the page. The Claude Code card uses the same rows and tones with its
  own identity. Cards share a row when the terminal is wide enough and stack
  when narrow. Unsupported providers show only their name and `Quota unavailable`.
- `Refresh provider usage` (`provider-quota.refresh`) refreshes the selected
  provider and shows a short status toast.
- On the full page, `ctrl+r` refreshes every listed provider and starts a new
  Claude Code collection, even while its card is hidden; `escape` goes back. A
  failed provider inventory shows a retry hint instead of fabricated figures.

No UI action triggers a model request or an inference call.

## Claude Code usage (full page only)

- The card is backed by a dedicated page-only CLI source outside the provider
  inventory. It runs the explicit `/usage` local command of the **already
  authenticated local Claude Code CLI** and uses that CLI's existing account.
  It does not ask for or accept a Claude credential, token, account path, or
  endpoint. The `claude` executable must be installed and signed in on the
  machine running the OpenCode server.
- Every opening of the full page starts a fresh collection, and `ctrl+r` starts
  another. The result is never cached across page opens. Collection is
  independent of the connected-provider inventory and never changes the
  sidebar.
- The card is hidden while collection runs and after any failure: missing CLI,
  not signed in, timeout, oversized or malformed output, unsupported platform,
  or a server without the page-only RPC. Other providers keep rendering and no
  error is shown.
- Only the current session and current week percentages and reset times are
  shown. Model-specific windows are ignored, never displayed, and never treated
  as the overall week.
- The CLI runs through its normal command path rather than `--bare`. Collection
  launches it from the **OS home directory**, not the OpenCode project
  directory, so project-level Claude settings and hooks are not discovered.
  User/home-level Claude Code settings and hooks may still run, and `--bare`
  was not used because it also stops using the CLI's logged-in account. No model
  prompt is sent.
- Collector verification is limited to **macOS arm64 with Claude Code CLI
  `2.1.308`**. The live print-mode `/usage` command was independently verified;
  the full-page UI and RPC integration were not live-verified. Other CLI
  versions and other POSIX platforms remain unverified. Platforms without POSIX
  process groups are unsupported and hide the card. So does an unavailable
  absolute home directory.

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
- Claude Code collection returns only two percentages and two reset instants.
  Raw CLI and terminal output, control sequences, model-specific windows,
  account identifiers, and errors never cross plugin RPC or logs.
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

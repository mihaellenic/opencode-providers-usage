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
- **OpenAI ChatGPT token-sharing + Codex companion (opt-in)** — current-app
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

The package exposes three entrypoints:

| Export | Source | Purpose |
| --- | --- | --- |
| `.` | `src/index.ts` | Server plugin: adapters, coordinator, RPC (`provider-usage`) |
| `./tui` | `src/tui.tsx` | Terminal plugin: sidebar slot, `/usage` page, palette commands |
| `./rpc` | `src/rpc.ts` | Versioned, validated RPC contract types |

OpenCode loads the `./tui` export beside the main plugin automatically. Do not
add a second plugin entry for it.

## Loading the plugin

Add the package to `plugins` in `opencode.jsonc`. Use the object form when you
want to pass options, or the string form for defaults:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-providers-usage"
  ]
}
```

If you installed it as a project dependency, the package name works instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-providers-usage"]
}
```

### Enable the Codex companion (optional, disabled by default)

OpenAI quota requires an explicit **server-side** opt-in and an existing
file-backed Codex login:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-providers-usage",
      "options": {
        "codexCompanion": {
          "enabled": true,
          "home": "/absolute/path/to/.codex"
        }
      }
    }
  ]
}
```

- `enabled` defaults to `false` and is accepted only when it is literally
  `true`.
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
- `Show provider usage` (`provider-quota.usage`) opens the full page. The slash
  command is `/usage`; if another command already owns that name, the plugin
  registers `/provider-usage` instead and leaves the other command intact.
- `Refresh provider usage` (`provider-quota.refresh`) refreshes the selected
  provider and shows a short status toast.
- On the full page, `ctrl+r` refreshes every listed provider and `escape` goes
  back. A failed provider inventory shows a retry hint instead of fabricated
  figures.

No UI action triggers a model request or an inference call.

## Freshness and request behavior

- Visible supported connections poll every `60_000` ms.
- Requests for the same provider/account are spaced at least `15_000` ms apart.
- Each request times out after `10_000` ms.
- A snapshot is current for at most `90_000` ms, or less at a reset boundary or
  companion-token expiry.
- Repeated transient failures back off at `60_000`, `120_000`, `240_000`, then
  `300_000` ms; a longer provider `Retry-After` wins.
- A provider starts its server-side watch on the first RPC read and remains
  watched until the plugin unloads, even if no UI is mounted. The frozen RPC
  surface has no unwatch method. Providers ever read are not polled in the
  background before that first read, and unsupported/authentication failures do
  not get a timer.
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
- The absent-config Codex file-storage default is currently **unverified until
  live-smoked**; see [`docs/validation.md`](docs/validation.md).

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

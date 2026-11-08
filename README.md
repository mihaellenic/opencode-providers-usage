# opencode-providers-usage

[![npm version](https://img.shields.io/npm/v/opencode-providers-usage.svg)](https://www.npmjs.com/package/opencode-providers-usage)
[![license](https://img.shields.io/npm/l/opencode-providers-usage.svg)](https://github.com/mihaellenic/opencode-providers-usage/blob/main/LICENSE)
[![made for OpenCode](https://img.shields.io/badge/made%20for-OpenCode%20V2-1024D3)](https://opencode.ai/docs/plugins/)

**How much quota do you have left on each provider?**

Provider quota for the OpenCode **terminal**: a compact sidebar card and a full-page dashboard showing only the quota each provider actually reports. No local-token estimates, guessed allowances, inferred refills, or API-spending substitutions.

## What it shows

- **Ollama Cloud**: included, purchased, and total credits, read through your existing `ollama-cloud` API-key connection. No extra setup.
- **OpenAI ChatGPT + Codex companion** (on by default): the shared ChatGPT plan windows with their reset times and a "Limit reached" status, using your existing file-backed Codex login read-only.
- **Claude Code** (full page, and sidebar for `claude-agent`): current session and week percentages with reset times, from the locally signed-in Claude Code CLI's `/usage` command. See [Claude Code usage](docs/behavior.md#claude-code-usage).
- **Everything else**: an explicit unsupported, not-applicable, or auth-required note. Nothing is guessed.

The authentication/storage matrix, evidence levels, and reason codes are in [`docs/support.md`](docs/support.md).

## Installation

### Install from npm

```bash
npm install opencode-providers-usage
```

The package exports five entrypoints. Named installs resolve them through the `exports` map:

| Export | Target | Purpose |
| --- | --- | --- |
| `.` | `./dist/index.js` | Server plugin: adapters, coordinator, RPC (`provider-usage`) |
| `./server` | `./dist/index.js` | Explicit alias for the server plugin |
| `./tui` | `./dist/tui.js` | Terminal plugin: sidebar slot, `/usage` page, palette commands |
| `./rpc` | `./dist/rpc.js` | Versioned, validated RPC contract types |
| `./gui-experimental` | `./dist/gui-experimental.cjs` | Experimental Desktop GUI plugin (CommonJS); see the Desktop GUI note below |

OpenCode loads the `./tui` export beside the main plugin automatically; do not add a second plugin entry for it. The package declares no install lifecycle scripts. Config entries that name the package directly are not yet validated on OpenCode `2.1.4` in this repository; the local-path forms in [Loading the plugin](#loading-the-plugin) are the verified ones.

### Install from a source checkout (development)

Build first: the `exports` targets and root JS shims load `dist/`, which is generated and not committed.

```bash
git clone https://github.com/mihaellenic/opencode-providers-usage
cd opencode-providers-usage
npx bun@1.4.4 install --frozen-lockfile --ignore-scripts
npx bun@1.4.4 run build
```

## Loading the plugin

OpenCode V2 resolves local plugin directories by root-file convention. In a source checkout the loader finds `index.ts`, `tui.tsx`, and `rpc.ts`, which re-export `src/*`. In the npm package it finds the root JS shims `index.js`, `tui.js`, and `rpc.js`, which re-export `dist/*`. Named installs use the `exports` map instead.

Use **one** of the forms below. Combining a directory symlink with a config entry causes `Duplicate plugin ID: provider-usage`.

**Form A: symlink into the config plugins directory**

```bash
ln -sfn /absolute/path/to/opencode-providers-usage \
  ~/.config/opencode/plugins/opencode-providers-usage
```

**Form B: config `plugins` array with an object entry**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///absolute/path/to/opencode-providers-usage" }
  ]
}
```

The bare-string form (`"plugins": ["file:///absolute/path"]`) is accepted by the config schema but silently ignored for local paths on `2.1.4`; prefer the forms above.

To turn the Codex companion off, add `"options": { "codexCompanion": { "enabled": false } }` to the Form B entry. Details: [Codex companion](docs/behavior.md#codex-companion-on-by-default-explicit-opt-out).

## Use

- The **sidebar** follows the prompt's selected provider. Click the card to open the full page.
- `/usage` (or `Show provider usage` in the command palette) opens the full page, with one card per connected provider. If `/usage` is taken, the plugin registers `/provider-usage` instead.
- `ctrl+r` on the full page refreshes everything; `escape` goes back.
- `Refresh provider usage` in the palette refreshes the selected provider.

No UI action triggers a model request or an inference call. Refresh timing, retries, and staleness rules are in [Behavior reference](docs/behavior.md#freshness-and-request-behavior).

## Security and privacy

- Only the server reads credentials. The TUI sends `{ providerID }` and nothing else.
- Credentials, raw tokens, account identifiers, and raw provider payloads never cross plugin RPC or logs.
- Requests go only to three allowlisted endpoints, with redirects rejected and bounded responses. No inference, browser-cookie access, scraping, telemetry, or billing mutations.

Full list: [Security and privacy](docs/behavior.md#security-and-privacy).

## Compatibility and validation

Historical validation: OpenCode `2.1.4` (V2 plugin, RPC, and terminal APIs) with Bun `1.4.4` on a macOS local shared server. That is not the current tested version: the current package SDK is `@opencode/plugin` `2.2.5`. The SDK build version is not host test evidence, and no real host smoke has been run for the `2.2.5` stack (`@opentui/core` and `@opentui/solid` `0.8.0`, `solid-js` `1.9.18`). The earlier clean TUI smoke on CLI `2.2.0` under the then-candidate `2.2.0` SDK and the synthetic smoke on the Desktop `2.2.1` server are historical; validation on `2.2.0`, `2.2.1` and `2.2.2` is historical and is not transferred to this build. OpenCode `2.1.4` hosts were not tested with this build.

The Claude Code collector (used by the full-page card and the `claude-agent`
sidebar card) is verified only on macOS arm64 with Claude Code CLI `2.1.308`;
the live print-mode `/usage` command was independently verified, but the
full-page UI/RPC path and the sidebar card were not live-verified in an OpenCode
session.

Recorded GUI bundle hashes are historical artifacts; a rebuilt candidate needs
fresh host checks.

Desktop GUI (experimental): the `./gui-experimental` export is an experimental OpenCode Desktop plugin. It is built with SDK `@opencode/plugin` `2.2.5` (Bun `1.4.4`); the historical smoke ran on a build with SDK `2.2.0` (Vite `7.3.7`) and was run only on OpenCode Desktop `2.2.1` on macOS arm64, with a synthetic Claude Code stub and no real provider quota. No minimum Desktop version is recorded; other Desktop versions are untested. The earlier full synthetic smoke (S1-S13) ran on Desktop `2.2.1` with the previous GUI bundle. The final GUI bundle (SHA-256 `761e180f...`) was exercised only for the composer-model, new-session default, dashboard and Back flows, on Desktop `2.2.2`. The other scenarios were not rerun on `2.2.2`, and the final bundle did not run the full matrix on `2.2.1`. See [Desktop GUI smoke results](docs/support.md#desktop-gui-smoke-results): nothing about the Desktop GUI is verified beyond the PASS rows of that table.
Web, V1, and OpenCode forks are not supported.

## Development

```bash
npx bun@1.4.4 install --frozen-lockfile --ignore-scripts
npx bun@1.4.4 test
npx bun@1.4.4 run typecheck
npx bun@1.4.4 run lint
npx bun@1.4.4 run build
```

Tests are hermetic: synthetic credentials, fixture files, and injected clocks and transports. To add a provider, follow [`docs/adding-a-provider.md`](docs/adding-a-provider.md). Release evidence and the manual smoke checklist are in [`docs/validation.md`](docs/validation.md). Releases are automated; see [`docs/releasing.md`](docs/releasing.md).

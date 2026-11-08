# Behavior reference

Detailed behavior of `opencode-providers-usage`. For install and everyday use, see the [README](../README.md).

## Codex companion (on by default, explicit opt-out)

OpenAI quota uses an existing **file-backed** Codex login on the server. The
companion is enabled without configuration; only a literal `enabled: false`
turns it off. Use the object form of the config entry so that opt-out and the
optional `home` can flow (Form B in the [README](../README.md#loading-the-plugin)):

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

## Reload after configuration changes

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
- When the selected provider ID is exactly `claude-agent`, the sidebar shows
  only a "Claude Code" card with the same 5h and 7d rows as the full
  page's Claude Code card. It shows `Checking quota…` until the first result,
  then `Usage unavailable` (one muted line, no error detail) if collection fails.
  Collection starts on every (re)selection; later input, terminal focus,
  route/session change and model-step completion start one only if 60 seconds
  have passed since the previous attempt started. The experimental Desktop GUI
  summary shows the same card with the same policy. See
  [Claude Code usage](#claude-code-usage).
- `Show provider usage` (`provider-quota.usage`) opens the full page. The slash
  command is `/usage`; if that name is occupied at setup the plugin registers
  `/provider-usage` instead. The page renders one framed card per connected
  provider and, when collection succeeds, a Claude Code card. Each
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

## Claude Code usage

- The full-page card and the `claude-agent` sidebar card are backed by a
  dedicated local CLI source outside the provider inventory. It runs the
  explicit `/usage` local command of the **already
  authenticated local Claude Code CLI** and uses that CLI's existing account.
  It does not ask for or accept a Claude credential, token, account path, or
  endpoint. The `claude` executable must be installed and signed in on the
  machine running the OpenCode server.
- Every opening of the full page starts a fresh collection, and `ctrl+r` starts
  another. The result is never cached across page opens. Collection is
  independent of the connected-provider inventory and does not affect ordinary
  provider sidebar cards. The RPC does not cache or coordinate, so the page and
  the `claude-agent` sidebar may each collect; at most two bounded CLI processes
  (30 s and 1 MiB each) can overlap briefly.
- On the full page, the card is hidden while collection runs and after any
  failure: missing CLI, not signed in, timeout, oversized or malformed output,
  unsupported platform, or a server without the Claude Code usage RPC. Other
  providers keep rendering and no error is shown. The sidebar card instead keeps
  its header and shows `Usage unavailable` on failure.
- The sidebar card (and the Desktop GUI summary) is shown only for
  `claude-agent` and uses the same rows, collection and collection-floor rules
  as described in [Terminal UI](#terminal-ui).
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
  the full-page UI and RPC integration were not live-verified. The sidebar card
  was tested only with a fake host and stubbed RPC; it has not been verified in
  a live OpenCode session with a real `claude-agent` selection. Other CLI
  versions and other POSIX platforms remain unverified. Platforms without POSIX
  process groups are unsupported and hide the page card. So does an unavailable
  absolute home directory. The sidebar card shows `Usage unavailable` in those
  cases.

## Freshness and request behavior

- For ordinary providers the sidebar loads once on activation. Keyboard input,
  terminal focus, route/session changes, and model-selection changes refresh when
  the last full success is at least `60_000` ms old (or missing). Model-step completion refreshes the provider
  that actually served that step, regardless of age. Bursts coalesce, with a
  trailing refresh for completions inside the request floor.
- Successful reads do **not** schedule polling. While idle, the sidebar keeps the
  last fully successful figures, even beyond normal expiry or a reported reset.
  It never estimates a refill. History is server-runtime memory only. The
  `claude-agent` card has its own 60-second collection floor (see
  [Terminal UI](#terminal-ui)), schedules no polling, and repaints its reset
  countdowns on a display timer without collecting.
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
  [`validation.md`](validation.md).

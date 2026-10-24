# Adding a provider adapter

The extension point is deliberately narrow: **one adapter module, one
registration line, synthetic fixtures, and a docs row**. Core, RPC, and UI code
must not change. The support-matrix test enforces the docs half of this
contract; the existing registry and presentation tests are the other gates.

## Checklist

- [ ] Create `src/providers/<name>.ts` exporting a zero-argument factory that
      returns a `ProviderAdapter` (or the smallest input object needed to inject
      an existing credential source, as `createOpenAICompanionAdapter` does).
      Name the factory `create<Name>Adapter` (for example `createAcmeAdapter`):
      the support-matrix test's registration check over `src/index.ts` depends
      on that pattern.
- [ ] Give the adapter a stable `id` (for example `acme-balance`).
- [ ] Declare **every** authentication/registration combination in
      `capabilities`, using exact `providerID`/`integrationID` strings and an
      exact `authMethod`. No glob patterns, no name matching.
- [ ] Set `support` and `evidence` honestly:
      `supported`, `unsupported`, `not-applicable`, or `requires-companion`;
      `live-validated`, `documented-only`, or `unverified`.
- [ ] Implement `resolve(input)`. Return `null` when the adapter does not claim
      the provider so the next registered adapter can try. First non-null wins.
- [ ] Consume the shared `getQuotaJson` transport and existing credential
      sources. Do not create a second HTTP client, use raw `fetch`, or read
      credentials yourself.
- [ ] Return only the frozen public `QuotaRead` shape. Map every failure to an
      existing reason code from `QUOTA_REASON_CODES`; never pass through
      exception text, response bodies, or provider identifiers.
- [ ] Add synthetic-fixture tests under `tests/providers/`. Use injected clocks,
      transports, and credential readers. Never use a real token, account,
      email, credential file, or live endpoint in the default suite.
- [ ] Add exactly one registration entry to `QUOTA_ADAPTERS` in `src/index.ts`:
      `createAcmeAdapter()`.
- [ ] Add the same factory to the adapter list in
      `tests/integration/security.test.ts` (with any required fake injection).
      The matrix test reads the registration point and fails when a registered
      factory is missing from that list.
- [ ] Add one row to the **Machine-checked adapter declarations** table in
      `docs/support.md` with the adapter id, capability name, `Match`,
      auth method, support, evidence, and exact reason codes.
- [ ] Add the human-facing matrix row, setup requirements, and any
      provider-specific recovery text to `docs/support.md`.
- [ ] Run `npx bun@1.4.4 test`, `run typecheck`, `run lint`, and `run build`.

## Adapter shape

```ts
import type {
  AdapterResolveInput,
  ProviderAdapter,
  ResolvedQuotaSource,
} from "../core/contracts";

export function createAcmeAdapter(): ProviderAdapter {
  return {
    id: "acme-balance",
    capabilities: [
      {
        match: { integrationID: "acme", authMethod: "key" },
        name: "Acme Cloud",
        support: "supported",
        evidence: "documented-only",
      },
    ],
    async resolve(input: AdapterResolveInput): Promise<ResolvedQuotaSource | null> {
      if (input.integrationID !== "acme" || input.authMethod !== "key") {
        return null;
      }
      // Resolve the active credential through the provided source, then return
      // a source whose read() calls input.deps.getJson (shared transport).
      return {
        identityKey: "acme-balance:acme",
        read: async () => {
          // Return a validated QuotaRead; never raw provider data.
        },
        isCurrent: async () => true,
      };
    },
  };
}
```

`AdapterResolveInput` supplies `deps.getJson`, `credentialDeps`, the optional
host-backed `nativeCredential`, the resolved `companion` options, and a
cancellation `signal`. Use them; do not reach around them.

## Transports and the allowlist

The shared transport in `src/providers/http.ts` owns the complete request
allowlist. If a new provider genuinely requires a new origin or path, extend
that allowlist in the **same** reviewed change with an exact origin/path pair,
and add tests proving redirects, credentials-in-URL, query strings, fragments,
oversized bodies, and non-allowlisted paths are rejected. Do not bypass the
transport with `fetch`, a provider SDK's default client, or an
OpenAI-compatible base URL supplied by configuration.

No credential may be forwarded to a host outside the adapter's allowlist.

## Credentials

- Reuse `readCodexCompanion` or another existing credential source when it
  matches the storage model. Do not add a competing reader to an adapter.
- The TUI never supplies a path, token, or credential value. Do not add such an
  RPC field.
- Keep credential material out of `identityKey`, diagnostics, errors, and all
  public results. A nonsecret hash or fingerprint is acceptable; a token,
  account ID, email, or client ID is not.
- Read-only means read-only: no login, refresh, rotation, config write, or
  credential-store write.

## Forbidden shortcuts

- **No core edits.** Do not modify `src/core/contracts.ts`,
  `src/core/registry.ts`, or `src/core/refresh.ts` to make one provider fit.
- **No RPC edits.** Do not add methods, events, input fields, or error payloads
  in `src/rpc.ts` for a provider.
- **No UI edits.** Do not modify `src/ui/*` or `src/tui.tsx`. The sidebar and
  full page render from `ProviderSummary` and `QuotaRead` declarations alone.
- **No per-provider branches** in core, RPC, coordinator, or UI code. Provider
  selection belongs only in the adapter's `resolve`.
- **No new transport.** Use `getQuotaJson`; never call `fetch` directly from an
  adapter.
- **No credential forwarding** to hosts outside the adapter's allowlist, and no
  generic OpenAI-compatible endpoint support.
- **No new reason codes or credential fields** in public output. The vocabulary
  and validator are frozen; map to existing codes instead.
- **No persistence of credentials or quota snapshots.** Quota is in-memory and
  expires; credentials are reread from their source.
- **No real credentials in fixtures or docs.** Synthetic sentinels only.
- **No silent broadening.** If the provider reports something the contract
  cannot represent, return an honest unavailable/partial result instead of
  adding a field or guessing.

## Host-runtime constraints learned in live integration (2.1.4)

These are not optional style rules; violating them breaks the TUI:

- **Entrypoint resolution is root-file convention.** Local plugin targets are
  resolved by looking for `<package>/index.*`, `<package>/tui.*`, and
  `<package>/rpc.*` at the package root; `package.json` `exports` apply only
  to *named* package installs. This repository keeps root shims
  (`index.ts`, `tui.tsx`, `rpc.ts`) re-exporting `src/*` — a new provider
  must not need any change there.
- **Never pass function values as JSX `children`.** The host re-invokes
  function children re-entrantly; combined with reactive reads inside the
  same render path it degenerates into a synchronous recursion
  (`RangeError: Maximum call stack size exceeded`) on the first host
  re-reconcile. Children must be plain strings or pre-built static nodes.
- **Render closures read memo/signal getters of OUR OWN state only.** Host
  reactive reads (`ui.model.current()`, `data.location.*`) belong in
  `createEffect`/setup code that writes our own signals.
- **Keymap layer factories must be pure.** Reading `keymap.commands()` inside
  the factory re-enters the command store while it registers and crashes with
  the same RangeError. The `/usage`-or-`/provider-usage` choice is evaluated
  once at setup.

## Why the docs row is part of the code contract

`tests/integration/security.test.ts` builds the same adapter registry the server
builds, then parses the declarations table in `docs/support.md`. Each adapter
capability must have exactly one row whose `Match`, `Auth method`, `Support`,
and `Evidence` match the declaration, and whose `Reason codes` include the
reason observed from an unavailable resolve. The test also fails if a document
row has no registered capability. That is how a new adapter cannot ship
undocumented, and how a stale row is caught.

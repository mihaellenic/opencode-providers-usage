# Releasing opencode-providers-usage

Releases are automated with Release Please and npm trusted publishing.
**Merging the release PR into `main` approves publication of that version.**
Do not merge it just to update the changelog.

## Setup

Owner-only, one time:

- Enable **Settings → Actions → General → Allow GitHub Actions to create and approve
  pull requests**.
- For local development, run `bun install` and `bun run setup` to install the
  Conventional Commit hook. CI also validates commit subjects.

Do not request, paste, or store token values in chat, in the repository, or in CI
settings.

Tool versions come from [release.yml](../.github/workflows/release.yml) and
[validate-release-pr.yml](../.github/workflows/validate-release-pr.yml). Use them when
reproducing a failure locally:

| Tool | Version | Notes |
| --- | --- | --- |
| Bun | 1.4.4 | pinned by `packageManager`, `engines`, and every workflow |
| Node | 24 | Node 24 is the release toolchain in both release workflows |
| npm | 11.16.0 | installed and checked by both release workflows |

## 1. Review and merge the release PR

On pushes to `main`, Release Please creates or updates a `chore(main): release X.Y.Z`
PR with the package version, `CHANGELOG.md`, and `.release-please-manifest.json`.
The version policy is in [release-please-config.json](../release-please-config.json):
while below 1.0, `feat` and breaking changes bump the minor version; `fix` bumps the
patch version. Preserve existing release tags and manifest history.

Before merging:

1. Review the proposed version, changelog, and full diff, especially workflow and
   acceptance-script changes. License, copyright, and author changes need owner approval.
2. Find **Validate release PR / release-pr-validation** for the PR's exact current
   head. The validator runs for same-repository `release-please--` branches on
   `opened`, `synchronize`, and `reopened` events. A PR created by a bot may not
   trigger the workflow automatically. If no run appears, inspect the workflow events
   and Release Please logs, and do not merge until the PR is validated, for example by
   approving or re-running the workflow after reviewing the diff.
3. Require a successful validation and inspect its **Summary** tab and logs for
   acceptance, consumer audit, and head freshness. An absent, pending, stale, or
   failed run is not success. This is not an enforced required check unless the live
   branch rules say so; enforce this review yourself before merging.
4. Recheck the current base and merge result after validation. Freshness verifies the
   head and PR state at that check only, not the current base or merge result. A
   changed head needs new validation; a changed base needs renewed review and, where
   relevant, updated validation.

The PR validator checks out the exact PR head and runs typecheck, lint, tests, build,
commit-subject checks, and artifact acceptance. It has read-only repository and PR
permissions and no publishing credentials. Its evidence is unsigned and diagnostic,
not a publishing attestation. A PR can change its own workflow definition, so review
that code rather than trusting a green check alone.

## 2. Automated publication

Merging the release PR triggers [release.yml](../.github/workflows/release.yml). The
publish job runs only when Release Please reports a created release (or on a recovery
dispatch, see [Failure and recovery](#failure-and-recovery)), in this order:

1. Release Please creates the release tag and GitHub release.
2. The publisher resolves the tag, which must look like `vX.Y.Z`, and checks out that
   exact tag, not floating `main`. It verifies that the checked-out tag agrees with
   `package.json`.
3. It sets up Node 24, installs npm 11.16.0, and sets up Bun 1.4.4.
4. It runs `bun install --frozen-lockfile --ignore-scripts`, tests, lint, typecheck,
   and build.
5. It runs fresh artifact acceptance with `scripts/release-acceptance.ts`. It never
   downloads or trusts the PR validator's artifact.
6. It uploads the evidence, including after an acceptance failure.
7. It publishes only the accepted tarball with
   `npm publish <accepted tarball> --access public`, using OIDC trusted publishing.
8. It verifies the registry with
   `bun scripts/release-acceptance.ts --verify-published <artifact.json>`.

A GitHub release or a green PR check does not prove npm publication succeeded.
Confirm that the publish job, including the registry verification step, passed. The
publisher executes release code, so pre-merge review of that code remains essential.

### Acceptance and security gates

[scripts/release-acceptance.ts](../scripts/release-acceptance.ts) is shared by PR
validation and publication. It never publishes and never modifies the repository.
It runs two guards before it makes any network request, install, build, or pack, and
before it creates or writes anything:

- **Runtime.** The running Bun must be exactly Bun 1.4.4. The expected version is read
  from the committed `packageManager` and `engines.bun` pins; both must be present,
  exact, and equal, otherwise acceptance stops. The same guard applies to
  `--verify-published`.
- **Output directory.** `--output-dir` must be a new or existing-empty directory.
  Acceptance refuses, and leaves untouched, a directory that holds any file, a regular
  file, a symlink, and any path that is the source repository or inside it (including
  through a symlinked alias of the repository). Use a fresh directory for every run.

It then:

- Refuses an already-published version or an inconclusive registry lookup.
- Exports the committed source with `git archive`, excluding untracked files and local
  build output, then installs, tests, lints, typechecks, and builds the clean export.
- Audits the source lockfile with `bun audit`.
- Packs exactly one tarball and checks the manifest, host-runtime externals, and package
  contents. The package has five export paths; the tarball may contain only
  `package.json`, `README.md`, `LICENSE`, `index.js`, `tui.js`, `rpc.js`, and the four
  `dist/` bundles.
- Installs the tarball in a scratch production consumer with the host peers and
  lifecycle scripts disabled, imports the four terminal export paths, and resolves the
  experimental GUI export. Resolution is not a GUI load test.
- Audits that consumer's production tree with `npm audit --omit=dev`, not the
  repository.
- Preserves the accepted tarball and its hashes in `artifact.json`, whose fields are
  `name`, `version`, `filename`, `path`, `integrity`, `shasum`, and `sha256`.
  `artifact.json` does not contain a commit; acceptance prints the source commit in its
  summary as `commit:`.

High and critical advisories block acceptance. There is no waiver mechanism. Audit
errors and malformed reports fail closed. Do not bypass peer resolution or suppress
warnings to get a green release.

### Evidence artifacts and retention

Both workflows upload evidence when files exist, including after acceptance failure.
An early failure may produce no artifact. Artifacts are retained for 14 days:

- PR validation: `release-pr-evidence-<PR>-<attempt>`.
- Publication: `release-evidence-<tag>`.

Depending on how far acceptance got, evidence contains the tarball, `artifact.json`,
`bun-audit.json`, the raw `npm-audit-omit-dev.json`, and optional stderr files. PR
validation also records `head-status.json` when the freshness step runs. The
human-readable summary is in the workflow run, not the artifact directory. Identify
evidence by run URL, attempt, and commit or tag, not by artifact name alone. Keep what
you need with the release record before it expires, and keep private session data out of
shared records.

## 3. Optional owner-run post-publish checks

These are optional owner checks after automated publication. They are not a publish
gate: automated acceptance decides publication. Host smoke tests are not a publish
gate, and they do not widen the support or validation claims in the
[README](../README.md), [docs/support.md](support.md), or
[docs/validation.md](validation.md). Only record successful checks as current
evidence; unavailable checks remain unverified.

A minimal isolated load check against the registry package uses no credentials and
runs outside the repository. Replace `X.Y.Z` with the released version:

```sh
export CONSUMER_DIR="$SCRATCH_ROOT/post-publish-consumer"
mkdir -p "$CONSUMER_DIR" && cd "$CONSUMER_DIR"
npm init -y >/dev/null
npm pkg set overrides.solid-js=1.9.18
npm install --ignore-scripts opencode-providers-usage@X.Y.Z \
  @opencode/theme@2.2.5 @opentui/core@0.8.0 @opentui/solid@0.8.0 solid-js@1.9.18
cat > load-check.mjs <<'EOF'
const names = [
  "opencode-providers-usage",
  "opencode-providers-usage/server",
  "opencode-providers-usage/tui",
  "opencode-providers-usage/rpc",
];
for (const name of names) {
  await import(Bun.resolveSync(name, process.cwd()));
  console.log("ok", name);
}
const gui = "opencode-providers-usage/gui-experimental";
console.log("resolved only (not loaded)", gui, Bun.resolveSync(gui, process.cwd()));
EOF
bun load-check.mjs
```

The peer pins and the `solid-js` override match the consumer-install check in
`scripts/release-acceptance.ts`. The override keeps a single locked `solid-js@1.9.18` in
the consumer tree. If npm resolves anything differently, stop and report. This check
imports four export paths under Bun and resolves the fifth GUI path; resolution is not
a GUI load test.

Real-host smoke tests are also optional owner checks. If run, follow
[docs/validation.md](validation.md) with scratch configuration and isolated synthetic
fixtures, and install the registry package by name rather than through a
source-checkout symlink. Do not alter real sign-ins or send model requests.

## Failure and recovery

- **A publish error is ambiguous.** A failed or interrupted `npm publish` may or may
  not have reached the registry. Before any retry, run
  `bun scripts/release-acceptance.ts --verify-published <artifact.json>` with the
  preserved `artifact.json` from the acceptance evidence, then act on the result:
  - **Match** (version and `dist.integrity` equal the accepted values, exactly equal to
    the accepted `integrity`): the publish succeeded; do not republish. Investigate the
    remaining failed step.
  - **E404** (version not found): this is only a signal. You must independently confirm
    that the version remains unpublished (for example from the npm package page or a
    second `npm view` the owner runs), allowing for propagation delay.
  - **Auth, network, malformed output, or mismatch:** none of these is proof that the
    version is unpublished. Stop and investigate with the owner; do not retry.
- **Never retry blindly.** Retry only when absence is confirmed as above, and then only
  the same accepted tarball for the same tag, nothing else. If the retry fails, stop
  and report.
- **A failed publish remains visible:** do not bump the version and do not move the
  tag. Never bump the version, never move the tag, and never automatically unpublish.
  Never record credential values in a release record.
- **npm versions are immutable.** Once a version is published, that version number
  cannot be reused for different content. Do not reuse a tag; never move an existing tag.
- **Rollback is fix-forward or owner-driven.** Ship a new version (fix-forward), or let
  the owner deprecate the version or move a dist-tag; never automated unpublish.
- **Acceptance failure stops the release.** Fix the source in a new commit; the release
  PR is updated and validated again. Earlier evidence is not reused for a new commit.
- **Failure before publication:** use **Actions → Release → Re-run failed jobs** on the
  original run to keep its Release Please outputs and repeat acceptance.
- **Original run cannot be retried:** use **Actions → Release → Run workflow** with
  `release_tag` set to an existing `vX.Y.Z`, with **Use workflow from** set to `main`:
  the publish job is skipped for any other ref, so a branch copy of the workflow
  cannot publish. Recovery requires a non-draft GitHub
  release and a matching tag and package version. It repeats acceptance and
  publication, so run it only after confirming the version is not on the registry.
  It is not a PR-validation path.
- **Version already exists on npm:** do not retry publishing or bypass the
  duplicate-version guard. Compare its registry integrity with the original accepted
  `artifact.json`. If it matches, publication succeeded; investigate the remaining
  failed step. If it differs, stop and investigate.
- **Verification mismatch** (registry version or `dist.integrity` differs from
  `artifact.json`): stop and investigate the registry state with the owner before any
  further action.

## History

`0.1.0` was published manually by the owner with interactive 2FA. That bootstrap publish
did **not** produce OIDC provenance, and the release report must not claim that it did.
The tag `v0.1.0` and its GitHub release existed first, and
`.release-please-manifest.json` was seeded at `0.1.0` after that baseline. No `0.0.0`
history exists; never fabricate `0.0.0` history or a `0.0.0` tag.

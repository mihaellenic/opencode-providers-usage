# Releasing opencode-providers-usage

This runbook covers the first public release (`0.1.0`) and the manual flow that
applies to every release until release automation is implemented in Task 5.
Nothing in this document is performed automatically by the repository. A step
counts as done only when its evidence is recorded in the release report.

## Approval boundary

The following actions require **explicit owner approval** before anyone runs
them. Research or inference is never authorization:

- public-source review of the repository contents;
- the MIT license and attribution to Mihael Lenic (`package.json` `license` and
  `author` fields);
- the public repository identity `mihaellenic/opencode-providers-usage`,
  including its owner, name, and visibility. The owner `mihaellenic` is a
  research finding, not authorization to create a repository;
- creating the repository, adding a remote, and pushing `main`;
- the first npm publish of `opencode-providers-usage@0.1.0`;
- creating the `v0.1.0` tag and the GitHub release.

Do not request, paste, or store token values in chat, in the repository, or in
CI settings.

## Preflight

Use the pinned Bun toolchain and an approved temporary directory for scratch
work. The examples below use placeholders; the path used on the release machine
for the 0.1.0 candidate is a local example only and must not be copied to other
machines.

| Check | Required | Notes |
| --- | --- | --- |
| Bun | 1.4.4 | pinned by `packageManager`, `engines`, and the CI workflow |
| Node | 24 | release toolchain observation (see note) |
| npm | 11.16.0 or later | observed, not pinned: the local machine reported 11.19.1 |

Node 24 is the release toolchain observation: `node --version` reported v24.22.1
on the release machine. `ci.yml` does not pin Node, so Node 24 is not a CI match
and CI does not verify it.

```sh
# local example only: a per-user temp dir such as <tmp>/T/opencode
export SCRATCH_ROOT=<approved-scratch-root>
bun --version        # expect 1.4.4
node --version       # release toolchain observation: v24.x
npm --version        # expect 11.16.0 or later
git status --short   # expect no output: the release source must be committed
```

## Local acceptance (no public action)

### 1. Install and check

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run lint
bun run typecheck
bun run build
bun scripts/bun-audit-gate.ts
```

### 2. Record the source commit

Before acceptance, record the exact commit that will be accepted and tagged:

```sh
git rev-parse HEAD   # copy this value into the release report as the source commit
```

`artifact.json` does not contain a commit. The source commit lives in the
release report, and acceptance also prints it in its summary as `commit:`.
Check that the two values are identical.

### 3. Accept the exact commit

```sh
bun scripts/release-acceptance.ts --output-dir <absolute-dir>
```

Acceptance exports `HEAD` with `git archive` into a fresh directory under
`SCRATCH_ROOT`, so it validates committed content only. It runs the checks,
audits the lockfile, packs exactly one tarball, installs that tarball into a
scratch consumer with the host peers, imports all four export paths, and audits
the consumer production tree. It never publishes and never modifies the
repository.

`<absolute-dir>` must be an absolute path that is not inside the acceptance
scratch directory. Acceptance writes these files there:

- the tarball `opencode-providers-usage-0.1.0.tgz`;
- `artifact.json`, whose fields are `name`, `version`, `filename`, `path`,
  `integrity`, `shasum`, and `sha256`;
- `bun-audit.json` and `npm-audit-omit-dev.json`, the raw audit evidence.

Record in the release report: the source commit from step 2, the tarball path,
`integrity`, `sha256`, and the evidence directory. Keep the directory; later
steps depend on it. If `HEAD` changes for any reason, rerun this whole section.

## Owner-only: repository bootstrap and hosted CI

Every command and decision in this section belongs to the owner. The agent does
not perform these actions.

1. Owner approves the boundary in [Approval boundary](#approval-boundary).
2. Owner creates the public repository `mihaellenic/opencode-providers-usage`
   with the approved visibility. No placeholder content is pushed first.
3. Owner adds the remote using SSH, or a credential permitted to push workflow
   files. The observed `gh` token lacks the `workflow` scope and cannot push
   `.github/workflows/ci.yml`; do not use it for this push.
4. Owner pushes the reviewed bootstrap source, including `ci.yml`, to `main`.
   The pushed commit must be the source commit recorded in step 2.
5. Owner confirms hosted CI is green on that exact commit. Publication must not
   begin until hosted CI is green on the source commit.

If the owner needs a different commit on `main`, the local acceptance section
must be rerun on that commit, and the new commit becomes the source commit.

## Owner-only: publish the accepted tarball

### 4. Publish

The owner publishes **the tarball produced by acceptance**; never repack the
working tree:

```sh
npm publish <accepted-tarball> --access public
```

- Owner authentication is interactive: the owner signs in to npm and completes
  2FA when prompted, with no stored token. Do not place an npm token in the
  environment, in a repository `.npmrc`, or in CI secrets for this step.
- If `npm publish` fails, see [Failure and recovery](#failure-and-recovery).

### 5. Verify the registry

```sh
bun scripts/release-acceptance.ts --verify-published <artifact.json>
```

Use the `artifact.json` from the acceptance evidence directory unchanged. The
command checks that the registry reports version `0.1.0` and a `dist.integrity`
exactly equal to the accepted `integrity`, with a bounded retry for npm
propagation. A mismatch in either field is a failure: stop and reconcile before
any tag is created.

Then run a minimal isolated load check against the registry package. It uses
no credentials and runs outside the repository:

```sh
export CONSUMER_DIR="$SCRATCH_ROOT/post-publish-consumer"
mkdir -p "$CONSUMER_DIR" && cd "$CONSUMER_DIR"
npm init -y >/dev/null
npm pkg set overrides.solid-js=1.9.17
npm install --ignore-scripts opencode-providers-usage@0.1.0 \
  @opencode/theme@2.1.4 @opentui/core@0.6.8 @opentui/solid@0.6.8 solid-js@1.9.17
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
EOF
bun load-check.mjs
```

The peer pins and the `solid-js` override match the consumer-install check in
`scripts/release-acceptance.ts`. `@opentui/solid@0.6.8` declares an exact
`solid-js@1.9.12` peer, and the override forces the locked `1.9.17`. If npm
resolves anything differently, stop and report.

This check proves the four export paths load under Bun. It does not replace the
full OpenCode V2 terminal smoke: follow the headless artifact smoke and manual
smoke procedure in [`docs/validation.md`](validation.md) before treating the
release as user-verified.

This bootstrap publish uses owner authentication with 2FA. It does **not**
produce OIDC provenance, and the release report must not claim that it does.

### 6. Tag and create the GitHub baseline

After step 5 succeeds, the owner:

- creates the annotated tag `v0.1.0` on the source commit recorded in step 2,
  which is the same commit that was accepted and built into the published
  tarball, and pushes the tag;
- creates a **non-draft** GitHub release for `v0.1.0` with accurate initial
  notes: the version, the source commit, the tarball `integrity`, and the fact
  that this is the first publication.

Do not reuse a tag; never move an existing tag. Never publish a placeholder
package, and never fabricate `0.0.0` history or a `0.0.0` tag to make release
automation look continuous.

### 7. Seed release automation

Release automation's manifest is seeded with `{".": "0.1.0"}` only after steps 4
through 6 are complete and the registry, tag, and source evidence agree. Seeding
earlier would let automation propose a release on top of an unverified
baseline. This seeding is part of Task 5; until then, nothing in this repository
seeds the manifest.

If any part of the baseline already exists when you run this runbook, reconcile
the registry, tag, and source evidence before changing anything. Do not repeat
the publication.

## Failure and recovery

- **A failed publish remains visible:** do not bump the version and do not move
  the tag. Retry only the same accepted artifact and the same tag. If the retry
  fails, stop and report.
- **npm versions are immutable.** Once `0.1.0` is published, that version
  number cannot be reused for different content.
- **Rollback is fix-forward or owner-driven.** Ship a new version (fix-forward),
  or let the owner deprecate the version or move a dist-tag; never automated unpublish.
- **Acceptance failure stops the release.** Fix the source, commit, and rerun
  acceptance from the local acceptance section on the new commit. Earlier
  evidence is not reused for a new commit.
- **Verification mismatch** (registry version or `dist.integrity` differs from
  `artifact.json`) blocks tagging. Investigate the registry state with the owner
  before any further action.

## Later releases

Release automation is not implemented yet. Until Task 5 is complete, every later
release uses this manual flow: local acceptance on the exact release commit,
owner publication of the accepted tarball, registry verification, then tag and
release. Automated release proposals are merged only after the baseline above
is in place and Task 5 has landed.

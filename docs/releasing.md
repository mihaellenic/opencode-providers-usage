# Releasing opencode-providers-usage

This runbook covers the first public release (`0.1.0`) and the steps every later
release follows. Nothing in this document is performed automatically by the
repository. A step counts as done only when its evidence is recorded in a
release report.

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
CI settings. The owner chooses the credential used to push workflow files (SSH,
or a credential with `workflow` scope).

## One-time bootstrap

Run these steps in order. Stop and report if any step fails.

### 1. Preflight

Use the pinned toolchain and the approved scratch root.

| Tool | Required | Notes |
| --- | --- | --- |
| Runtime | Bun 1.4.4 | matches `packageManager` and CI |
| Runtime | Node 24 | release toolchain major version |
| Package manager | npm 11.16.0 or later | the local machine observed npm 11.19.1 (`npm --version`); that observed version is acceptable, but it is not a pinned requirement |

```sh
export SCRATCH_ROOT=/private/var/folders/g4/1c3drxkd7099x31fjzffcjjw0000gn/T/opencode
bun --version        # expect 1.4.4
node --version       # expect v24.x
npm --version        # expect 11.16.0 or later
git status --short   # expect no output: the release source must be committed
```

### 2. Install and check

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run lint
bun run typecheck
bun run build
bun scripts/bun-audit-gate.ts
```

### 3. Accept the exact commit

Acceptance exports `HEAD` with `git archive` into a fresh directory under
`SCRATCH_ROOT`, so it validates committed content only. It runs the checks,
audits the lockfile, packs exactly one tarball, installs that tarball into a
scratch consumer with the host peers, imports all four export paths, and audits
the consumer production tree. It never publishes and never modifies the
repository.

```sh
bun scripts/release-acceptance.ts --output-dir <absolute-dir>
```

`<absolute-dir>` must be an absolute path that is not inside the acceptance
scratch directory. It receives the preserved tarball, `artifact.json`, and raw
audit evidence. Record the tarball path, `integrity`, and sha256 in the release
report, and keep the directory: steps 4 and 5 depend on it.

### 4. Publish the accepted tarball (owner action)

The owner publishes **the tarball produced in step 3**; never repack the
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

Use the `artifact.json` from step 3 unchanged. The command checks that the
registry reports version `0.1.0` and a `dist.integrity` exactly equal to the
accepted metadata, with a bounded retry for npm propagation. A mismatch in
either field is a failure: stop and reconcile before any tag is created.

Then verify that the package name loads in an isolated OpenCode V2 environment
from the npm registry, not from the working tree.

This bootstrap publish uses owner authentication with 2FA. It does **not**
produce OIDC provenance, and the release report must not claim that it does.

### 6. Tag and create the GitHub baseline (owner action)

After step 5 succeeds:

- create the annotated tag `v0.1.0` on the **exact accepted source commit**
  (the `HEAD` recorded in `artifact.json`) and push it;
- create a **non-draft** GitHub release for `v0.1.0` with accurate initial
  notes: the version, the accepted commit, the tarball integrity, and the fact
  that this is the first publication.

Do not reuse a tag; never move an existing tag. Never publish a placeholder package, and
never fabricate `0.0.0` history or a `0.0.0` tag to make release automation
look continuous.

### 7. Seed release automation (after the baseline exists)

Release automation's manifest is seeded with `{".": "0.1.0"}` only after steps 4
through 6 are complete and the registry, tag, and source evidence agree. Seeding
earlier would let automation propose a release on top of an unverified
baseline.

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
  acceptance from step 3 on the new commit. Earlier evidence is not reused for
  a new commit.
- **Verification mismatch** (registry version or `dist.integrity` differs from
  `artifact.json`) blocks tagging. Investigate the registry state with the owner
  before any further action.

## Later releases

Later releases follow the same pattern: acceptance on the exact release commit,
publication of the accepted tarball by the owner, registry verification, then
tag and release. Automated release proposals are merged only after the baseline
described above is in place.

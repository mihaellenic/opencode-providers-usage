# Approved sidebar reference (iteration 02)

`approved-iteration02.html` is a byte-for-byte copy of the recovered user-approved
mock at:

`/private/var/folders/g4/1c3drxkd7099x31fjzffcjjw0000gn/T/opencode/recovered-sidebar-mock/quota-mockup-approved-iteration02.html`

Provenance:

- Source session: `ses_e91ad7cd1ffe9TS7ErJDbLoC0H` (“OpenCode provider quota plugin”).
- Iteration 02 message: `msg_16e5e8a0300115NVRpdCvF5vsM` (2026-10-24, compact sidebar request).
- User acceptance: `msg_16e605c940015kMhhM9QZkMnUc` (2026-10-24 16:46:11, “yes that's great”).
- The original server stored the mock in memory only and is gone. The recovered
  HTML is a deterministic reconstruction: the recorded iteration-02 render()
  replacement was re-applied to the exact iteration-01 HTML. Its recorded
  assertions passed: the all-provider page remained byte-identical, and the
  sidebar used compact text rows.
- SHA-256 of the recovered file and this copy:
  `578584f52a4086104fcf87d83fd8a65bc362217e3f325637c913a5cb31033176`.
- Adjacent recovered artifacts: `mock-approved-openai.png`,
  `mock-approved-ollama.png`, `mock-approved-zen.png`, and
  `sidebar-rows-exact.txt` in the source directory above.
- Render reference: `approved-page-view-render.png` (all-provider page view of
  this frozen file).

## Approved iteration 03 (2026-10-26)

`approved-iteration03.html` derives from the frozen iteration-02 file above and
records the terminal treatments approved interactively on 2026-10-26 in the
details-page planning session. It is the binding page spec for
`docs/superpowers/plans/2026-10-26-details-page-mock-alignment.md`; iteration 02
remains the frozen acceptance artifact and is never edited.

Approved changes from iteration 02:

- Sidebar quota block mirrors the live `buildSidebarModel` render: plain
  provider-name header only (no `Quota` label, no browser-only “View all
  providers” link, no update-age line), pinned to the **footer of the sidebar**
  as in the running host, with thin bars whose used segment is text-colored and
  whose remaining segment is the muted track. Cells show used percentages
  (muted for normal tone, warning at ≥80%, error at 100%) and countdown resets
  (`· resets 58m`, `· resets 6d 20h`); Ollama renders the credit pair
  (`$33.47 / $60.00 used` / `+$4.27 credits`). Fixtures mirror the running host
  screenshots.
- Page cards are strict copies of the sidebar widgets for every connected
  provider: same provider header (host registry display name used by the
  sidebar, falling back to the declared name), same rows, same compact window
  labels, same countdown resets, and same tones. No badges, card subtitles,
  support·evidence or auth-method meta rows, auth-source rows, per-metric detail
  lines, or `Subscription allowance ≠ API credit balance` footnote.
- The later sidebar-parity correction (below) removed the previously approved
  page-only update-age cell, absolute reset timestamps, explicit `Total credits`
  row, scope-qualified window labels, shared-plan rows, and configured-cap row.
  Those iteration-03 page cells remain visible in the frozen artifact but are no
  longer the binding page content.
- Footer keys: `esc back · ctrl+r refresh`; the browser-only top-right back
  link and prototype disclaimers are removed.
- The unavailable card reduces to the sidebar's own copy: name plus
  `Quota unavailable`, with no explanation block and no attempted line.

Fixture values remain illustrative; the interpretation rules below still apply.
SHA-256: `0fcb97e15372fabf75c28b953b534b38dad3eda2fa24189fff8a008a38b42135`
(current corrected artifact; the plan records `c5ca0eac7ae1e0e1495cc5577fb9d0db1caa6ef71183be63dcfdedb840e4d8ea`
for the pre-correction page labels).

Renders: `approved-iteration03-render.png` (all-provider page),
`approved-iteration03-sidebar-render.png` (sidebar, OpenAI),
`approved-iteration03-sidebar-ollama.png` (sidebar, Ollama).

Implementation status (2026-10-26): `src/ui/usage-page-model.ts` and
`src/ui/UsagePage.tsx` render this card content, and the sidebar and page share
the `src/ui/bar-row.tsx` line painter. The renders above remain design
references, not live-host captures.

### Live-host visual correction (2026-10-26)

The first live `/usage` render did **not** visually match
`approved-iteration03-render.png`. The card *contents* matched, but the page
chrome did not: the live page drew unframed card sections at full width, while
the approved mock shows framed, padded provider cards laid out responsively.
The user explicitly corrected this and asked for the page to align with the
mock, overriding the earlier implementation interpretation. The binding
requirements are now:

- each provider card is a framed, padded box (border plus inner padding), not a
  bare column of rows;
- cards use a responsive grid: two columns when horizontal room allows,
  collapsing to one column when narrow;
- the page content is bounded by a maximum width rather than stretching edge to
  edge on wide terminals;
- a footer divider separates the key hints from the card area;
- a card that cannot share a row (for example a lone remaining card, as the
  unavailable provider in the mock) spans the full row rather than leaving a
  half-width gap.

Why the discrepancy happened: the plan's Task 4 layout notes said "cards
separated by one blank line … no invented card borders" (see
`docs/superpowers/plans/2026-10-26-details-page-mock-alignment.md`). That was an
implementation-time interpretation, not an approved visual decision, and it is
now overridden by this correction. The iteration-03 artifacts remain the
authority for the visual target.

The frozen `approved-iteration02.html`, `approved-iteration03.html`, their PNG
renders, and all recorded SHA-256 values are unchanged by this correction. No
mock artifact was regenerated: the mock already showed the intended frames,
padding, responsive columns, bounded width, and footer divider. Only the
terminal implementation is expected to change.

Implementation and validation status: the correction is implemented,
live-verified, and review-approved with no blockers. In tmux via
`scripts/dev-opencode.sh` (OpenCode 2.1.4), `/usage` at 120×50 paints two framed
cards whose bodies match their sidebar widgets row for row: Ollama shows its
name, used bar with countdown, and used/credits pair; OpenAI shows its name and
`5h`/`7d` rows. At 80×50 the cards stack with the footer intact. Short-height
finding: at 80×24 the unscrolled page clipped and overlapped content, so the
page uses a focused whole-page scrollbox with a bounded route height and
unclipped content. Automated tests drive real `PageDown`/`End`/`Home` events at
80×24; live at 24×24, `End` reaches the last card and footer and `Home` returns
to the header. Card bottoms align equally, asserted by tests with no style
change. Automated checks: 313 passing tests across 20 files (0 failures, 2682
assertions), with typecheck, lint, and build all clean. The frozen 02/03 HTML
SHA-256 values above are unchanged. No live private values are recorded here.

### Sidebar-parity correction (2026-10-26, later)

After the live visual correction, the user rejected the remaining page-only
content differences and required every card to match its sidebar widget
exactly: no deviations. `buildUsagePageModel` now delegates each card to
`buildSidebarModel`, so the page adds no rows of its own. Consequences:

- the update-age cell, absolute reset timestamps, explicit `Total credits` row,
  scope-qualified window labels (`App · 5-hour window`), shared-plan rows, and
  the configured-cap row are removed;
- window labels are compact durations (`5h`, `7d`) sorted by duration, and
  resets are countdowns (`resets 3h 33m`), exactly as the sidebar renders them;
- `QuotaUsagePage` resolves the host registry display name for every provider
  and passes it to the page, so OpenAI renders as `OpenAI` like the sidebar,
  falling back to the declared provider name when the host has no label;
- unsupported providers still show only `Quota unavailable`; the total and
  purchased pools remain folded into the credit pair.

This supersedes the iteration-03 page-content additions listed above. Card
frames, padding, the compact 56-column width, responsive grid, scrollbox, and
footer are unchanged. The frozen artifacts and SHA-256 values are untouched.

Interpretation rules:

- The HTML’s illustrative data (including `ChatGPT Plus`, `Account-wide`,
  `$50.10 of $60`, and `83.5% left`) is preserved verbatim as a design
  reference. It is not a real balance snapshot and those invented fixture
  labels are not reported quota facts.
- The browser styling in the HTML is a visual reference, not a screenshot of
  the terminal implementation. The terminal must use semantic theme colors,
  compact aligned cells, and the accent-left block rather than browser hex
  colors or font sizes.
- The terminal implementation derives every value from structured quota
  fields. It must not copy fixture labels or infer missing allowance, totals,
  resets, or provider identities from this reference.

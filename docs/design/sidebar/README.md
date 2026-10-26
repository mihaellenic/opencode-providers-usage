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
  provider: no badges, no card subtitles, no support·evidence or auth-method
  meta rows, no auth-source row, no per-metric detail lines, and no
  `Subscription allowance ≠ API credit balance` footnote. Headers show the
  provider name plus the update-age cell; rows are the same thin text-colored
  used / muted remaining bars with used-percent cells and the same host fixture
  (100%/16% windows, 55.8% allowance, $33.47 / $60.00 used, $37.74 total).
- Page-only approved additions: the update-age cell, absolute reset/refill
  timestamps (`· resets Oct 26 14:14`, `· resets Nov 20 10:16`) instead of the
  sidebar's countdowns, and an explicit `Total credits` row (the sidebar folds
  it).
- Page window labels are scope-qualified (`App · 5-hour window`); the redundant
  `N% used` sub-text is dropped. The page section was corrected to this
  approved label form on 2026-10-26 so the static artifact matches the plan
  text (the plan's recorded SHA names the pre-correction artifact).
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
`src/ui/UsagePage.tsx` render this card layout, and the sidebar and page share
the `src/ui/bar-row.tsx` line painter. The renders above remain design
references, not live-host captures.

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

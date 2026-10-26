# Sidebar and usage-page design reference

`approved-iteration02.html` and `approved-iteration03.html` are frozen
user-approved mocks. They and their PNG renders are visual references only and
are never edited. Iteration 02 froze the sidebar treatments; iteration 03
extends the same vocabulary to the all-provider page.

Renders:

- `approved-page-view-render.png` — iteration 02, all-provider page
- `approved-iteration03-render.png` — iteration 03, all-provider page
- `approved-iteration03-sidebar-render.png` — iteration 03, sidebar (OpenAI)
- `approved-iteration03-sidebar-ollama.png` — iteration 03, sidebar (Ollama)

## Sidebar widget

- Plain provider-name header only: no `Quota` label, no update-age line. It is
  pinned to the footer of the sidebar, as in the running host, and the whole
  card is a click target that opens the full usage page.
- Compact bars whose used segment is text-colored and whose remaining segment
  is the muted track. Cells show used percentages (muted for normal tone,
  warning at ≥80%, error at 100%) and countdown resets (`· resets 58m`,
  `· resets 6d 20h`).
- Window rows use duration-only labels (`5h`, `7d`) sorted by duration
  ascending.
- Ollama renders the credit pair (`$33.47 / $60.00 used` / `+$4.27 credits`);
  the derived total pool is folded into that pair and never shown separately.
- A provider with no quota source reduces to its name plus
  `Quota unavailable`.

## Usage page

- One framed, padded card per connected provider. Each card body is exactly
  the sidebar widget for that provider: same header name, same rows, same
  compact duration labels, same countdown resets, same tones. The page adds no
  rows of its own — no update-age cell, no absolute reset timestamps, no
  `Total credits` row, no shared-plan rows, no configured-cap row.
- The card header uses the host registry display name (for example `OpenAI`),
  falling back to the declared provider name when the host has no label.
- Cards share a row when the terminal is wide enough and stack when narrow; a
  card that cannot share a row (for example an unavailable provider) spans the
  full row. Page content is bounded on very wide terminals, and a footer
  divider separates the key hints from the card area. Short terminals scroll
  the whole page instead of clipping cards.
- Footer hints: `esc back · ctrl+r refresh`.

## Interpretation rules

- The HTML's illustrative fixture values (including `ChatGPT Plus`,
  `Account-wide`, `$50.10 of $60`, and `83.5% left`) are preserved verbatim as
  a design reference. They are not real balances, and those invented fixture
  labels are not reported quota facts.
- The browser styling is a visual reference, not a screenshot of the terminal
  implementation. The terminal must use semantic theme colors, compact aligned
  cells, and the accent-left block rather than browser hex colors or font
  sizes.
- Every rendered value must come from structured quota fields. Never copy
  fixture labels or infer missing allowance, totals, resets, or provider
  identities from this reference.
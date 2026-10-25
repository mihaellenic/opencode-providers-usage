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

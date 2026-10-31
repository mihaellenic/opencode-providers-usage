/**
 * Layout-only styles. Colors, fonts and sizes are inherited from the host
 * surface (`color: inherit`, `font: inherit`, `currentColor`): no theme token,
 * palette or panel width is invented here.
 */
export const styles = `
.ou-summary, .ou-dashboard, .ou-summary *, .ou-dashboard * { box-sizing: border-box; }
.ou-summary { position: relative; display: block; font: inherit; color: inherit; max-width: 100%; }
.ou-summary-button {
  display: block;
  width: 100%;
  max-width: 100%;
  margin: 0;
  padding: 0.25em 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.ou-summary-button::after { content: ""; position: absolute; inset: 0; }
.ou-summary-button:focus-visible { outline: none; }
.ou-summary:has(.ou-summary-button:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
.ou-button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.ou-dashboard {
  container-type: inline-size;
  display: block;
  height: 100%;
  max-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  font: inherit;
  color: inherit;
  padding: 0.5em;
}
.ou-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em; margin-bottom: 0.75em; }
.ou-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.1em; font-weight: 600; overflow-wrap: anywhere; }
.ou-button {
  font: inherit;
  color: inherit;
  background: none;
  border: 1px solid currentColor;
  border-radius: 0.35em;
  padding: 0.2em 0.7em;
  cursor: pointer;
}
.ou-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75em;
  margin: 0;
  padding: 0;
  list-style: none;
}
@container (min-width: 36em) {
  .ou-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.ou-card {
  min-width: 0;
  border: 1px solid currentColor;
  border-radius: 0.5em;
  padding: 0.6em 0.75em;
}
.ou-card-name { margin: 0 0 0.4em; font-size: 1em; font-weight: 600; overflow-wrap: anywhere; }
.ou-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1em 0.6em; margin: 0.25em 0; min-width: 0; overflow-wrap: anywhere; }
.ou-label { flex: 0 0 auto; opacity: 0.75; }
.ou-value { flex: 0 1 auto; }
.ou-detail, .ou-reset { opacity: 0.75; }
.ou-bar { flex: 1 1 6em; min-width: 4em; height: 0.5em; border: 1px solid currentColor; border-radius: 0.25em; overflow: hidden; }
.ou-bar-fill { display: block; height: 100%; background: currentColor; }
.ou-summary [data-tone="muted"], .ou-dashboard [data-tone="muted"] { opacity: 0.6; }
.ou-summary [data-tone="warning"], .ou-dashboard [data-tone="warning"] { font-weight: 600; text-decoration: underline dotted; }
.ou-summary [data-tone="error"], .ou-dashboard [data-tone="error"] { font-weight: 700; text-decoration: underline; }
.ou-error { margin: 0.4em 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em; }
.ou-note { margin: 0.25em 0; }
.ou-note[data-unavailable-note] { overflow-wrap: anywhere; }
`;

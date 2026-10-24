// Root-level server plugin entrypoint. OpenCode V2 resolves LOCAL plugin
// targets (config `plugins` array paths and the plugins-directory mechanism)
// by root-file convention: <dir>/index, <dir>/tui, <dir>/rpc — package.json
// "exports" maps apply only for named package installs. Keep these shims in
// sync with src/ for both resolution paths.
export { default } from "./src/index.ts"
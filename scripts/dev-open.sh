#!/usr/bin/env bash
# dev-open.sh — launch a STANDALONE OpenCode with ONLY opencode-providers-usage
# loaded. Your real ~/.config/opencode is never touched.
#
#   scripts/dev-open.sh            companion ENABLED (OpenAI quota visible)
#   scripts/dev-open.sh no         companion disabled (shows the opt-in explanation)
#   COMPOSER=doctor scripts/dev-open.sh   run import/peer checks only, no UI
#
# How isolation works (verified live against OpenCode 2.1.4):
#   - XDG_CONFIG_HOME -> a temporary config directory containing exactly one
#     opencode.jsonc (plugin entry + options) and a plugins/ DIRECTORY holding
#     a SYMLINK to this repo. In V2 the plugin-directory symlink is the
#     ALWAYS-WORKING loading mechanism; a bare absolute plugin path is
#     silently dropped, and `file://` config entries are only honored for
#     packages, never needed here.
#   - XDG_DATA_HOME is NOT overridden, so your real OpenCode data dir
#     (opencode.db: saved keys / active OAuth) is used by the plugin — real
#     quota needs real credentials, read-only.
#   - --standalone runs a private server; your background service is untouched.
#   - The repo is watched recursively by the host (hot reload). A checkout
#     containing churning scratch dirs (e.g. .superpowers) causes constant
#     plugin reloads; this quiet scratch install avoids that during testing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUN() { npx -y bun@1.4.4 "$@"; }

# --- preflight ---------------------------------------------------------------
if ! command -v opencode >/dev/null 2>&1; then
  echo "✗ opencode not on PATH"; exit 1
fi
echo "▶ OpenCode: $(opencode --version 2>&1 | head -1)"
echo "▶ Plugin:  ${PLUGIN_ROOT}"
for f in index.ts tui.tsx rpc.ts src/index.ts src/tui.tsx; do
  [ -f "${PLUGIN_ROOT}/${f}" ] || { echo "✗ missing ${f}"; exit 1; }
done
[ -d "${PLUGIN_ROOT}/node_modules/@opencode/plugin" ] || {
  echo "▶ installing plugin deps (frozen lockfile, scripts disabled)...";
  (cd "${PLUGIN_ROOT}" && BUN install --frozen-lockfile --ignore-scripts); }

# Import smoke: catches peer-resolution/module errors before the TUI does.
echo "▶ import smoke..."
BUN -e "await import('${PLUGIN_ROOT}/index.ts'); await import('${PLUGIN_ROOT}/rpc.ts'); console.log('  imports ok')"
if [ "${COMPOSER:-}" = "doctor" ]; then echo "✓ doctor done"; exit 0; fi

# --- quiet, isolated environment --------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opencode-quota-standalone.XXXXXX")"
CONFIG_DIR="${WORK}/config/oconf"; CONFIG_ROOT="${WORK}/config"
PLUGIN_DIR="${WORK}/snapshot"
DATA_DIR="${WORK}/data"; SCRATCH="${WORK}/scratch"
mkdir -p "${CONFIG_ROOT}/opencode/plugins" "${WORK}/cache" "${DATA_DIR}" "${SCRATCH}"

# Quiet snapshot copy of the plugin (gitignored + churn-free).
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude ".git" --exclude ".superpowers" --exclude ".DS_Store" \
    "${PLUGIN_ROOT}/" "${PLUGIN_DIR}/"
else
  cp -R "${PLUGIN_ROOT}" "${PLUGIN_DIR}"
fi
ln -s "${PLUGIN_DIR}" "${CONFIG_ROOT}/opencode/plugins/opencode-providers-usage"

COMPANION="${1:-on}"   # "on" (default) → enabled; anything else → disabled
if [ "${COMPANION}" = "on" ]; then
  cat > "${CONFIG_ROOT}/opencode/opencode.jsonc" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file://${PLUGIN_DIR}", "options": { "codexCompanion": { "enabled": true } } }
  ]
}
JSON
  echo "▶ companion: ENABLED (reads ${CODEX_HOME:-~/.codex} read-only)"
else
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n}\n' \
    > "${CONFIG_ROOT}/opencode/opencode.jsonc"
  echo "▶ companion: disabled (OpenAI row shows the opt-in explanation)"
fi
echo "▶ isolated config root: ${CONFIG_ROOT}"

# --- launch ------------------------------------------------------------------
# Remove OPENCODE_PRINT_LOGS for a clean screen; add it plus
# OPENCODE_LOG_LEVEL=debug to watch plugin loads/errors live.
XDG_CACHE_HOME="${WORK}/cache" \
XDG_CONFIG_HOME="${CONFIG_ROOT}" \
exec opencode --standalone "${SCRATCH}"

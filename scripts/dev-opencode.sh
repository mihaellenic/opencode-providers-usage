#!/usr/bin/env bash
# dev-opencode.sh — compatibility entrypoint for scripts/dev-open.sh.
#
#   scripts/dev-opencode.sh            same as scripts/dev-open.sh
#   scripts/dev-opencode.sh no         same as scripts/dev-open.sh no
#   scripts/dev-opencode.sh --doctor   same as COMPOSER=doctor scripts/dev-open.sh
#
# Arguments are forwarded unchanged to dev-open.sh. --doctor is consumed here
# and selects the existing COMPOSER=doctor path in that script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/dev-open.sh"

[ -f "${TARGET}" ] || { echo "✗ missing ${TARGET}" >&2; exit 1; }

args=()
doctor=false
for arg in "$@"; do
  case "${arg}" in
    --doctor) doctor=true ;;
    *) args+=("${arg}") ;;
  esac
done

if [ "${doctor}" = true ]; then
  export COMPOSER=doctor
fi

if [ "${#args[@]}" -eq 0 ]; then
  exec "${TARGET}"
fi
exec "${TARGET}" "${args[@]}"

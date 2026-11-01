#!/bin/sh
# Shared commit subject gate: exit 0 when the subject is acceptable to
# Release Please, otherwise print guidance to stderr and exit 1.
set -u

allowlist='^(feat|fix|perf|revert|docs|test|build|ci|chore|refactor|style)(\([^()]+\))?!?: .+'
subject=${1-}
# Optional second argument: full commit id. It lets a custom
# "Merge <x> into <y>" subject pass only when git confirms that exact commit
# has this exact subject and more than one parent.
commit=${2-}
extra=${3-}

reject() {
  printf 'commit subject rejected: %s\n' "${subject:-<empty>}" >&2
  cat >&2 <<'EOF'
Allowed commit subjects:
  <type>[(<scope>)][!]: <description>
    <type> is one of: feat, fix, perf, revert, docs, test, build, ci, chore, refactor, style
    <scope> is optional and cannot contain parentheses
    ! marks a breaking change; a space and a non-empty description are required
  Merge branch ..., Merge pull request ..., Merge remote-tracking ..., Revert "...

Examples: feat: add provider filtering
          fix(chart)!: handle empty history
EOF
  exit 1
}

if [ -z "$subject" ] || [ -n "$extra" ]; then
  reject
fi

# Verified custom merge: strict id shape first so nothing option-like or
# revision-expression-like ever reaches git.
verified_custom_merge() {
  printf '%s\n' "$subject" | grep -Eq '^Merge [^ ]+ into [^ ]+$' || return 1
  case "$commit" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#commit}" -eq 40 ] || [ "${#commit}" -eq 64 ] || return 1
  resolved=$(git rev-parse --verify --quiet --end-of-options "$commit^{commit}" 2>/dev/null) || return 1
  [ "$resolved" = "$commit" ] || return 1
  actual=$(git log -n 1 --format=%s "$commit" -- 2>/dev/null) || return 1
  [ "$actual" = "$subject" ] || return 1
  line=$(git rev-list --parents -n 1 "$commit" -- 2>/dev/null) || return 1
  case "$line" in
    "$commit "*" "*) return 0 ;;
  esac
  return 1
}

case "$subject" in
  'Merge branch '* | 'Merge pull request '* | 'Merge remote-tracking '* | 'Revert "'*)
    exit 0
    ;;
esac

if printf '%s\n' "$subject" | grep -Eq "$allowlist"; then
  exit 0
fi

if [ -n "$commit" ] && verified_custom_merge; then
  exit 0
fi

reject

#!/usr/bin/env bash
# Run the project's test suite. Default: full suite (backward compatible).
# --changed[=<base>]: scope to packages/files touched since <base> (default: merge-base with
#   main/origin main, falling back to HEAD~1) — SP3/F14 per-slice fast path (T0-T2 verify).
#   Full, unscoped run is reserved for milestone/pre-push (T3) — see .claude/commands/loop.md.
#
# Escape hatch (F24, SP6): an optional, project-authored executable at
# .claude/scripts/test-cmd is the documented way to register a custom test runner for a
# stack this script doesn't recognize. Its mere presence counts as a "matched" stack — see
# references/blueprint.md for how to use it.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || { echo "cannot resolve project root" >&2; exit 1; }
set -uo pipefail
s=0
mode="full"
base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --changed) mode="changed"; shift ;;
    --changed=*) mode="changed"; base="${1#--changed=}"; shift ;;
    --base) base="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

changed_files=""
if [ "$mode" = "changed" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    if [ -z "$base" ]; then
      base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo "")"
    fi
    changed_files="$(
      { [ -n "$base" ] && git diff --name-only "$base" -- . 2>/dev/null
        git diff --name-only --cached -- . 2>/dev/null
        git diff --name-only -- . 2>/dev/null
      } | sort -u | sed '/^$/d'
    )"
  fi
  if [ -z "$changed_files" ]; then
    echo "run-tests.sh --changed: no changed files detected against base, nothing to test"
    echo "tests: PASS"
    exit 0
  fi
fi

if [ "$mode" = "changed" ]; then
  ran=0
  if [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1 \
     && printf '%s\n' "$changed_files" | grep -qE '\.rs$|Cargo\.toml$'; then
    echo "==> cargo test (changed)"; cargo test --all || s=1; ran=1
  fi
  if [ -f go.mod ] && command -v go >/dev/null 2>&1 \
     && printf '%s\n' "$changed_files" | grep -q '\.go$'; then
    pkgs="$(printf '%s\n' "$changed_files" | grep '\.go$' | xargs -r -n1 dirname 2>/dev/null | sort -u | sed 's#^#./#')"
    if [ -n "$pkgs" ]; then
      echo "==> go test (changed packages)"; go test $pkgs || s=1; ran=1
    fi
  fi
  if [ -f package.json ] && command -v npm >/dev/null 2>&1 \
     && printf '%s\n' "$changed_files" | grep -qE '\.(m|c)?[jt]sx?$'; then
    echo "==> npm test (changed)"; npm test --silent || s=1; ran=1
  fi
  if { [ -f pyproject.toml ] || [ -f setup.py ] || [ -f pytest.ini ] || [ -d tests ]; } \
     && command -v pytest >/dev/null 2>&1 \
     && printf '%s\n' "$changed_files" | grep -qE '\.py$'; then
    echo "==> pytest (changed)"; pytest || s=1; ran=1
  fi
  if [ "$ran" -eq 0 ] && [ -x .claude/scripts/test-cmd ]; then
    echo "==> .claude/scripts/test-cmd (changed)"; .claude/scripts/test-cmd || s=1; ran=1
  fi
  [ "$ran" -eq 0 ] && echo "run-tests.sh --changed: no changed files map to a known test toolchain, nothing to test"
else
  matched=""
  [ -f Cargo.toml ]   && command -v cargo >/dev/null 2>&1 && { echo "==> cargo test"; cargo test --all || s=1; matched=1; }
  [ -f go.mod ]       && command -v go    >/dev/null 2>&1 && { echo "==> go test";    go test ./...   || s=1; matched=1; }
  [ -f package.json ] && command -v npm   >/dev/null 2>&1 && { echo "==> npm test";   npm test --silent || s=1; matched=1; }
  # Python (F6): pyproject.toml/setup.py/pytest.ini/tests/ + pytest available.
  { [ -f pyproject.toml ] || [ -f setup.py ] || [ -f pytest.ini ] || [ -d tests ]; } \
    && command -v pytest >/dev/null 2>&1 && { echo "==> pytest"; pytest || s=1; matched=1; }
  # Escape hatch (F24): a project-registered override always counts as matched.
  [ -x .claude/scripts/test-cmd ] && { echo "==> .claude/scripts/test-cmd"; .claude/scripts/test-cmd || s=1; matched=1; }
  [ -z "$matched" ] && { echo "tests: FAIL — no recognized stack (cargo/go/npm/pytest) and no .claude/scripts/test-cmd override; nothing was tested"; s=1; }
fi
[ "$s" -eq 0 ] && echo "tests: PASS" || echo "tests: FAIL"
exit $s

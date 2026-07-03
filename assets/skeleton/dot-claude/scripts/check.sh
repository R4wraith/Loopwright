#!/usr/bin/env bash
# Lint + dependency audit + secret sweep. Default: full (backward compatible) — run at
# milestone/pre-push (T3). --fast: skip network dependency audits and semgrep entirely,
# and skip a language's lint pass if no changed file touches that language — SP3/F14
# per-slice fast path (T0-T2 verify). Secret sweep always runs (cheap, local, never skipped).
#
# --fast's changed-file set is computed the SAME way as run-tests.sh --changed: diff against
# `git merge-base HEAD origin/main`/`main` (falling back to HEAD~1), UNIONED with the working
# tree/index diff — so a slice that's already been COMMITTED (clean working tree) still gets
# linted, not silently skipped (a merge-base-only diff misses committed-but-unpushed changes
# would also be wrong for a lint gate; the fallback keeps a base-less repo/no-commit-yet case
# still resolving to the working-tree diff rather than an empty set).
# --print-changed: debug — print the computed changed-file set (one per line) and exit,
# without running any lint/audit. Works with or without --fast.
#
# Hard-fail on unrecognized stack (F6/F24, SP6): in the default full run, if no known stack
# (cargo/go/npm/python) is detected and no .claude/scripts/test-cmd escape hatch is registered,
# exit non-zero rather than silently print "check: PASS" having checked nothing. --fast stays
# scoped-only (its whole point is to skip work outside the touched slice) and does not hard-fail
# on "nothing in this diff maps to a toolchain" — see run-tests.sh's header for the same escape
# hatch documented once.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || { echo "cannot resolve project root" >&2; exit 1; }
set -uo pipefail
mode="full"
print_changed=0
for a in "$@"; do
  case "$a" in
    --fast) mode="fast" ;;
    --print-changed) print_changed=1 ;;
  esac
done
s=0; run(){ echo "--> $*"; "$@" || s=1; }

changed_files=""
if [ "$mode" = "fast" ] && command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo "")"
  changed_files="$(
    { [ -n "$base" ] && git diff --name-only "$base" -- . 2>/dev/null
      git diff --name-only --cached -- . 2>/dev/null
      git diff --name-only -- . 2>/dev/null
    } | sort -u | sed '/^$/d'
  )"
fi
if [ "$print_changed" -eq 1 ]; then
  printf '%s\n' "$changed_files" | sed '/^$/d'
  exit 0
fi
touched(){ [ "$mode" = "full" ] || printf '%s\n' "$changed_files" | grep -qE "$1"; }

matched=""
if [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1; then
  matched=1
  if touched '\.rs$|Cargo\.toml$'; then
    run cargo fmt --all -- --check
    run cargo clippy --all-targets --all-features -- -D warnings
  fi
  if [ "$mode" = "full" ]; then
    command -v cargo-audit >/dev/null 2>&1 && run cargo audit || echo "    (cargo-audit not installed)"
  fi
fi
if [ -f go.mod ] && command -v go >/dev/null 2>&1; then
  matched=1
  touched '\.go$' && run go vet ./...
fi
if [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  matched=1
  if [ "$mode" = "full" ]; then
    run npm audit --audit-level=high
  fi
fi
# Python (F6/SP6): pyproject.toml/setup.py/pytest.ini/tests/ counts as a recognized stack;
# lint with ruff when available (cheap, no network).
if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f pytest.ini ] || [ -d tests ]; then
  matched=1
  if command -v ruff >/dev/null 2>&1 && touched '\.py$'; then
    run ruff check .
  fi
fi
# Escape hatch (F24): a project-registered override always counts as matched.
[ -x .claude/scripts/test-cmd ] && matched=1
if [ "$mode" = "full" ]; then
  if command -v semgrep >/dev/null 2>&1; then
    if [ -f .claude/semgrep.yml ]; then
      run semgrep --error --config .claude/semgrep.yml .
    else
      echo "    (skipping semgrep: .claude/semgrep.yml not found — see references/agent-roster.md)"
    fi
  else
    echo "    (semgrep not installed — SAST skipped)"
  fi
fi
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  git grep -nIE -f .claude/hooks/secret-patterns.txt -- . >/dev/null 2>&1 && { echo "FAIL: secret-shaped string in tracked files"; s=1; }
fi
if [ "$mode" = "full" ] && [ -z "$matched" ]; then
  echo "check: FAIL — no recognized stack (cargo/go/npm/python) and no .claude/scripts/test-cmd override; nothing was checked beyond the secret sweep"
  s=1
fi
[ "$s" -eq 0 ] && echo "check: PASS" || echo "check: FAIL"
exit $s

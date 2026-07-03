#!/usr/bin/env bash
# Milestone gate: fail if any blocker/high finding is unresolved.
# Resolved = status in {verified, closed, accepted}. (SP1.5 ships a cross-platform variant.)
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || { echo "cannot resolve project root" >&2; exit 1; }
set -uo pipefail
F="${1:-.claude/FINDINGS.md}"
[ -f "$F" ] || { echo "gate: no FINDINGS.md at $F"; exit 0; }
open="$(grep -E '^\|[[:space:]]*F[0-9]+[[:space:]]*\|' "$F" | awk -F'|' '
  { sev=$3; st=$5; gsub(/[[:space:]]/,"",sev); gsub(/[[:space:]]/,"",st);
    if ((sev=="blocker"||sev=="high") && st!="verified" && st!="closed" && st!="accepted") print }')"
if [ -n "$open" ]; then
  echo "gate FAIL: unresolved blocker/high findings:" >&2
  echo "$open" >&2
  exit 1
fi
echo "gate PASS: no unresolved blocker/high findings"
exit 0

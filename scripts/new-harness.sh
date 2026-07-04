#!/usr/bin/env bash
# Copy the harness skeleton into a target project's .claude/ folder.
# Usage: bash scripts/new-harness.sh <target-project-dir> [--backup|--force]
#
# What gets copied: the WHOLE skeleton tree under assets/skeleton/dot-claude — a recursive
# copy, so it always tracks the real skeleton (no hard-coded file list to drift out of sync).
# For Harness-Version 3.0 that is, in one shot:
#   WORKFLOW.md (the verbatim run→shift→iteration→slice mechanism) + the memory docs
#   (CLAUDE.md/DESIGN.md/GOAL.md/STATE.md/PROGRESS.md/DECISIONS.md/FINDINGS.md/LEARNINGS.md/
#    CODEMAP.md/PERF.md/TASKS.md/README.md), agents/, commands/,
#   hooks/ (guard · secret-scan · budget-stop · journal-integrity · loop-state · workflow-state ·
#    subagent-context · tasks · ledger, + loop-config.json + secret-patterns.txt),
#   manifests/ (per-subagent context read-lists), ledger/ (events.jsonl + archive/),
#   scripts/, githooks/, semgrep.yml, settings.json, .gitignore, .gitattributes.
#
# Idempotency (F7, SP6):
#   default    refuse to overwrite a non-empty existing <target>/.claude/ — exit 1, no data lost.
#   --backup   move the existing <target>/.claude/ aside to <target>/.claude.bak-<UTC ts>/ first,
#              then copy the skeleton in fresh. Non-destructive.
#   --force    overwrite <target>/.claude/ in place (today's pre-SP6 behavior). Destructive,
#              opt-in only; prints a one-line warning before it acts.
# An empty or absent <target>/.claude/ always just gets the skeleton copied in, no flag needed.
set -euo pipefail
# Skeleton source resolution (SP-pkg, plugin-cache coupling):
# When Loopwright runs as an installed Claude Code plugin, Claude Code substitutes
# ${CLAUDE_PLUGIN_ROOT} into command invocations to point at the plugin's own copy inside the
# versioned plugin cache (~/.claude/plugins/cache/...), not at whatever directory this script
# happens to be checked out in. Prefer that when set. Otherwise fall back to the pre-plugin
# relative-path resolution (dev/sandbox checkout, `--plugin-dir`, or the legacy
# ~/.claude/skills/loopwright manual-install path) — same behavior as before this SP.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  here="$CLAUDE_PLUGIN_ROOT"
else
  here="$(cd "$(dirname "$0")/.." && pwd)"        # skill root — resolved via $0, not cwd
fi
src="$here/assets/skeleton/dot-claude"

target=""
mode="default"
for a in "$@"; do
  case "$a" in
    --backup) mode="backup" ;;
    --force)  mode="force" ;;
    -*) echo "unknown flag: $a" >&2; exit 1 ;;
    *) target="$a" ;;
  esac
done
target="${target:?usage: new-harness.sh <target-project-dir> [--backup|--force]}"

# Resolve target to an absolute path up front (cwd-safety, SP6/F27): everything below operates
# on an absolute path so behavior doesn't depend on the caller's cwd once we start moving/copying.
mkdir -p "$target"
target="$(cd "$target" && pwd)"

dest="$target/.claude"
non_empty() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

if non_empty "$dest"; then
  case "$mode" in
    default)
      echo "refusing to overwrite non-empty $dest" >&2
      echo "existing entries:" >&2
      ls -A "$dest" | sed 's/^/  - /' >&2
      echo "re-run with --backup (move the existing folder aside first) or --force (overwrite in place)." >&2
      exit 1
      ;;
    backup)
      bak="${dest}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
      echo "backing up existing $dest -> $bak"
      mv "$dest" "$bak"
      ;;
    force)
      echo "WARNING: --force overwriting $dest in place — existing filled-in content will be clobbered."
      ;;
  esac
fi

mkdir -p "$dest"
cp -r "$src/." "$dest/"
# hooks are Node (.mjs, invoked via `node`); scripts + githooks run directly and need the bit.
chmod +x "$dest/scripts/"*.sh "$dest/githooks/"* "$dest/hooks/"*.mjs 2>/dev/null || true
echo "Skeleton copied to $dest/"
echo "Next: fill the {{PLACEHOLDERS}} in CLAUDE.md, DESIGN.md, GOAL.md, STATE.md, PROGRESS.md, DECISIONS.md, TASKS.md, README.md,"
echo "and generate one agents/<name>.md (+ manifests/<name>.jsonl) per component-owner (see the skill's references/agent-roster.md)."
echo "Leave verbatim: WORKFLOW.md, settings.json, hooks/, scripts/, githooks/, manifests/ seeds, ledger/, and the spine agents."
echo "Check nothing was missed:  grep -rn '{{' \"$dest\""

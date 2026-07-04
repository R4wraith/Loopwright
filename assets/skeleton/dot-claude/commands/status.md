---
description: Print an honest project status.
allowed-tools: Read, Bash(node .claude/hooks/loop-state.mjs:*), Bash(git log:*), Bash(git status:*)
---
Report where the run stands — read-only, edit nothing.

1. Run `node .claude/hooks/loop-state.mjs --status` — the machine truth: run id + totals (shifts/iterations/active-seconds) and run-ceiling headroom, the open shift (operator, mode, iteration/budget), the milestone gate + any approval token, the active task from the board, the latest HANDOFF stamp, and doctor counters (orphan temp files, unparseable ledger lines).
2. Read `.claude/STATE.md` (current focus + milestone) and `.claude/TASKS.md` (the board), then give the honest line for the active task: works / stubbed / next.
3. List open blockers: any `blocker`/`high` rows in `.claude/FINDINGS.md`, plus any `blocked` task.
4. Show the last 5 commits: !`git log --oneline -5`.

If `--status` reports a thin (auto-checkpoint / crash-backfill) HANDOFF, orphan temp files, or unparseable ledger lines, suggest `node .claude/hooks/loop-state.mjs --doctor` (add `--repair` to complete forward-safe fixes). Don't edit anything.

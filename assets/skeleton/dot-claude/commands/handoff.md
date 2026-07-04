---
description: Wind the shift down — author HANDOFF.md, record it, and end the shift cleanly.
argument-hint: "(optional: end reason — manual | budget_iterations | budget_time | run_budget | milestone_gate)"
allowed-tools: Read, Write, Edit, Bash(node .claude/hooks/loop-state.mjs:*), Bash(git log:*), Bash(git status:*), Bash(git diff:*)
---
Close the current shift with the one HANDOFF it owes. This is the wind-down the `winddown` and `gate_pending` workflow-states require, and the `end-of-shift` routine's last step.

1. **Land or park the current slice first.** Don't leave uncommitted work unrecorded: either finish the slice through commit, or stash it and write the exact next step into the active task's next-step cell (`node .claude/hooks/loop-state.mjs --task T# --to <status> --next "…"`). Stop opening new work.
2. **Author `.claude/HANDOFF.md` in full**, following the template inside that file. It is the incoming operator's first read, so make it load-bearing — cover:
   - Header + stamp line exactly: `# HANDOFF — shift s-NNN` and `_Written: <ISO> · operator: <name> · kind: authored · shift-open: no_` (the `authored` stamp is what protects your handoff from being clobbered by a mechanical checkpoint).
   - **What shipped** (commit shas + one-line subjects — cross-check `git log`), **In flight — exact next step** (the active `TASKS.md` row + its next-step cell + any uncommitted state), **Open findings** (`blocker`/`high` `F#` rows), **Budget** (from `--status`), **Warnings/gotchas**, and **Next-shift orders** (what to pick up first).
3. **Record it:** `node .claude/hooks/loop-state.mjs --record-handoff --kind authored` (appends `handoff_written`; requires the file to exist).
4. **End the shift:** `node .claude/hooks/loop-state.mjs --end-shift --reason <reason>` — use `$ARGUMENTS` if it names one, else `manual`. Valid reasons: `manual`, `budget_iterations`, `budget_time`, `run_budget`, `milestone_gate`. (`crash`/`auto_stale` are written only by `--start-shift` when it reaps an abandoned shift — never pass them here.)
5. **Then STOP.** Re-arming is a NEW shift (`/shift start` or the next session-boot) — never re-arm yourself. If the run's GOAL success criteria are all met instead, record the run done: `node .claude/hooks/loop-state.mjs --complete-run`.

For a mid-shift checkpoint that keeps the shift OPEN (not a wind-down), use `node .claude/hooks/loop-state.mjs --record-handoff --kind auto-checkpoint` instead — it writes a mechanical skeleton and does not end the shift.

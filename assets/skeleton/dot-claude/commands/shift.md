---
description: Shift lifecycle — start a shift (one operator, one budget envelope) or wind one down.
argument-hint: "start <operator> | end [reason] | status"
allowed-tools: Read, Bash(node .claude/hooks/loop-state.mjs:*)
---
A **shift** is one operator, one budget envelope, opened before any work and closed by exactly one HANDOFF. It survives `/clear`, compaction, and resume. Route on `$ARGUMENTS`:

## `start <operator>` — open a shift
1. Run `node .claude/hooks/loop-state.mjs --start-shift --operator <operator>`. Optional flags: `--mode <interactive|auto>`, and a per-shift budget override `--budget-iters <N>` and/or `--budget-sec <S>` (these beat `loop-config.json` for this shift only).
2. If it refuses with **"run budget exhausted"**, the run-level ceiling is spent — a human must extend it (`node .claude/hooks/loop-state.mjs --extend-budget run.<key>=<value> --operator <name>`) or record the run done (`--complete-run`). Don't route around the refusal.
3. If it reports it closed a prior open shift (`crash`/`auto_stale`), a mechanical crash-backfill HANDOFF was written for the abandoned shift — read `.claude/HANDOFF.md` before building.
4. Then orient: read `.claude/HANDOFF.md` FIRST, then GOAL/STATE/TASKS, and pick up per the incoming handoff's Next-shift orders. Continue into `/loop`.

> Session-boot auto-starts a shift if none is open, so `/shift start` is mainly for naming a new operator or setting a tighter budget — you rarely need it by hand.

## `end [reason]` — wind the shift down
Winding down is the `/handoff` flow: author `HANDOFF.md` in full, then `--record-handoff --kind authored`, then `--end-shift --reason <reason>`. Run `/handoff` (pass the reason through). Valid `--end-shift` reasons: `manual` (default), `budget_iterations`, `budget_time`, `run_budget`, `milestone_gate`. After `--end-shift`, STOP — re-arming is a NEW shift (`/shift start` or the next session-boot), never self-re-armed.

## `status` (or no argument) — show the shift history
Run `node .claude/hooks/loop-state.mjs --shifts` (per-shift history: operator · mode · started→ended · iterations · active-seconds · end reason · last commit) and `node .claude/hooks/loop-state.mjs --status` for the live shift + budget headroom.

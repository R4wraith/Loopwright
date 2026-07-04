---
description: Run a named routine — a saved sequence of steps from loop-config.json's routines menu.
argument-hint: "(a routine name, e.g. end-of-shift | morning-orient | nightly | full-check)"
allowed-tools: Read, Bash, Grep, Glob, Task
---
A **routine** is a human-curated macro: a named list of steps in `.claude/hooks/loop-config.json`'s `routines` object. It is a menu only — **no hook reads it**, so a typo here can never break enforcement (the deterministic seams — handoff-on-winddown, the Stop budget backstop, the milestone gate — are hooks, not routines).

1. Read the `routines` object in `.claude/hooks/loop-config.json`. If `$ARGUMENTS` is empty or names no routine, list the available routine names with their `steps` and `note`, then stop.
2. For the named routine, execute its `steps` **in order**. A step may be a slash command (e.g. `/dream`, `/handoff`, `/loop continue`), a shell line (e.g. `bash .claude/scripts/run-tests.sh`), or a plain instruction (e.g. "Read .claude/HANDOFF.md in full"). Run each as written; stop early only on a genuine blocker or an irreversible action.
3. When the steps complete, log the run: `node .claude/hooks/loop-state.mjs --log-routine <name>` (appends a `routine_run` event to the ledger — the audit trail that this routine ran).

The shipped menu: `end-of-shift` (`/dream` → `/handoff`), `morning-orient` (read HANDOFF → `/status`), `nightly` (`/loop continue` → `/handoff`, budget-bounded), `full-check` (run-tests + check + check-gate). Edit `loop-config.json` to add your own.

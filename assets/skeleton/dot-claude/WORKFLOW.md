# WORKFLOW — run → shift → iteration → task

`Harness-Version: 3.0` — verbatim mechanism file (upgrade-refreshable; do not tailor).
`hooks/workflow-state.mjs` parses the `[workflow-state:*]` blocks below and injects the
one matching your current status EVERY turn, with a header carrying the exact-resume
pointer. Edit block bodies to tune behavior — keep each ≤8 lines. There is NO fallback
dict in code: a deleted or renamed block degrades visibly, never silently.

## Phase Index

Hierarchy: run ⊃ shifts ⊃ sessions ⊃ iterations ⊃ slices · milestones ⊃ tasks (work axis).

Run
1. `/start` → `node .claude/hooks/loop-state.mjs --init` — run_started + shift s-001. [required·once per run] (enforced: no_task)
2. GOAL.md success criteria met → `--complete-run` ends the run. [required·once per run] (enforced: done)

Shift — one operator, one budget envelope, ends with one HANDOFF; survives /clear, compaction, resume.
3. A shift is open before any work — `/shift start <operator>`, or session-boot auto-starts one. [required·once per shift] (enforced: no_task)
4. Wind down: author HANDOFF.md → `--record-handoff --kind authored` → `--end-shift --reason <r>`. [required·once per shift] (enforced: winddown)

Iteration — one /loop pass, counted by the Stop hook.
5. Orient — read HANDOFF.md FIRST, then GOAL/STATE/TASKS (+ CODEMAP at need). [repeatable]
6. Pick — claim the task before editing code: `--task T# --to in_progress --next "…"`. [required·once per task] (enforced: no_task)
7. Build — dispatch specialists; update the next-step cell before every dispatch. [required·once per dispatch] (enforced: in_progress)
8. Verify — run the tier (T0–T3), `git add -A`, stamp `--set-verified-tree`. [required·once per slice] (enforced: verifying)
9. Commit — staged-tree check, then a small Conventional Commit. [required·once per slice] (enforced: committing)
10. Record — PROGRESS/STATE/TASKS updated; commit the journal set incl. the ledger. [required·once per slice] (enforced: done)
11. Stop — budget-stop meters budgets + the milestone gate; obey its blocks. [repeatable]

Milestone
12. Boundary: tick STATE.md `## Milestones`, post the review, wait for approval. [required·once per milestone] (enforced: gate_pending)

Statuses: task statuses from `tasks.mjs STATUSES` (queued, planning, in_progress,
verifying, committing, done, blocked, dropped) + pseudo-statuses computed from
loop.json (winddown, gate_pending, no_task — they outrank task statuses).

## Status blocks

[workflow-state:queued]
This task is queued — no work has started on it.
1. Read the next-step cell and the DESIGN.md build-order context for this task.
2. MUST claim it before touching code: `node .claude/hooks/loop-state.mjs --task T# --to in_progress --next "<first concrete step>"` (or `--to planning` if it needs decomposition first).
3. Keep the slice small: 1–5 iterations, one checkable outcome.
[/workflow-state:queued]

[workflow-state:planning]
You are decomposing this task — no code edits in this status.
1. Write the slice plan where it lives (DESIGN.md notes or the dispatch prompt), one checkable success criterion per slice.
2. MUST move to build before editing code: `node .claude/hooks/loop-state.mjs --task T# --to in_progress --next "<first slice>"`.
3. Hit a real fork or a trust-boundary guess? `--to blocked` and record the D#/F# instead.
[/workflow-state:planning]

[workflow-state:in_progress]
Build the current slice; the injected `Active task:` header is the scope contract.
1. MUST keep the next-step cell execution-precise before every subagent dispatch — it is the crash-resume pointer (every `--task T# --to <status> --next "…"` transition refreshes it).
2. Dispatch specialists per /loop; run independent scopes in parallel, serialize anything sharing files.
3. Slice built? `node .claude/hooks/loop-state.mjs --task T# --to verifying --next "run the verify tier"`.
[/workflow-state:in_progress]

[workflow-state:verifying]
Verify the slice before anything is committed — never weaken a test to go green.
1. Run the tier the slice classifies to (T0–T3 per /loop); loop on failures until green.
2. On green: `git add -A`, then MUST stamp the staged tree: `node .claude/hooks/loop-state.mjs --set-verified-tree --task T# --tier T<n>` (appends slice_verified).
3. Then `node .claude/hooks/loop-state.mjs --task T# --to committing --next "commit staged slice — verify already passed"`.
[/workflow-state:verifying]

[workflow-state:committing]
Commit the verified slice — verify already passed, do not rebuild it.
1. MUST check the stamp first: `git write-tree` must equal the recorded verified tree (loop.json `verified_tree_sha` / ledger last slice_verified). Match → commit directly; mismatch → the tree changed since verify — re-run verify first.
2. Commit small (Conventional Commits); journal-integrity records slice_committed.
3. Then `node .claude/hooks/loop-state.mjs --task T# --to done`.
[/workflow-state:committing]

[workflow-state:done]
This task is done — do not idle here; route forward now.
1. MUST record it: PROGRESS.md line, STATE.md update, commit the journal set (incl. TASKS.md + the ledger).
2. Milestone boundary? Tick STATE.md `## Milestones`, archive done rows, run the milestone gate (post the review, wait for approval). GOAL.md criteria met? → `--complete-run`.
3. Otherwise pick the next task per DESIGN build order: `node .claude/hooks/loop-state.mjs --task T# --to in_progress --next "…"`.
[/workflow-state:done]

[workflow-state:blocked]
This task is blocked — surface the blocker, don't spin on it.
1. Record it durably: a FINDINGS.md F# row (or DECISIONS.md D# if it is a fork) naming exactly what unblocks it.
2. Put the unblock condition in the next-step cell.
3. Move on: claim another task (`--task T# --to in_progress`), or if nothing is workable run the wind-down (/handoff).
[/workflow-state:blocked]

[workflow-state:dropped]
This task was dropped — rows are history, never deleted.
1. Ensure the why is recorded (one DECISIONS.md D# line) if it isn't already.
2. Pick the next task per DESIGN build order — the no_task routing applies.
[/workflow-state:dropped]

[workflow-state:winddown]
Budget wind-down is posted — close the shift NOW, cleanly.
1. Stop opening new work; land or safely park the current slice (commit, or stash + a next-step note).
2. MUST author HANDOFF.md in full (template inside it), then: `node .claude/hooks/loop-state.mjs --record-handoff --kind authored` and `--end-shift --reason <budget_iterations|budget_time|run_budget|manual>`.
3. Then STOP. Re-arm is a NEW shift (--start-shift or the next session-boot) — never re-arm yourself.
[/workflow-state:winddown]

[workflow-state:gate_pending]
Milestone gate is pending — building is hard-paused until a human steers.
1. MUST post the milestone review durably: what shipped, key decisions, next-milestone plan (STATE.md `## Milestone digests`).
2. A human approves with `node .claude/hooks/loop-state.mjs --approve --operator <name>` (token expires per config; consumed at the next Stop — it never pre-clears a future gate).
3. Headless / no human available: author HANDOFF.md with End reason `milestone_gate`, run `--record-handoff --kind authored` + `--end-shift --reason milestone_gate`, and STOP.
[/workflow-state:gate_pending]

[workflow-state:no_task]
No task is active in this session — never guess another session's task.
1. Candidates (queued/planning/blocked) are listed in the header above; HANDOFF.md's Next-shift orders may name the first one.
2. Pick per DESIGN build order — highest leverage first.
3. MUST claim before editing code: `node .claude/hooks/loop-state.mjs --task T# --to in_progress --next "<first concrete step>"`. No rows left? `--task new --title "…" --milestone M#`.
[/workflow-state:no_task]

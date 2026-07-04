# Tasks
_Statuses: queued → planning → in_progress → verifying → committing → done (+ blocked, dropped)._
_Status cells change ONLY via `node .claude/hooks/loop-state.mjs --task <id> --to <status> [--next "…"]`
(it appends the ledger event first, then rewrites this row). Hand-edits are detected by --doctor, never reverted._
_Columns are POSITIONAL (do not reorder or rename): ID · milestone · title · status · next step · owner · updated.
A row is a pointer + a resume-precise next step — rich per-task detail lives in DESIGN/DECISIONS/dispatch prompts, not here.
The `next step` cell is the crash-resume pointer: keep it execution-precise on the active row before every subagent dispatch.
`workflow-state.mjs` reads this board every turn; `subagent-context.mjs` reads the active row into each dispatch._

| ID | milestone | title | status | next step | owner | updated |
|----|-----------|-------|--------|-----------|-------|---------|
| T1 | M1 | {{KEYSTONE}} (keystone) | queued | claim before coding — loop-state.mjs --task T1 --to in_progress (set the first concrete step here) | — | {{DATE}} |

## Done (archive)
_Rows moved here by the milestone-boundary Record step; never deleted._

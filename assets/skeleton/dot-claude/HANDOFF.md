# HANDOFF

_No shift has ended yet — this is the shipped placeholder. It is UNSTAMPED, so any writer may
overwrite it. Wind-down (WORKFLOW.md `[workflow-state:winddown]`) authors this file in full using the
template below, then runs `node .claude/hooks/loop-state.mjs --record-handoff --kind authored`
followed by `--end-shift --reason <r>`. `--record-handoff` refuses if this file is missing._

> **How this file is used.** One HANDOFF per shift — it is the baton the next operator (human or the
> next session) reads FIRST at orient. Overwrite it each shift. The header + stamp line grammar below
> is parsed by `loop-state.mjs` (`parseHandoffStamp`) — keep it byte-exact when you author. A
> mechanical auto-checkpoint / crash-backfill uses the same section skeleton, so authored and
> mechanical handoffs read identically.

---

## Authoring template (fill in-place, keep the headings)

`# HANDOFF — shift s-NNN`
`_Written: {{ISO8601}} · operator: {{OPERATOR}} · kind: authored · shift-open: no_`
`**Run:** {{RUN_ID}} · **Shift:** s-NNN ({{STARTED_ISO}} → {{ENDED_ISO}}) · **End reason:** {{budget_iterations|budget_time|run_budget|milestone_gate|manual}}`

## What shipped
- {{commit-sha}} — {{one-line subject}}  <!-- one bullet per slice_committed this shift; "(no commits recorded this shift)" if none -->

## In flight — exact next step
**Task:** {{T# (status) — next: <next-step cell>}} <!-- or "(none active)" -->
**Uncommitted:** clean <!-- or a short `git status --porcelain` digest so the next shift knows what is parked -->

## Open findings (blocker/high)
- {{F# — one line}} <!-- from FINDINGS.md; "(none)" if clear -->

## Budget
- Shift: {{iter/max · active-sec/max}}
- Run: {{shifts · iterations · active-sec (run ceilings: …)}}

## Warnings / gotchas
- {{anything the next operator must not relearn the hard way}}

## Next-shift orders
1. Read the In-flight task and resume from its next-step cell.
2. Run `node .claude/hooks/loop-state.mjs --doctor` before new work.
3. {{highest-leverage next task per DESIGN build order — name the T# to claim first}}

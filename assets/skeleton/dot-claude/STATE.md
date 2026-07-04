# STATE

_Updated: {{DATE}} · Milestone: M0 (not started)_
<!-- The per-shift iteration counter + the open shift lease live in `.claude/loop.json` (machine,
git-ignored, disposable — rehydrated from `.claude/ledger/events.jsonl` if lost). STATE tracks the
human-meaningful Milestone number here and does NOT duplicate the iteration count. Run-wide totals
(shifts/iterations) come from the ledger, surfaced in the workflow-state header — not duplicated here. -->

**Now:** run `/start` → `node .claude/hooks/loop-state.mjs --init` — confirm env + language (DECISIONS D2), open shift s-001, then begin.
**Next:** M1 — {{KEYSTONE}} (the keystone). <!-- The single immediate next scope only (subagent-context reads this line + **Now:** into each dispatch). Its ordered lookahead is NOT duplicated here — that lives in DESIGN.md's build order + the `## Milestones` checklist below, and the live board in TASKS.md. The finish line is GOAL.md's `## Success criteria`. -->

**Env:** {{ENV_NOTES}}
**Blockers:** confirm/override language (D2) before keystone codegen.
**Progress cursor:** 0 <!-- PROGRESS.md entry index folded into "Milestone digests" below. Orient reads only PROGRESS entries after this cursor (last k=5, default) plus this file in full — never the whole PROGRESS. Advances only at a milestone boundary. -->
**Last-dream:** none <!-- Watermark for `/dream`'s freshness gate — set to "<commit-sha> · <date>" by `/dream` after each run. "none" means dream has never run. -->

## Milestone digests

_One short paragraph per **closed** milestone, folded from that milestone's PROGRESS.md entries at the
milestone boundary. This is what orient reads instead of re-reading old PROGRESS — keeps orient cost
O(k), not O(n). PROGRESS.md itself stays append-only in full for audit. A headless/gated shift also
posts its milestone review here (what shipped · key design choices · next-milestone plan) when no human
is available to approve. Empty until M1 closes._

## Milestones

One `- [ ]` per milestone, ticked `- [x]` on completion. `budget-stop.mjs` (the `Stop` hook) watches
this section: ticking a box forces `milestone_gate=pending-approval` in `.claude/loop.json` even in
headless/auto mode — post the milestone review (into `## Milestone digests` above) and wait for the
human's go-ahead (`node .claude/hooks/loop-state.mjs --approve --operator <name>`) before starting the
next one. This heading is a hard contract — keep it exactly `## Milestones`.

- [ ] M1 — {{KEYSTONE}} (the keystone)

## Compaction anchor

_Populated automatically by `precompact-anchor.mjs` (the `PreCompact` hook) right before context is
squeezed — scope/intent (**Now:**/**Next:**), open blocker/high findings, last commit. Read back on
resume by `session-orient.mjs` (`SessionStart`, source=compact). Keep this heading exactly
`## Compaction anchor`. Empty until the first compaction._

## Speculative (dream)

_`/dream`'s output — near-term, small-piloted slices proposed by a dream pass, each tagged
`[dream/speculative]`. Candidates only, never pre-committed milestones: the loop proposes-vs-disposes
them at orient (pick, defer, or reject). Larger architectural directions go to `.claude/DESIGN.md`'s
backlog instead. Empty until the first `/dream` run._

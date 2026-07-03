# STATE

_Updated: {{DATE}} · Milestone: M0 (not started)_
<!-- SP7/F3: the per-run iteration counter is `.claude/loop.json`'s `iteration` field (machine,
git-ignored) — the single source of truth for the run counter. STATE tracks the human-meaningful
Milestone number here and does NOT duplicate the iteration count (that duplication is what drifted). -->

**Now:** run `/start` — confirm env + language (DECISIONS D2), then begin.
**Next:** M1 — {{KEYSTONE}} (the keystone). <!-- The single immediate next scope only. Its ordered lookahead is NOT duplicated here — that lives in DESIGN.md's build order + the `## Milestones` checklist below. `Next` is just the one scope you'll pick up next, derived from those (plus any `## Speculative (dream)` candidate the loop chooses to promote). The finish line is GOAL.md's `## Success criteria`. -->

**Env:** {{ENV_NOTES}}
**Blockers:** confirm/override language (D2) before keystone codegen.
**Progress cursor:** 0 <!-- SP3/F13: PROGRESS.md entry index folded into "Milestone digests" below. Orient reads only PROGRESS entries after this cursor (last k=5, default) plus this file in full — never the whole PROGRESS. Advances only at a milestone boundary. -->
**Last-dream:** none <!-- SP5: watermark for `/dream`'s freshness gate — set to "<commit-sha> · <date>" by `/dream`'s Phase 4 after each run. "none" means dream has never run; `/dream` treats that as "no prior watermark" and proceeds. -->

## Milestone digests

_SP3/F13: one short paragraph per **closed** milestone, folded from that milestone's PROGRESS.md
entries at the milestone boundary (a Sonnet-tier compaction pass, not an Opus judgment call).
This is what orient reads instead of re-reading old PROGRESS — keeps orient cost O(k), not O(n).
PROGRESS.md itself stays append-only in full for audit. Empty until M1 closes._

## Milestones

One `- [ ]` per milestone, ticked `- [x]` on completion. SP4's `budget-stop.mjs` (the
`Stop` hook) watches this section: ticking a box forces `milestone_gate=pending-approval`
in `.claude/loop.json` even in headless/auto mode — post the milestone review and wait
for the human's go-ahead (`node .claude/hooks/loop-state.mjs --approve`) before starting
the next one.

- [ ] M1 — {{KEYSTONE}} (the keystone)

## Compaction anchor

_Populated automatically by `precompact-anchor.mjs` (the `PreCompact` hook) right before
context is squeezed — scope/intent, open blocker/high findings, last commit. Read back on
resume by `session-orient.mjs` (`SessionStart`, source=compact). Empty until the first
compaction._

## Speculative (dream)

_SP5: `/dream`'s Phase 3 output — near-term, small-piloted pilot slices proposed by a dream pass,
each tagged `[dream/speculative]`. These are candidates only, never pre-committed milestones: the
loop proposes-vs-disposes them at orient (pick, defer, or reject), same as any other candidate
scope. Larger architectural directions go to `.claude/DESIGN.md`'s backlog instead. Empty until the
first `/dream` run._

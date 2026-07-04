---
description: Bounded reflective pass — retro the shift's failures into durable lessons, then self-set the next SOTA-grade direction as small piloted goals.
argument-hint: "(optional: a focus area for the brainstorm)"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(node .claude/hooks/loop-state.mjs:*)
---
Reasoning: **xhigh/max** — this is the one place we deliberately pay for depth; the loop stays lean. `/dream` is **one pass, five phases (Phases 0-4), no iteration** — a retro-and-ambition pass over the existing ledger, never a self-perpetuating ideation loop. It reuses the git journal (FINDINGS/PROGRESS/LEARNINGS/STATE/DESIGN/DECISIONS) and writes back through the same schemas — no new subsystem, no `DREAMLOG.md`.

## Triggers (when a human or seam runs this)
Three sanctioned triggers — all human- or seam-initiated single shots:
- **End-of-shift** — the natural close of an autonomous shift, before the human steps away (it is the first step of the `end-of-shift` routine, ahead of `/handoff`). Richest input.
- **Milestone boundary** — slots in *before* the milestone review (the `gate_pending` workflow-state), so the "next milestone plan" the loop posts is dream-informed.
- **On-demand** — the human types `/dream` whenever they want a retro + re-aim.
`/dream` is never auto-fired by `/loop` or the Stop hook.

**Relationship to the loop's learnings flush.** A lightweight learnings-flush already runs at every milestone boundary as part of `/loop`'s Record step — it captures at least the milestone's hard lessons so the learning tier never sits empty between dream passes. `/dream`'s Phase 1 retro is deeper (xhigh reasoning, mines the full delta since the last watermark); the two are complementary.

## Phase 0 — Freshness + budget gate
1. Read the `Last-dream:` watermark (in `.claude/STATE.md`'s header). If absent, treat as "no prior dream" and proceed.
2. Compute the delta since that watermark: `git log <last-dream-sha>..HEAD`, any newly `fixed`/`verified`/recurring rows in `.claude/FINDINGS.md`, and any new `stubbed:`/dated lines in `.claude/PROGRESS.md`. **If the delta is empty** (same commit, no new findings activity, no new PROGRESS lines) → report "nothing new to reflect on since <last-dream-sha>" and **exit without doing Phases 1-4**. Dream never fires on stale material.
3. Check the budget envelope: `node .claude/hooks/loop-state.mjs --status` (shift + run ceilings from `.claude/loop.json` / `.claude/hooks/loop-config.json`). **If the shift's iteration/wall-clock budget is already near its ceiling, or the run has no headroom** → defer, say so plainly, and exit. Dream shares the shift budget envelope with `/loop` — no dedicated sub-budget — and caps itself to **one** pass: one retro + one brainstorm + one queue-write (plus, only when Phase 2 explicitly warrants it, one small capped parallel-exploration fan-out).

## Phase 1 — Retro (mine failures → durable lessons)
Inputs: the git delta from Phase 0, `.claude/FINDINGS.md` (what was hard-won, reopened, or recurred), `.claude/PROGRESS.md`'s honest `works/stubbed/next` lines, and existing `.claude/LEARNINGS.md` (to dedupe against). With xhigh reasoning, ask of each failure/friction point: **what is the generalizable rule that would have prevented this class of mistake?** — not "what did we fix." Append each as an `L#` row to `.claude/LEARNINGS.md` in the existing format: `L# · date · the lesson · (provenance: F#/commit)`.

**HONESTY RAIL — provenance or drop.** Every `L#` dream writes must cite real provenance: an existing `F#` finding ID **or** a real commit SHA (not limited to the Phase 0 delta — a recurring issue whose root cause predates the watermark can still cite its `F#`). A lesson with no traceable origin is a fabrication — do not write it.

**Dedupe (qualitative, conservative).** Skip anything already covered by an existing `L#`. Keep a candidate only if it adds a distinct rule.

## Phase 2 — Brainstorm (SOTA ambition)
Inputs: `.claude/GOAL.md` + `.claude/DESIGN.md` (the mission — stay grounded in it), current `.claude/STATE.md`, and the fresh `L#` lessons from Phase 1. Adopt a production-grade, SOTA-ambition lens: *what would the best-in-class version of this project do next?* Invoke the `brainstorming` / `superpowers:brainstorming` discipline to push past the obvious.

**Default depth: a single xhigh reasoning pass.** **Escalate only for a genuinely open, milestone-scale fork** — a decision big enough to reshape the build order or commit real budget — to the full shape: a small **parallel exploration** of 2-3 candidate directions, followed by an **adversarial self-judge** pass that kills the weak ones. Routine brainstorms stay single-pass.

Output: a shortlist of candidate next milestones/features, each with a one-line rationale tied to the mission.

## Phase 3 — Queue (concrete, small-piloted dev calls — never a commitment)
Convert the shortlist into concrete entries the resumed loop can pick up, but **piloted small** — each speculative direction is a **bounded pilot slice** ("prove X with the cheapest adequate spike"), **never a pre-committed full milestone**:
- **Near-term pilots** → append to `.claude/STATE.md`'s `## Speculative (dream)` section, each line tagged `[dream/speculative]`. When ready to become real work, they enter the board as tasks (`node .claude/hooks/loop-state.mjs --task new --title "…" --milestone M#`) — but that promotion is the loop's call at orient, not dream's.
- **Larger architectural directions** → append to `.claude/DESIGN.md`'s backlog, tagged `[dream/speculative]`.
- **Any real decision the brainstorm forces** (a chosen approach with a live alternative) → a `D#` row in `.claude/DECISIONS.md`, per the assumption policy — surfaced in writing, never silently adopted.
The loop, on resume, **proposes-vs-disposes** at orient: it treats every `[dream/speculative]` entry as an ordinary candidate it may pick, defer, or reject. Nothing dream writes jumps the milestone-review gate.

## Phase 4 — Record + close (honesty)
1. Append one dated `dream` entry to `.claude/PROGRESS.md` that **honestly labels its output as reflection, not shipped work** — format: `<date> — dream. reviewed: <what>. lessons: L#, L#.. queued (speculative): <n> pilot(s) in STATE/<n> in DESIGN. next: <one line>.`
2. Update the `Last-dream:` watermark in `.claude/STATE.md`'s header to the current `HEAD` commit SHA + date.

## HONESTY RAILS (non-negotiable, apply across all five phases)
`/dream` is a bounded reflective pass, **not** an ideation loop and not a build step:
- **Never writes a `works:` claim.** Dream did not build or verify anything; it reflected.
- **Never flips a `.claude/FINDINGS.md` status.** Findings are resolved by the loop's fix cycle, not by dream.
- **Never touches product code.** Dream only writes to the ledger (`STATE.md`, `DESIGN.md`, `PROGRESS.md`, `DECISIONS.md`, `LEARNINGS.md`) — zero edits under the project root's source tree, and it never mutates `TASKS.md`/`loop.json`/the ledger.
- **Never pre-commits a milestone.** Every Phase 3 output is `[dream/speculative]` and small-piloted; the loop disposes of it later.
- **Runs once and stops.** One pass through Phases 0-4, then done — no retry loop.

**Mechanical backstop vs. prose rail — be honest about the boundary.** This command's `allowed-tools` removes the free-form-Bash escape hatch: there is no bare `Bash`, only `git log`/`git diff`/`git status`/`loop-state.mjs`. **Residual gap:** Claude Code's `allowed-tools` cannot path-scope `Edit`/`Write` to specific files. So "never touches product code" remains a **prose rail, not a mechanical one**: you must self-enforce writing ONLY those five ledger files. Don't overclaim.

$ARGUMENTS

---
description: Bounded reflective pass — retro the day's failures into durable lessons, then self-set the next SOTA-grade direction as small piloted goals.
argument-hint: "(optional: a focus area for the brainstorm)"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(node .claude/hooks/loop-state.mjs:*)
---
Reasoning: **xhigh/max** — this is the one place we deliberately pay for depth; the loop stays lean. `/dream`
is **one pass, five phases (Phases 0-4), no iteration** — it is a retro-and-ambition pass over the existing
ledger, never a self-perpetuating ideation loop. It reuses SP1's ledger (FINDINGS/PROGRESS/LEARNINGS/STATE/
DESIGN/DECISIONS) and writes back through the same schemas — no new subsystem, no `DREAMLOG.md`.

## Triggers (when a human or seam runs this)
Three sanctioned triggers — all human- or seam-initiated single shots:
- **End-of-shift** — the natural close of an autonomous run, before the human steps away. Richest input.
- **Milestone boundary** — slots in *before* the milestone review (`.claude/STATE.md`'s `## Milestones`
  gate) so the "next milestone plan" the loop posts is dream-informed.
- **On-demand** — the human types `/dream` whenever they want a retro + re-aim.
`/dream` is on-demand only — it is never auto-fired by `/loop` or the SP4 Stop-hook. (A future SP4 hook
could call this same command at a shift seam; that is not wired here.)

**Relationship to the SP7 learnings flush.** A lightweight learnings-flush already auto-runs at every
milestone gate as part of `/loop`'s Record step (see `loop.md`) — it captures at least the milestone's
hard lessons so the learning tier never sits empty between dream passes. `/dream`'s Phase 1 retro is
deeper (xhigh reasoning, mines the full delta since the last watermark) and still runs on-demand at
end-of-shift; the two are complementary, not duplicative — the flush keeps LEARNINGS honest in the
gaps between dream passes.

## Phase 0 — Freshness + budget gate
1. Read the `Last-dream:` watermark (in `.claude/STATE.md`'s header, see below). If absent, treat as
   "no prior dream" and proceed.
2. Compute the delta since that watermark: `git log <last-dream-sha>..HEAD`, any newly `fixed`/`verified`/
   recurring rows in `.claude/FINDINGS.md`, and any new `stubbed:`/dated lines in `.claude/PROGRESS.md`.
   **If the delta is empty** (same commit, no new findings activity, no new PROGRESS lines) → report
   "nothing new to reflect on since <last-dream-sha>" and **exit without doing Phases 1-4**. Dream never
   fires on stale material.
3. Check the SP4 budget envelope: `node .claude/hooks/loop-state.mjs --status` (reads `.claude/loop.json`
   against `.claude/hooks/loop-config.json`'s ceilings). **If the shift's iteration/wall-clock budget is
   already near its ceiling** → defer, say so plainly, and exit. Dream shares the SP4 budget envelope
   with `/loop` — it has no dedicated sub-budget — and additionally caps itself to **one**
   pass: one retro + one brainstorm + one queue-write (plus, only when Phase 2 explicitly warrants it, one
   small capped parallel-exploration fan-out). If budget is fine, proceed.

## Phase 1 — Retro (mine failures → durable lessons)
Inputs: the git delta from Phase 0, `.claude/FINDINGS.md` (what was hard-won, reopened, or recurred),
`.claude/PROGRESS.md`'s honest `works/stubbed/next` lines, and existing `.claude/LEARNINGS.md` (to dedupe
against). With xhigh reasoning, ask of each failure/friction point: **what is the generalizable rule that
would have prevented this class of mistake?** — not "what did we fix." Append each as an `L#` row to
`.claude/LEARNINGS.md` in the existing format: `L# · date · the lesson · (provenance: F#/commit)`.

**HONESTY RAIL — provenance or drop.** Every `L#` dream writes must cite real provenance: an existing `F#`
finding ID **or** a real commit SHA (not limited to the Phase 0 delta — a recurring issue whose root cause
predates the watermark can still cite its `F#`). A lesson with no traceable origin is a fabrication — do
not write it.

**Dedupe (qualitative, conservative).** Skip anything already covered by an existing `L#` — don't repeat
an existing lesson's substance. Keep a candidate only if it adds a distinct rule.

## Phase 2 — Brainstorm (SOTA ambition)
Inputs: `.claude/GOAL.md` + `.claude/DESIGN.md` (the mission — stay grounded in it), current
`.claude/STATE.md`, and the fresh `L#` lessons from Phase 1. Adopt a production-grade, SOTA-ambition lens:
*what would the best-in-class version of this project do next?* Invoke the `brainstorming` /
`superpowers:brainstorming` discipline to push past the obvious.

**Default depth: a single xhigh reasoning pass** (simplest-adequate-primitive). **Escalate only for a
genuinely open, milestone-scale fork** — a decision big enough to reshape the build order or commit real
budget — to the full proactive shape: a small **parallel exploration** of 2-3 candidate directions, followed
by an **adversarial self-judge** pass that kills the weak ones. Routine brainstorms (most runs) stay
single-pass; don't escalate by default.

Output: a shortlist of candidate next milestones/features, each with a one-line rationale tied to the
mission in `.claude/GOAL.md`/`.claude/DESIGN.md`.

## Phase 3 — Queue (concrete, small-piloted dev calls — never a commitment)
Convert the shortlist into concrete entries the resumed loop can pick up, but **piloted small** — each
speculative direction is a **bounded pilot slice** ("prove X with the cheapest adequate spike"), **never a
pre-committed full milestone**:
- **Near-term pilots** → append to `.claude/STATE.md`'s `## Speculative (dream)` section, each line tagged
  `[dream/speculative]`.
- **Larger architectural directions** → append to `.claude/DESIGN.md`'s backlog, tagged `[dream/speculative]`.
- **Any real decision the brainstorm forces** (a chosen approach with a live alternative) → a `D#` row in
  `.claude/DECISIONS.md`, per the assumption policy — surfaced in writing, never silently adopted.
The loop, on resume, **proposes-vs-disposes** at orient: it treats every `[dream/speculative]` entry as an
ordinary candidate scope it may pick, defer, or reject. Nothing dream writes jumps the milestone-review gate,
and nothing here is a milestone until a human or the loop's orient step actually promotes it into
`## Milestones`.

## Phase 4 — Record + close (honesty)
1. Append one dated `dream` entry to `.claude/PROGRESS.md` that **honestly labels its output as reflection,
   not shipped work** — format: `<date> — dream. reviewed: <what>. lessons: L#, L#.. queued (speculative):
   <n> pilot(s) in STATE/<n> in DESIGN. next: <one line>.`
2. Update the `Last-dream:` watermark in `.claude/STATE.md`'s header to the current `HEAD` commit SHA + date.

## HONESTY RAILS (non-negotiable, apply across all five phases)
`/dream` is a bounded reflective pass, **not** an ideation loop and not a build step:
- **Never writes a `works:` claim.** Dream did not build or verify anything; it reflected.
- **Never flips a `.claude/FINDINGS.md` status.** Findings are resolved by the loop's fix cycle, not by dream.
- **Never touches product code.** Dream only writes to the ledger (`STATE.md`, `DESIGN.md`, `PROGRESS.md`,
  `DECISIONS.md`, `LEARNINGS.md`) — zero edits under the project root's source tree.
- **Never pre-commits a milestone.** Every Phase 3 output is `[dream/speculative]` and small-piloted; the
  loop disposes of it later. Dream proposes, the loop decides.
- **Runs once and stops.** One pass through Phases 0-4, then done — no retry loop, no "keep brainstorming."

**Mechanical backstop vs. prose rail — be honest about the boundary.** This command's frontmatter
(`allowed-tools:`) mechanically removes the free-form-Bash escape hatch: there is no bare `Bash`, so
arbitrary shell (e.g. `rm`, editors, package managers) is not reachable, only `git log`/`git diff`/
`git status`/`loop-state.mjs --status`. **Residual gap:** Claude Code's `allowed-tools` cannot path-scope
`Edit`/`Write` to specific files — it can grant or deny the tool, not restrict it to
`LEARNINGS.md`/`STATE.md`/`DESIGN.md`/`PROGRESS.md`/`DECISIONS.md`. So "never touches product code" above
remains a **prose rail, not a mechanical one**: you must self-enforce writing ONLY those five ledger files
and never any file under the project root's source tree. Don't overclaim — the frontmatter closes the
shell escape hatch, it does not close this one.

$ARGUMENTS

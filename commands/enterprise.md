---
description: Enrich an existing idea.md into a comprehensive, enterprise-grade PRD — every milestone and every section, in depth (features · style · system design) — via an ultracode multi-agent questionnaire, then install the answers non-destructively back into idea.md.
argument-hint: "(optional: a single milestone id or section name to focus on; default is the WHOLE idea.md)"
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Task, Workflow, Bash(cp:*), Bash(git:*)
---

# /loopwright:enterprise

This command **deepens an existing `idea.md`** — the foundation contract — from a lean brainstorm draft into a
**comprehensive, enterprise-grade PRD**. It walks the *entire* file: every **milestone** gets enriched with
in-depth **features / style / system design**, and every other **section** gets pressure-tested to the same
depth. It is **additive** — it never rewrites or drops the original; it only enriches. The output is the same
`idea.md`, made enterprise-ready, still handed off to `/loopwright:new` to scaffold.

Where `/loopwright:brainstorm` produces the *smallest idea.md that earns the name* (keystone-first, YAGNI), this
command does the opposite job on demand: it takes that lean draft and expands the parts that will become real
software into a **detailed PRD per feature / module / milestone** — architecture, data contracts, scale, security,
compliance, observability, rollout, cost — so the generated harness builds against a rich spec instead of a sketch.

`$ARGUMENTS`, if given, is a single milestone id (e.g. `M3`) or a section name (e.g. `The keystone`) to focus on;
default is the whole `idea.md`.

## Preconditions

- **`idea.md` must already exist** at the project root. If it doesn't, stop and tell the user to run
  `/loopwright:brainstorm` (or hand-write `idea.md`) first — there is nothing to enrich yet.
- This is an **ultracode** command: it fans out one questionnaire-author agent **per milestone and per section**,
  which is real multi-agent cost. It runs only when the user has opted into multi-agent orchestration.
  - If the session is already in **ultracode** mode (a system reminder confirms it), proceed.
  - Otherwise, tell the user plainly: *"This will spawn ~N agents (one per milestone + one per section of your
    idea.md). Re-run as `ultracode /loopwright:enterprise` or confirm to proceed."* Get an explicit go-ahead
    (or the `ultracode` keyword) **before** launching the Workflow. Never fan out silently.

## The non-destructive contract (read before touching idea.md)

Enrichment must not harm the original. Enforce all four:

1. **Snapshot first.** Before any write, copy the current file: `cp idea.md idea.md.bak` (or confirm it is
   git-tracked and clean, so the original is recoverable). State which safety net is in place.
2. **Additive only.** Every original heading, sentence, and bullet stays **verbatim**. Enrichment is *inserted*
   beneath the content it enriches — you may `Edit`-insert new subsections, never replace or reword an existing
   line. If an answer contradicts an original line, do **not** overwrite it: add an `> ⚠ Revises: <original>` note
   beneath and surface the conflict to the user at install time.
3. **Confirm before install.** Show the user a summary of exactly what will be added (per section/milestone) and
   get a one-word go-ahead before writing into `idea.md`.
4. **Reversible.** After install, remind the user the pre-enrichment version is at `idea.md.bak` (or in git).

## How it runs — four phases

### Phase 1 — Partition idea.md (cover everything, skip nothing)

Read `idea.md` top to bottom and build the **work list** — one unit per addressable piece, in file order:

- One unit per **`## section`** (What it is · Why/who · Features · Output & usage · How it works · The keystone ·
  What to wrap · The feel · Non-goals · Stack · Scope for v1 · Success criteria · Skills to leverage · MCP servers).
- One unit per **milestone row** under `## Milestones` (`M1`, `M2`, … each is its own unit — milestones get the
  deepest treatment: a full mini-PRD).

Record the exact list and **echo it to the user** ("I will enrich these N units, in this order — none skipped").
The list is the coverage contract for Phases 2–4: **do not miss, jump, or reorder** units. If `$ARGUMENTS`
scoped the run to one unit, the list is just that one.

### Phase 2 — Fan out questionnaire authoring (ultracode Workflow · Opus orchestrates · Sonnet-5 works)

Author and launch a **Workflow**. The orchestrating session runs on **Opus 4.8** (`claude-opus-4-8`); every
worker `agent()` runs on **Sonnet-5** (`{ model: 'sonnet' }`). Fan out **one worker per unit** from Phase 1
(pipeline/parallel over the work list). Each worker receives:

- the unit's original text, **plus** the whole `idea.md` as surrounding context (so its questions cohere with the
  keystone, stack, and neighbouring milestones — a milestone PRD must respect the keystone contract).
- a mandate: **author a deep questionnaire** that would turn this unit into an enterprise-grade PRD. Not answers —
  *questions*, for the human, in the house interview style.

**Questionnaire contract (every worker returns this shape, schema-validated):**

```
unit:        "<section name or Mx>"
threads:     [ Thread, … ]          // 3–8 threads per unit, ordered
Thread = {
  topic:     "<what this thread decides>",
  questions: [ Q1, Q2, Q3, (Q4) ]   // 3–4 deep — each Q narrows the previous answer
}
Q = {
  ask:         "<the question>",
  why:         "<why it matters for an enterprise PRD>",
  options:     [ "<opt A>", "<opt B>", ("<opt C>") ],   // 2–3, enumerable
  recommended: "<opt A>",            // recommended option, first-listed, with a one-line reason
  reason:      "<why this default>"
}
```

Each thread drills **3–4 levels deep** (topic → choice → sub-choice → consequence). Across a unit, the threads must
span the enterprise-PRD dimensions relevant to it:

- **Features** — capability breakdown, user stories, acceptance criteria, edge cases, out-of-scope.
- **Style / UX** — interaction shape, states, error/empty/loading, a11y, tone, latency feel.
- **System design** — architecture & boundaries, data model & contracts (APIs/schemas/events), scale &
  performance budgets, **security & compliance** (trust boundaries, authz, data classification, retention,
  relevant regimes), observability (logs/metrics/traces/SLOs), failure modes & rollback, dependencies, cost.
- **Delivery** — build order within the milestone, test strategy, rollout/flags, migration.

A worker calibrates depth to its unit (a `## Non-goals` unit needs fewer threads than an `Mx` keystone milestone)
but **every unit returns at least one full thread** — none comes back empty. **Security by design:** any unit that
implies parsing untrusted/external input must include a dedicated trust-boundary thread and flag the memory-safe
stack trade-off, so it lands in the PRD, not the AppSec gate later.

Collect all workers' questionnaires, keyed by unit, back in the orchestrating session.

> **If the `Workflow` tool isn't available** in this environment (its presence depends on the host — ultracode
> orchestration is not universal), fall back to dispatching the same per-unit workers as parallel **`Task`** calls
> (still Sonnet-5, still one per unit, same questionnaire contract). The only thing that changes is the
> orchestration surface; coverage and output shape are identical.

### Phase 3 — Interview the user, unit by unit (main session, one-at-a-time)

Now put the questionnaires to the **user**, walking the work list **in idea.md order, skipping nothing**:

- For each unit, announce it (`— Enriching M3: <title> —`), then work its threads in order.
- Ask with **`AskUserQuestion`** where the answer space is enumerable (you may bundle a thread's 2–4 tightly-related
  questions into one call; recommended option **first**, labelled, with its one-line reason). Keep genuinely
  open-ended prompts as prose. This mirrors `/loopwright:brainstorm`: options + a recommendation every time, the
  user accepts with one word or redirects.
- **Follow the thread depth:** the user's answer to a level selects which level-2/3 question is still live — don't
  ask a sub-question the parent answer mooted, and don't skip one it opened.
- Persist answers as you go (a scratch `idea.enterprise.answers.md` or in-memory), tagged by unit — so a `/clear`
  or compaction mid-interview doesn't lose the collected decisions.
- The user may **defer** a unit ("skip M4 for now") — that's their call, but you never skip on your own; record any
  deferral explicitly so the coverage contract stays honest.

### Phase 4 — Summarize & install (non-destructive)

1. **Summarize** the decisions per unit — a tight recap the user can scan and correct in one pass.
2. **Compose the enrichment** for each unit as an **additive** block that expands the original without touching it.
   For a milestone `Mx`, insert an indented `#### Mx — PRD` subsection beneath its row (features / style / system
   design / delivery, filled from the answers, with any `F#`-worthy security concern called out). For a section,
   insert a `### <section> — enterprise detail` block beneath the original section body. Preserve every original
   line verbatim above the insert.
3. **Show the plan** (which unit gets which block, and any `⚠ Revises` conflicts) and get the one-word go-ahead.
4. **Install** with insert-only `Edit`s (confirm `idea.md.bak`/git first). Then re-read `idea.md` end-to-end and
   verify: every original line is still present, and every non-deferred unit gained its block.

## Output & handoff

When install is done, tell the user:

> **idea.md is now enterprise-grade — original preserved (backup at `idea.md.bak`), every milestone and section
> enriched. Run `/loopwright:new` to scaffold, then `/start`.**

This command **only enriches `idea.md`**. It does not scaffold, does not run `/loopwright:new`, and does not wire
any MCP — those stay deliberate, human-driven handoffs. Full pipeline:
**`/loopwright:brainstorm` → `/loopwright:enterprise` (deepen, optional) → `/loopwright:new` → `/start`.**

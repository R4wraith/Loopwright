---
description: Craft a SOTA idea.md for a project via a principled brainstorming interview, then hand off to /loopwright:new.
argument-hint: "(optional: a one-line idea to start from)"
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /loopwright:brainstorm

This command runs a disciplined, principled interview to craft `idea.md` — the **foundation
contract** the whole Loopwright loop grows on. A great `idea.md` makes the generated harness sing; a
vague one produces a vague harness, so this is worth doing properly before any scaffolding
happens. The interview adapts `superpowers:brainstorming`'s meta-rules but grounds every
recommendation in Loopwright's own `CLAUDE.md` principles, so the defaults teach good architecture as
you go. This command **writes `idea.md` and hands off to `/loopwright:new` — it does not scaffold**
anything itself; the human owns the seam between "design the idea" and "build the harness."

`$ARGUMENTS`, if given, is a one-line idea to start from — treat it as the answer to Interview flow
step 1 and skip re-asking it.

## Interview rules

- **One question per message.** Never batch multiple questions into one turn — each answer should
  inform how the next question gets framed.
- **Offer 2–3 options, recommended option first, with a one-line reason.** Don't ask open-ended
  "what do you want?" when the answer space is enumerable; propose a default the user can accept
  with one word.
- **Skip anything already answered.** If an existing `idea.md` or the prior conversation already
  answers a step, don't re-ask it — only fill genuine gaps. Check for `idea.md` in the target
  directory before starting.
- **YAGNI.** Keep questions scoped to what's needed to write a good `idea.md` — don't interrogate
  for detail the build doesn't need yet.
- Prefer a structured `AskUserQuestion` call wherever the answer space is enumerable (mirrors
  `/loopwright:new`'s own interview-tool preference); keep genuinely open-ended items as free prose.
  If `AskUserQuestion` isn't available in this environment, fall back to the same questions as
  plain prose — either path collects the same answers, only the presentation differs.
- Interview guidance + what good answers look like: `references/blueprint.md`. `/loopwright:new`
  reads the same file for its own intake, so this command's interview stays in sync with it as it
  evolves.

## Interview flow

Work through these in order. For each, recommend an answer and say *why*, grounded in the
principle noted:

1. **What + who.** One sentence: what this does and for whom. Forces clarity — if it can't be said
   in a sentence, help narrow it before moving on.
2. **What it does (features).** Split into **must-have for v1** vs. **later (not now)**. Offer a
   candidate must-have list inferred from the "what + who" answer and recommend trimming it to the
   smallest set that earns the name — grounded in the same **simplest thing that works** principle
   the "Scope for v1" step applies at scope level.
3. **Output & how it's used.** What the user gets and how they interact with it (CLI? web UI? API?
   file?) — what "using it" looks like end to end. Offer 2–3 plausible interaction shapes inferred
   from the idea and recommend the one that needs the least new surface area to prove the core
   works.
4. **How it works (high level).** The core logic/flow in a few lines — the moving parts and how
   data flows between them, not code design. This sets up the keystone question next: naming the
   flow surfaces the abstraction everything binds to.
5. **The keystone.** Offer 2–3 candidate keystones inferred from the idea so far (the central data
   model, schema, protocol, or abstraction everything else binds to) and recommend the one with the
   **widest blast radius** — the thing whose change would force the most rework. This is the most
   important question in the interview: **keystone-first** is how Loopwright avoids sprawl, so get it
   right before anything else is decided.
6. **Wrap vs. build.** For the hard/solved parts, propose mature tools or libraries to lean on.
   Recommend **wrap > build**: reuse infrastructure so effort goes into what's actually the
   project's own value, and only propose building when wrapping genuinely doesn't fit.
7. **Language / stack.** Recommend **memory-safe** (e.g. Rust/Go) whenever the idea parses
   untrusted or external input (uploads, network input, user documents); otherwise recommend
   matching the user's stated familiarity. Name the trade-off either way.
8. **Scope for v1 + non-goals.** Recommend the **simplest** thing that works — the smallest slice
   that proves the core end to end — and explicitly name what's deferred as a non-goal rather than
   silently dropped.
9. **Milestones.** Order them keystone-first (keystone → dependent layers → polish), and give each
   milestone a single checkable *done-when* condition — no milestone without one. These seed the
   harness's `TASKS.md` work axis, so name them the way you'd name work.
10. **Success criteria.** Derive the project's finish line from the milestones: objective, checkable
    conditions that mean the project is **done**. This feeds `GOAL.md`'s finish line directly (the
    run's terminal-success condition), so push for verifiable conditions, not vibes.
11. **The feel.** The tone/UX qualities that matter (fast, minimal, playful, rock-solid, …) — what a
    good experience feels like when it's working.
12. **Skills to leverage.** Run the Skills & MCP research phase below and record the chosen skills.
13. **MCP servers.** Same research phase — record the chosen MCP servers. Grounded in **wrap >
    build**: an MCP that already solves a hard part beats writing an integration from scratch.

## Security by design

Whenever the idea implies parsing untrusted or external input — file uploads, network-facing
listeners, user-supplied documents, third-party webhooks, anything crossing a trust boundary —
flag it explicitly at the relevant step (steps 7 and 13 are the natural points). Nudge the
**memory-safe** stack recommendation, and note the concern plainly in `idea.md` so it's a
first-class input to the eventual AppSec gate in the generated harness, not something rediscovered
later.

## Skills & MCP research

At steps 12–13, **enumerate** what's actually available in this environment — the installed Claude
Code skills and the configured MCP servers (check the environment/tool listing available to you;
`Glob`/`Grep` over any local skills or MCP config if that's how they're surfaced here). Then:

1. **Recommend** the project-relevant subset, grounded in the idea itself — e.g. a payments
   project points at a `stripe-integration` skill; a data-heavy project points at a Postgres MCP;
   anything that already solves a hard part wins under **wrap > build**.
2. **Let the user pick, add, or decline** — present the recommended subset and take corrections
   rather than silently committing to your first guess.
3. **Record** the final set, each with a one-line *why*, into `idea.md`'s `## Skills to leverage`
   and `## MCP servers` sections.

If enumeration isn't possible in this environment, **fall back to asking** the user to name the
skills/MCP servers they want considered, in prose — the same fallback `/loopwright:new` uses for its
own AskUserQuestion-vs-prose split.

MCP servers are a research-and-recommend input only: this command **never wires** anything into
`settings.json`/`.mcp.json` itself. Wiring a real MCP server is consequential (it grants a whole
integration surface), so it's always flagged for the human to confirm — here, and again by
`/loopwright:new` when it propagates these into the harness.

## Output & handoff

Write a complete `idea.md` at the project root, following `assets/idea.template.md` section for
section — fill **every** section, including the ones that feed the harness directly:
`## Success criteria`, `## Non-goals`, `## Milestones`, `## Skills to leverage`, `## MCP servers`.
For any section not directly covered by an interview question, synthesize it from the interview
answers and surrounding context rather than skipping it. Never leave a placeholder `…` bullet
anywhere in the written `idea.md` — a vague `idea.md` produces a vague harness.

When `idea.md` is written, tell the user:

> **idea.md is ready — run `/loopwright:new` to scaffold, then `/start`.**

This command stops there. It explicitly **does not run or scaffold** `/loopwright:new` itself, and it
does not auto-wire any MCP server — both are deliberate handoffs the human drives, one command at a
time: `/loopwright:brainstorm` (craft `idea.md`) → `/loopwright:new` (scaffold) → `/start` (build).

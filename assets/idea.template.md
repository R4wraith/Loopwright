# idea.md — <Project name>

> High-level design. Write this on a clean planning session (Opus 4.8) *before any code*.
> Loopwright reads this to scaffold the build harness, so be concrete — especially the keystone and milestones.

## What it is
One sentence: what this does and for whom.

## Why / who it's for
The problem it solves and the person who has it.

## What it does (features)
- **Must-have (v1):**
  - …
  - …
- **Later (not now):**
  - …

## Output & how it's used
What the user gets and how they interact with it (CLI? web UI? API? file?). What "using it" looks like end to end.

## How it works (high level)
The core logic / flow, in a few lines. Don't design the code — describe the moving parts and how data flows.

## The keystone
The one thing everything else depends on — the central data model, schema, protocol, or abstraction. (If unsure, name the thing whose change would force the most rework. Loopwright builds this first.)

## What to wrap (don't rebuild)
Mature tools/libraries to lean on for the hard parts, so effort goes into what's actually yours.

## The feel
Tone / UX qualities that matter (fast, minimal, playful, rock-solid, …). What a good experience feels like.

## Non-goals
What this explicitly will **not** do — and what's deferred to "later" rather than v1.

## Stack (if you have a preference)
Language / framework, and why. (Leave blank to let Loopwright propose one. Lean memory-safe where it parses untrusted input.)

## Milestones
Order them so each stands on finished ground. Give each a checkable success criterion. Each milestone
seeds the harness's `TASKS.md` work axis (milestone → tasks), so name them the way you'd name work.

- **M1 — <keystone>:** … → *done when:* …
- **M2 — …:** … → *done when:* …
- **M3 — …:** … → *done when:* …
- **M4 — …:** … → *done when:* …

## Scope for v1
What "first working version" includes — the smallest thing that proves the core works end to end.

## Success criteria (the finish line)
Objective, checkable conditions that mean the project is **done** — these seed `GOAL.md`'s finish line
(the loop's terminal-success condition, distinct from the shift/run budget backstops). Verifiable, not vibes.
- …

## Skills to leverage
Claude Code skills the build should invoke for specific work, each with a one-line *why*. `/loopwright:new`
propagates these into the generated harness (a CLAUDE.md note + a DECISIONS entry).
- …

## MCP servers
MCP servers to wrap for hard/solved parts, each with a one-line *why* (wrap > build). Wiring is confirmed
by the human in `settings.json`/`.mcp.json` — never auto-enabled.
- …

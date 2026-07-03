---
description: Scaffold a new Trellis .claude/ harness for a project (explicit entry point for Step 1–5).
argument-hint: "(optional: target project directory, default is the current directory)"
allowed-tools: Read, Write, Edit, Bash(mkdir:*), Bash(chmod:*), Bash(grep:*), AskUserQuestion
---

# /trellis:new

This is the **explicit** entry point for the skill's own scaffold process — the same Step 1–5
the skill runs when a user just describes their idea in prose (see the root `SKILL.md`), but
here you drive it directly and structure the intake questions instead of leaving them as free
prose.

Target project directory: `$ARGUMENTS` if given, else the current working directory.

## Step 1 — Understand the idea

**First, check for `idea.md`** in the target directory. If present, read it — it answers most of
the questions below; only ask about genuine gaps.

For whatever isn't already answered by `idea.md` or the conversation so far, collect it. Where an
answer space is enumerable, prefer a structured **`AskUserQuestion`** call over open prose (this
command's reason to exist over the implicit skill trigger):
- **Language / stack** — multi-select from a short common-stack list (e.g. TypeScript/Node,
  Python, Go, Rust, Java/Kotlin, other) plus a free-text "other".
- **Scope (v1 vs later)** — a yes/no confirm on the default "local/CLI/localhost-testable first,
  defer cloud/hosted/distributed" instead of open-ended prose.

Keep genuinely open-ended items as free text (don't force `AskUserQuestion` where it doesn't fit):
- What are you building, in one sentence?
- The **keystone** — the one core data model/schema/protocol/abstraction everything else depends
  on.
- The **3–6 major components/subsystems** (each becomes a specialist subagent).
- Any **mature tools/libraries to wrap** instead of building.

> **If `AskUserQuestion` isn't available in this environment/context** (its availability from
> inside a plugin command is not independently re-verified — see the design spec §7), fall back
> to the same questions as plain prose, exactly as the root `SKILL.md` interview describes it.
> Either path collects the same six answers; only the presentation differs.

Read `references/blueprint.md` for how to run this interview well and what good answers look
like.

## Step 2 — Architecture pass

Apply the patterns in `references/blueprint.md`: find the keystone and build it first; wrap
mature tools rather than reinvent them; define the build order (keystone, then each dependent
layer, simplest viable slice each step); scope honestly (defer the genuinely-later work and name
the seam that keeps it cheap to add later). Capture the load-bearing calls as decisions (at
minimum D1 wrap-vs-build, D2 language).

## Step 3 — Derive the subagent roster

Spine (always present, generic): `reviewer`, `test-engineer`, `integrator`, `release-manager`,
`performance-engineer` (+ `appsec-reviewer`, `threat-modeler` per SP2). Component-owners: one per
major component from Step 1. See `references/agent-roster.md`.

## Step 4 — Materialize the `.claude/` folder

1. Copy the skeleton into the target project root as `.claude/`:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/new-harness.sh" <target-project-dir>
   ```
   (`new-harness.sh` resolves the skeleton from `${CLAUDE_PLUGIN_ROOT}/assets/skeleton/dot-claude`
   when running as an installed plugin, so this works correctly out of the plugin cache — see the
   script's own header comment. It's idempotent: refuses to overwrite a non-empty existing
   `.claude/` by default; pass `--backup` or `--force` to the script if the target already has one
   and the user wants to proceed anyway.)
2. Fill every `{{PLACEHOLDER}}` in `CLAUDE.md`, `DESIGN.md`, `GOAL.md`, `STATE.md`, `PROGRESS.md`,
   `DECISIONS.md`, `LEARNINGS.md`, `CODEMAP.md`, `README.md` using Steps 1–3. Confirm `CLAUDE.md`
   still carries `Harness-Version: 2.0` (verbatim — don't touch this line).
3. Generate one `agents/<name>.md` per component-owner from the template in
   `references/agent-roster.md`.
4. Leave the verbatim files unchanged: `settings.json`, `hooks/`, `scripts/`, `githooks/`,
   `commands/`, and the spine agents.
5. If `idea.md` has `## Skills to leverage` / `## MCP servers`, propagate them: add a "Leverage these
   skills / MCP" note to the generated `CLAUDE.md` conventions + a `DECISIONS` `D#` entry. Do NOT
   auto-wire MCP into `settings.json`/`.mcp.json` — flag it for the user to confirm (wiring an MCP
   server is consequential).
6. Sanity-check: `grep -rn '{{' <target>/.claude` must be empty.

## Step 5 — Hand off

Tell the user: drop `.claude/` into the project root (already done by step 4), open Claude Code
there, run `/start`. Remind them to confirm the language in `DECISIONS.md` (D2) before any
keystone code is generated.

---
**Namespace note:** this command (`/trellis:new`) and `/trellis:upgrade` are the plugin's *own*
operation — they live in this plugin-root `commands/` folder. They are unrelated to (and never
collide with) the *generated* project's own un-namespaced `/start`, `/goal`, `/loop`, `/status`,
`/dream`, which ship inside `assets/skeleton/dot-claude/commands/` and are copied into the
*target* project's `.claude/commands/` — a scaffolded project is not itself a plugin, so those
never get namespaced or auto-discovered from here.

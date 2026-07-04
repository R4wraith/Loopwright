# {{PROJECT_NAME}} — Claude Code autonomous build (drop-in)

**Drag this `.claude/` folder into your project root, open Claude Code there, and run `/start`.** That's it.

Everything loads automatically because it's all in `.claude/`: the constitution (CLAUDE.md), the
workflow contract (WORKFLOW.md), the safety + orchestration hooks (settings.json), the per-agent
context manifests, and the build journal.

## Start
```
# from your project root, with the .claude/ folder dropped in:
claude
/start
```
`/start` runs `node .claude/hooks/loop-state.mjs --init` — it wires the optional git-layer safety
hooks, checks your environment, opens the first shift (s-001), and begins the autonomous loop
(starting with the keystone). It pauses only for an irreversible action, a real fork, a genuine
blocker, or a milestone gate.

## The loop model (see WORKFLOW.md)
Hierarchy: **run ⊃ shifts ⊃ sessions ⊃ iterations ⊃ slices**. A **shift** is one operator + one budget
envelope and always ends with a `HANDOFF.md`. Each **iteration** picks a task off `TASKS.md`, builds it
in small **slices**, verifies, commits, and records the journal. `WORKFLOW.md` is the per-turn
playbook: `workflow-state.mjs` injects the block matching your current task status every turn.

## Recommended (optional)
- Persistent memory across sessions: `npx claude-mem install`, then restart Claude Code.
- Hands-off runs: `claude --enable-auto-mode`, then Shift+Tab to **auto** — the budget backstop bounds it.

## Notes
- Confirm the language in `DECISIONS.md` (D2) before the keystone is generated.
- Task status cells change ONLY through `node .claude/hooks/loop-state.mjs --task <id> --to <status>`
  — hand-edits to `TASKS.md` are detected by `--doctor`, never silently reverted.
- `.claude/loop.json` is a git-ignored, disposable counter cache — losing it loses nothing (it
  rehydrates from `.claude/ledger/events.jsonl`). The git-tracked journal (STATE/PROGRESS/TASKS/
  DECISIONS/FINDINGS/HANDOFF + the ledger) is the truth.
- The **product source code** you build lives at the **project root**; `.claude/` stays config + journal.

## What's inside
`CLAUDE.md` (how we work) · `WORKFLOW.md` (the run→shift→iteration→task contract) · `DESIGN.md` (what
we build) · `GOAL/STATE/PROGRESS/DECISIONS/FINDINGS/LEARNINGS/PERF/CODEMAP.md` · `TASKS.md` (the task
board) · `HANDOFF.md` (per-shift baton) · `manifests/` (per-agent read-lists) · `hooks/` +
`settings.json` · `ledger/` (append-only run history) · `scripts/` · `githooks/`.

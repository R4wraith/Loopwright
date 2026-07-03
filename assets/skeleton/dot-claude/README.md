# {{PROJECT_NAME}} — Claude Code autonomous build (drop-in)

**Drag this `.claude/` folder into your project root, open Claude Code there, and run `/start`.** That's it.

Everything loads automatically because it's all in `.claude/`: the constitution (CLAUDE.md), the subagents, the safety hooks (settings.json), the commands, and the build state.

## Start
```
# from your project root, with the .claude/ folder dropped in:
claude
/start
```
`/start` wires the optional git-layer safety hooks, checks your environment, and begins the autonomous loop (starting with the keystone). It pauses only for an irreversible action, a real fork, or a genuine blocker.

## Recommended (optional)
- Persistent memory across sessions: `npx claude-mem install`, then restart Claude Code.
- Hands-off runs: `claude --enable-auto-mode`, then Shift+Tab to **auto**.

## Notes
- Confirm the language in `DECISIONS.md` (D2) before the keystone is generated.
- Spine subagents ship with per-role model routing already pinned in frontmatter — `reviewer`/`performance-engineer`: `opus` (adversarial judgment); `test-engineer`/`integrator`: `sonnet` (execution); `release-manager`: `haiku` (git mechanics). Component-owners default to `sonnet`, except a keystone `-architect` owner, which is `opus`. See CLAUDE.md's "Model routing" section to adjust.
- The **product source code** you build lives at the **project root**; `.claude/` stays config + journal.

## What's inside
`CLAUDE.md` (how we work) · `DESIGN.md` (what we build) · `GOAL/STATE/PROGRESS/DECISIONS.md` · `commands/` (`/start` `/goal` `/loop` `/status`) · `agents/` (spine + component-owners) · `hooks/` + `settings.json` · `scripts/` · `githooks/`.

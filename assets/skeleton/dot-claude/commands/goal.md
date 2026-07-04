---
description: Lock the project mission for the loop.
allowed-tools: Read, Edit
---
You're the lead engineer + PM for this project. Treat the mission in `.claude/GOAL.md` as durable and unchanging — check it at the start and end of every loop iteration.

1. Make sure `.claude/GOAL.md` still states the mission clearly (fix it if it drifted).
2. Skim CLAUDE.md (already loaded) and `.claude/DESIGN.md` so the mission is grounded in the architecture.
3. Summarize in 2-3 lines: the mission + the current focus from `.claude/STATE.md`, and the active/next task from `.claude/TASKS.md`.

The mission is the terminus: `.claude/GOAL.md`'s `## Success criteria` are what `--complete-run` records against, not a milestone count.

# GOAL (immutable)

Build a working, well-made, {{TESTABLE_HOW}} {{PROJECT_NAME}} per `.claude/DESIGN.md`:
- {{KEYSTONE}} first (the keystone),
- {{KEY_BUILD_POINTS}}.

Simple over clever. Don't fake progress — make something actually worth running.

## Success criteria (the finish line — immutable)
The project is **done** when *all* of these objectively hold. The loop checks this at every milestone
boundary; when they all pass, record completion with `node .claude/hooks/loop-state.mjs --complete-run`
— a *success* terminal state for the whole run, distinct from a budget/wall-clock *resource* stop.
Keep them checkable, not vibes:
- {{SUCCESS_CRITERIA}}

## Non-goals (out of bounds — immutable)
This project will **not** do the following. If a slice starts drifting toward one, treat it as scope
creep: defer it to `.claude/DESIGN.md`'s later/backlog — don't build it now.
- {{NON_GOALS}}

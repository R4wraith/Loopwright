# The workflow — idea to production

Loopwright is built for **long, multi-feature sessions** that take a real project from nothing to something you'd ship — not one-off snippets. This is the recommended way to run it, and why each step is there.

## The shape

Naive "vibecoding" (let the model freewheel, don't read the diff) is great for a throwaway demo and falls apart on real software: it builds the wrong thing first, loses the thread after a few features, and reports stubs as done. Loopwright keeps the *ergonomics* — you work at the level of intent, not line-by-line — and adds the structure that lets a session run long, carry many features, and survive contact with a production-bound codebase. The full cycle, milestone after milestone: **explore → design → plan → implement**, with context preserved across the whole thing.

The division of labour is the point: **you decide at the seams, the agent does the volume.**

## Step 1 — Plan on a clean session with your strongest model

Open the Claude app, pick **Opus 4.8**, start a **fresh** session (no clutter in context), and think the product through *before any code*. What does it do? Who's it for? How does it work? What should it feel like? What are the milestones? This is where your judgement matters most, so spend it here.

## Step 2 — Write `idea.md`

Capture that thinking as a single high-level design doc. Aim to cover: what it does, the features (must-have vs later), the output and how it's used, how it works (the logic, at a high level), the feel/UX, the non-goals, and the **milestones** you're aiming for. Use [`../assets/idea.template.md`](../assets/idea.template.md) as the outline.

`idea.md` is the contract between your planning brain and the build loop. A good one means the scaffolder barely has to ask you anything; a vague one produces a vague harness.

## Step 3 — Hand off to Claude Code + Loopwright

Drop `idea.md` into the (empty) project folder. With Loopwright installed (user-global, or project-scoped in that folder's `.claude/skills/`), ask it to scaffold. Loopwright **reads your `idea.md`**, makes the architecture calls it implies — the keystone, what to wrap vs build, the build order, the subagent roster — and writes the tailored `.claude/` harness into the folder. It only asks you about genuine gaps.

## Step 4 — Fresh session, then `/start`

Open a **clean** Claude Code session in the project folder and run `/start`. The loop takes over and builds milestone by milestone: it dispatches agent teams, reviews and tests its own work, integrates, commits, and records honest status — pausing only at the points below.

## Where you stay in control

You steer at the **seams**, not the slices:

- **The design** — `idea.md` and the architecture direction.
- **Milestone reviews** — at each milestone boundary the loop posts a short review (what shipped, the key design choices, what's next) and waits for your go-ahead before starting the next milestone. This is your main steering wheel: approve, adjust the design, or redirect. *Mid-*milestone, it keeps going on its own.
- **Forks and blockers** — anything irreversible or genuinely ambiguous gets one focused question.

Everything between those — decomposition, the specialist subagents, review, tests, integration, commits, the journal — is the agent's job. The design goal is that you're at the seams and the loop runs the rest; in shorthand, roughly **~90% hands-off**. Treat that as the *target shape* of the workflow, not a measured promise — how close you get depends on how clean `idea.md` is and how novel the problem is.

## Why it holds up over long, multi-feature runs

- **Agent teams, not one giant context.** Heavy work is farmed out to parallel subagents, each with its own focused context that returns a tight summary. The main thread stays lean, so the session can carry many features without drowning in its own history. The same property makes it suit **programmatic / headless** operation (Claude Code's SDK / `claude -p`) rather than a single long interactive chat.
- **Git is the memory.** Durable state lives in the journal (`GOAL` / `STATE` / `PROGRESS` / `DECISIONS`) and in git. After a context reset or compaction, the agent re-reads compact truth instead of re-deriving everything — so long runs resume cleanly with `continue the loop` or another `/loop`.
- **Quality over thrift.** The architecture happens to be context-efficient, but Loopwright does **not** optimize for fewer tokens. It spends what it takes to build a real system from zero and get it right — durable beats cheap.

## Running it unattended

- Prefer **auto** mode (`claude --enable-auto-mode`, then Shift+Tab) for long hands-off stretches; the harness hooks stay a hard backstop in every mode.
- Add **claude-mem** (`npx claude-mem install`) for episodic recall across sessions on top of the git journal.
- It still isn't walk-away-forever: it pauses at milestone reviews and real forks by design. That's the feature — bounded autonomy is what makes the output shippable.

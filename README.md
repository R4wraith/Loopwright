<h1 align="center">🔁 Loopwright</h1>

<p align="center"><b>The loop your project ships on.</b></p>

<p align="center">
A single drop-in <code>.claude/</code> folder that turns Claude Code into a disciplined, self-driving build crew —<br/>
<b>security-first, self-pacing, and honest about what it did</b> — and recreates the <i>same</i> blueprint for any idea you have.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/>
  <img src="https://img.shields.io/badge/Loopwright-v3.0-16a34a" alt="Loopwright v3.0"/>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin%20·%20skill-5A4FCF" alt="Claude Code plugin or skill"/>
  <img src="https://img.shields.io/badge/install-drop--in%20.claude%2F-22c55e" alt="Drop-in .claude/"/>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20·%20Codex%20·%20Gemini%20CLI-64748b" alt="Compatible agents"/>
</p>

---

## What is Loopwright?

Telling an AI agent *"go build my idea autonomously"* usually ends one of two ways: it **sprawls** (builds the wrong thing first, then fights its own foundation) or it **fakes progress** (reports stubs as done). A loopwright fixes that: it doesn't do the building, it **shapes and paces the loop** that does — keystone first, on-rails, honest — the way a shipwright frames a hull so the voyage actually reaches shore.

Loopwright is a **Claude Code plugin** (also installable as a plain skill). Point it at a new idea; it runs a short, principled architecture interview and writes a complete, tailored `.claude/` folder you drop into your project. From then on, Claude Code works as a **lead engineer + PM**: it opens a **shift**, claims the highest-leverage task, routes it to the right-sized model, dispatches specialist subagents, **threat-models and reviews** its own work, tests it, commits cleanly against a verified tree, records honest status to an **event-sourced ledger** — and repeats, winding down each shift with a `HANDOFF.md` and pausing only when it genuinely needs you.

The whole harness lives in **one folder**. No scattered config, no setup ceremony.

```
your-project/ ──drop in──▶ .claude/   ──Claude Code reads it──▶ builds your project, slice after slice
```

> **In one line:** a bounded, keystone-first autonomous loop with an event-sourced run ledger, operator shifts with HANDOFF continuity, a workflow-state keystone that resumes exactly where it stopped, security as a first-class gate, a tracked findings-and-lessons ledger, deterministic shift/run budget backstops for long unattended runs, per-role model routing, curated per-agent context, and versioned plugin packaging.

---

## Not a toy — it builds real software

Loopwright has driven a **complete, real-world, security-sensitive desktop application** — from an empty folder, through every planned milestone and a follow-on feature phase beyond them, **with no human-written code**. The result was verified the honest way: by *building and running it*, not by trusting the harness's own status.

- ✅ **All milestones delivered**, plus extra features the loop proposed and shipped on its own.
- ✅ **Real tests passing** on an independent machine — 0 human lines of code.
- ✅ **Real security boundaries in place** — input sanitization, a strict content-security policy, and denial-of-service limits, all discovered and closed by the harness's own security gate.
- ✅ **No "completion theater" at any milestone** — every "done" traced to code that compiles and runs. It even caught and repaired its *own* mistakes mid-run.

The point isn't "trust the design." It's that the loop below has already carried a genuinely hard, security-sensitive product end to end.

---

## How it's wired

<p align="center"><img src="docs/img/architecture.svg" alt="Loopwright architecture: one drop-in .claude/ folder — constitution, workflow mechanism, design doc, build journal, event ledger, findings/lessons ledger, code map, commands, agents, Node hooks, scripts — loaded automatically by Claude Code" width="860"/></p>

Everything Claude Code needs sits inside `.claude/`, which it loads automatically every session:

| Piece | What it does |
|---|---|
| **CLAUDE.md** | The constitution — principles (the three pillars), the team, the definition of done. Carries the `Harness-Version` stamp. Auto-loaded. |
| **WORKFLOW.md** | The **verbatim** run → shift → iteration → slice mechanism. A hook parses its status blocks and injects the one matching your current state **every turn**, with an exact-resume pointer. |
| **DESIGN.md** | What you're building — the *keystone* and the build order, tailored to your idea. |
| **GOAL / STATE / PROGRESS / DECISIONS** | The build journal. Git-tracked, human-readable — the source of truth for intent. |
| **TASKS / HANDOFF** | The work axis (tasks with a strict status lifecycle) and the shift handoff (read first at orient, authored at wind-down). |
| **FINDINGS / LEARNINGS** | The findings-and-lessons ledger — security/review findings with a milestone gate, and durable lessons. |
| **ledger/** | `events.jsonl` — the append-only, event-sourced run history (run/shift/slice/approval). Truth for *what happened*; `loop.json` is a disposable cache rehydrated from it. |
| **CODEMAP.md · PERF.md** | A curated map of the code's structure; performance budgets and numbers. |
| **manifests/** | Per-subagent curated context read-lists, prepended to every Task dispatch as a read list (paths + reasons). |
| **commands/** | `/start`, `/goal`, `/loop`, `/status`, `/shift`, `/handoff`, `/routine`, `/dream`. |
| **agents/** | The **spine** (reviewer · test-engineer · integrator · release-manager · performance-engineer) + the **security finders** (threat-modeler · appsec-reviewer) + **component-owner** agents generated to match your project. |
| **hooks/ + settings.json** | Portable **Node** hooks: a fail-*closed* command guard + secret scanner, the every-turn workflow-state injector, the subagent-context prepender, the shift/run budget backstop, the event ledger + task engine, compaction recovery, and journal integrity. A best-effort backstop, not a sandbox. |
| **scripts/ + githooks/** | Test runner, lint/secret scan, the ledger gate, a GUI smoke check, and a pre-push gate. |

Your actual product code is built at the **project root** (`src/`, etc.). `.claude/` stays config + journal + ledger.

---

## Capabilities

Everything below ships in the generated harness and is exercised by the loop.

### 🧭 Craft the foundation — `/loopwright:brainstorm`
The loop is only as good as the `idea.md` it runs on, so Loopwright helps you craft a great one. **`/loopwright:brainstorm`** runs a principled, **one-question-at-a-time** interview (2–3 options each, **recommended-first with a reason**), where every suggestion is *reasoned from* a Loopwright principle — keystone-first · wrap > build · memory-safe · simplest-thing-that-works. It covers every part of a strong design, flags security-sensitive input up front, and **researches your environment's installed Skills and MCP servers** — recommending the project-relevant subset so the scaffolder can wire them in. Your success criteria become the loop's explicit **finish line** (it knows when it's *done*, distinct from the shift/run budget backstops). Then it hands off — it never auto-scaffolds; the design→build seam stays yours.

### ⏭️ Shifts, handoffs & an event-sourced ledger
A long build is many sittings. Loopwright makes "one sitting" a first-class unit: a **shift** carries one operator and one budget envelope, and ends with exactly one **`HANDOFF.md`**. Every meaningful event — run started, task claimed, slice verified, slice committed, milestone approved, shift ended — is appended to **`ledger/events.jsonl`**, an append-only log that is the truth for *what happened*. The disposable `loop.json` cache is rehydrated from it, so a `/clear`, a compaction, or an outright crash loses nothing: the next shift reads the handoff first, replays the ledger, and resumes exactly where the last one stopped. The ledger merges union-safe across machines and rotates to `ledger/archive/`.

### 🧩 The workflow-state keystone
`WORKFLOW.md` is the mechanism, not just docs. Its `[workflow-state:*]` blocks are parsed by a hook that injects the **one block matching your current status every turn**, headed by an exact-resume pointer — so the agent always knows precisely what step it's on and what the next concrete action is. There is no fallback dictionary in code: delete or rename a block and it degrades *visibly*, never silently. That single mechanism is what makes crash-resume and headless operation reliable.

### 🔒 Security, made first-class
Security isn't one line in a reviewer's brief. The constitution carries a **Security-by-design** pillar, and the harness ships two **read-only finder agents** that *find but never fix* (they hold no edit tools — separation of duties is enforced *mechanically*):

- **`threat-modeler`** — STRIDE on the change + explicit abuse/misuse cases.
- **`appsec-reviewer`** — an OWASP-category sweep (injection, authz, crypto, deserialization, SSRF, path traversal, secrets, resource/DoS) that adjudicates the threat model.

Findings become rows in the ledger; a milestone **can't close** with an unresolved blocker or high-severity finding. If one exists, the PM runs a **bounded fix loop** — an owner writes a regression/abuse test, an *independent* agent re-verifies, and the gate re-checks.

### 📒 The findings-and-lessons ledger
Two git-tracked files everything binds to: **`FINDINGS.md`** (an append-only table with a strict status lifecycle and one greppable gate rule — *no blocker/high may sit unresolved at a milestone boundary*) and **`LEARNINGS.md`** (durable lessons, each citing a real finding or commit, flushed at every milestone). Security and quality state becomes **compact git truth** that survives a long shift the same way build state does — instead of a reviewer's "should-fix" evaporating on the next context compaction.

### ✅ The task work-axis & a verified-tree commit gate
Work is tracked on an explicit axis: **`TASKS.md`** rows move through a strict lifecycle (queued → planning → in_progress → verifying → committing → done, plus blocked/dropped), and a task **must be claimed before any code is edited** — so two sessions never guess at the same work. A slice is only committed against a **stamped verified tree**: `git write-tree` must equal the tree that was verified, or the commit is refused and verify re-runs. "Done" can't drift from what was tested.

### ⏱️ Bounded autonomy & liveness
Long unattended runs are only safe if they can't run away. Deterministic Node hooks on verified Claude Code events keep them in bounds:

- **Shift + run budget backstop** — an **active-time** + iteration counter per shift (idle pauses cost at most a capped amount), plus cumulative run ceilings; past a ceiling it winds down, authors the handoff, and stops (and correctly releases, so it can never wedge itself into a "don't stop" loop).
- **Compaction recovery** — a snapshot of the current scope/intent is taken right before context is squeezed, and re-injected on the next turn, so a mid-slice compaction doesn't lose the thread.
- **Journal integrity** — nudges when a commit lands without the journal moving, and a stale-commit guard flags a partial commit that doesn't match the just-verified work.
- **Milestone gate** — milestones are a tracked checklist; the loop hard-pauses for your go-ahead even in auto mode, records *who* approved (you, or a standing self-authorization) with a TTL for an audit trail, and — headless, with no human available — converges to a clean handoff instead of looping.

### 🎯 Smart model routing & a faster loop
Every agent declares the right tier instead of running everything on the top model: **Opus** for architecture/decision/review judgment, **Sonnet** for building, **Haiku** for mechanical git work. The hot path is cheap: **tiered verify** (trivial slices get a quick inline review; only real component/keystone slices spin the full spine; nits are logged, not independently re-verified), a lean **orient** step that reads `HANDOFF.md` + a compact digest instead of the whole ever-growing log, a **changed-files-scoped** fast path per slice, and **reviewer ∥ tester** run in parallel.

### 🧠 Three-tier memory (code awareness)
Git journal + event ledger (the truth) → **`CODEMAP.md`**, a curated, git-tracked map of modules, key symbols, their contracts, and dependency/caller edges, read at *orient* so the agent knows the shape of the code before touching it → optional episodic recall across sessions. Subagents get a **curated `manifests/` read-list** so a dispatched specialist always sees the keystone contract and the spec it works against. For big codebases there's a documented, optional escalation to a *wrapped* LSP-backed MCP for semantic navigation; a custom-built code graph is deliberately deferred until the simpler tiers prove insufficient.

### 🌙 Dream mode
`/dream` is a bounded, higher-reasoning **reflective pass**: it mines the day's findings and mistakes into durable lessons, then self-brainstorms the next milestones at production ambition and queues them as *speculative pilots* the loop proposes-vs-disposes later. It's honesty-railed — every lesson needs real provenance; it never claims shipped work, never flips a finding's status, and never touches product code.

### 🛠️ Hardening
The test gate **hard-fails** on an unrecognized stack (no silent pass with zero tests); missing security scanners are **reported loudly** rather than skipped in silence; a **GUI smoke check** guards layout/interaction regressions that unit tests miss; the scaffolder is **idempotent** (never a blind clobber); and all scripts are working-directory-safe.

### 📦 Packaged as a versioned plugin
Loopwright ships as a Claude Code **plugin** with namespaced commands — **`/loopwright:brainstorm`** (craft the idea), **`/loopwright:enterprise`** (optionally deepen `idea.md` into an enterprise-grade PRD), **`/loopwright:new`** (scaffold), and **`/loopwright:upgrade`** (bring a deployed harness up to the current version). The upgrade path refreshes the *mechanism* files only (including `WORKFLOW.md`) and **never touches** your journal, ledger, task/handoff state, or tailored `CLAUDE.md`. It still installs as a plain skill folder if you prefer no plugin machinery.

---

## The loop

<p align="center"><img src="docs/img/loop.svg" alt="The autonomous loop: orient, check the approach, build via subagents, verify (tiered), integrate, commit, record — with a stop-and-ask branch for irreversible actions, real forks, blockers, or trust-boundary guesses" width="560"/></p>

Run `/start` and the loop self-propels: it opens the **run** and the first **shift**, then each iteration (`/loop` pass): **orient** (read `HANDOFF.md` first, then the journal + ledger + code map, pick/claim the highest-leverage task) → **check the approach** (is there a simpler way?) → **build** (route to the right model, dispatch subagents with their curated context) → **verify** (tiered by slice size — independent read-only review + tests/fuzzing, reviewer ∥ tester, the security gate at milestones — then stamp the verified tree) → **integrate** (smoke test in the real build) → **commit** (only against the stamped tree) → **record** (honest status; flip finding statuses; flush lessons; append to the ledger). At each **milestone** it posts a short review and hard-pauses for your go-ahead. It stops to ask exactly one focused question only for an irreversible action, a real fork, a genuine blocker — or a guess at a security trust-boundary. A deterministic **shift/run budget backstop** winds the whole thing down — with a full `HANDOFF.md` — before an unattended run can run away.

---

## From idea to production

Naive "vibecoding" — letting the model freewheel — is great for a throwaway demo and falls apart on real software: it sprawls, loses the thread after a few features, and reports stubs as done. Loopwright keeps the *ergonomics* of vibecoding — you stay at the level of intent, not line-by-line — while adding the structure that lets a session run **long**, carry **many features** across **many shifts**, and come out as something you'd actually ship. It's built for the **full cycle**, milestone after milestone: **explore → design → plan → implement**, the bulk of it running autonomously.

<p align="center"><img src="docs/img/workflow.svg" alt="Workflow: brainstorm the idea, scaffold the harness, then run the loop milestone by milestone with human milestone reviews, through to production" width="980"/></p>

### The recommended workflow

1. **Craft the idea.** Run **`/loopwright:brainstorm`** — a principled, one-question-at-a-time interview that thinks the product through (logic, features must-have vs later, the output and how it's used, the feel, non-goals, success criteria, and the milestones), researches the relevant Skills/MCP servers, and writes a strong `idea.md` for you. *(Prefer to hand-write it? A template is included — brainstorm-first is just the surest path to a foundation that isn't thin.)*
2. **Deepen it (optional).** Run **`/loopwright:enterprise`** — an **ultracode** multi-agent pass that turns each milestone and section of `idea.md` into a comprehensive, enterprise-grade PRD (features · style · system design), via a deep questionnaire, then installs the answers back into `idea.md` **non-destructively** (original preserved). Reach for it when the project is real software that deserves a detailed spec, not a sketch.
3. **Scaffold the harness.** Run **`/loopwright:new`**. It reads your `idea.md`, makes the architecture calls (keystone, what to wrap, build order, subagent roster), and writes the tailored `.claude/` into your project.
4. **Build.** Open a clean session and run **`/start`**. The loop takes over — opening a shift, building milestone by milestone, routing and dispatching agent teams, threat-modeling, reviewing and testing its own work, committing, and recording honest status to the ledger.

**The pipeline in one line:** `/loopwright:brainstorm` → `/loopwright:enterprise` *(optional)* → `/loopwright:new` → `/start`.

### Who decides what

You stay at the **seams**; the agent does the **volume**.

- **You own:** the initial design, the architecture direction, the **review at each milestone**, the **shift boundaries**, and the occasional fork it can't resolve.
- **Loopwright-driven Claude Code owns:** the implementation cycle — decomposition, model routing, the specialist subagents, threat-modeling + review, tests, integration, commits, the build journal, and the ledger.

The design goal is roughly **~90% hands-off** — you steering at the milestones and shift boundaries, the loop running everything between them. Treat that as the *target shape* of the workflow, not a measured guarantee; how close you get depends on how clean the idea is and how novel the problem is.

### Why it holds up over long runs

- **Agent teams, not one giant context.** Heavy work is farmed out to parallel subagents, each with its own focused context (and a curated `manifests/` read-list) that returns a tight summary — so the main thread stays lean and the session survives many features. That property is also what makes it suit **programmatic / headless** operation (Claude Code's SDK / `claude -p`), not just a single long chat.
- **Git + the ledger are the memory.** State lives in the journal, the findings ledger, the append-only event ledger, and git, so after a context reset (or a compaction snapshot, or a fresh shift) the agent re-reads compact truth — starting with `HANDOFF.md` — instead of re-deriving everything. Long runs resume cleanly.
- **Quality over thrift.** The design happens to be context-efficient, but Loopwright does **not** try to minimize tokens — it spends what it takes to build a real system from zero and get it right.

---

## Quickstart

> **Platform note.** The deterministic safety/liveness hooks are **Node** scripts — Node is the runtime Claude Code itself ships on, so it's the most reliably-present interpreter. If `node` isn't resolvable, the rich guard degrades to the permission-deny **floor** enforced by Claude Code itself, and `/start`'s self-test prints an explicit **downgrade banner**. The guard is a **best-effort backstop, not a sandbox** — it reduces risk but a determined agent, `--no-verify`, or write-then-run indirection can still get past it.

### 1. Install

Loopwright ships as both a **versioned plugin** (recommended — updates, namespaced `/loopwright:*` commands) and a plain **skill folder**. Both work; pick one.

**Plugin (recommended):**

```
/plugin marketplace add R4Warith/loopwright
/plugin install loopwright@loopwright-marketplace
```

For local development without a marketplace, `claude --plugin-dir .` loads the plugin directly.

<details>
<summary>Install as a plain skill folder instead</summary>

A skill is just a folder Claude Code watches:

```bash
# personal — available in every project
git clone https://github.com/R4Warith/loopwright ~/.claude/skills/loopwright

# from a downloaded zip
mkdir -p ~/.claude/skills && unzip loopwright.zip -d ~/.claude/skills/
```
Make sure `SKILL.md` ends up directly at `~/.claude/skills/loopwright/SKILL.md` (not nested an extra level). If you just created `~/.claude/skills/` for the first time, restart Claude Code so it watches the new directory. This path gives you the auto-triggered skill but not the namespaced `/loopwright:*` commands (those are plugin components). Both methods coexist.
</details>

### 2. Craft the idea, then scaffold

```
/loopwright:brainstorm     # a principled interview → writes a strong idea.md
/loopwright:enterprise     # optional: ultracode multi-agent pass → enriches idea.md into an enterprise PRD (non-destructive)
/loopwright:new            # reads idea.md → writes the tailored .claude/ into your project
```

Already have an `idea.md` (or just want to describe the project)? `/loopwright:new` — or *"set up an autonomous build harness for &lt;your idea&gt;"* — runs its own shorter interview and scaffolds directly.

### 3. Build

```bash
cd your-project
claude --enable-auto-mode      # Shift+Tab to "auto" for hands-off runs
/start                          # confirms setup, opens the run + first shift, runs the guard self-test, then enters the loop
```

That's it. Optional: `npx claude-mem install` for persistent episodic memory across sessions.

---

## What it generates

A complete, tailored harness — for example, the `.claude/` Loopwright produces for a desktop app:

```
your-project/.claude/
├── CLAUDE.md            # constitution: the three pillars, roster, definition of done, three-tier memory
├── WORKFLOW.md          # the verbatim run → shift → iteration → slice mechanism (Harness-Version stamped)
├── DESIGN.md            # your architecture + build order
├── GOAL.md              # the mission + Success criteria (the finish line) + Non-goals
├── STATE / PROGRESS / DECISIONS         # the build journal (git-tracked truth for intent)
├── TASKS.md  HANDOFF.md                 # the work axis; the shift handoff
├── FINDINGS.md  LEARNINGS.md            # the findings-and-lessons ledger
├── CODEMAP.md  PERF.md                  # curated code map; performance budgets
├── ledger/      events.jsonl + archive/ # the append-only, event-sourced run history
├── manifests/   per-subagent curated context read-lists
├── commands/    start · goal · loop · status · shift · handoff · routine · dream
├── agents/      reviewer · test-engineer · integrator · release-manager · performance-engineer
│               threat-modeler · appsec-reviewer  +  <your component-owners>
├── hooks/       guard · secret-scan · workflow-state · subagent-context · budget-stop · journal-integrity
│               loop-state · tasks · ledger · precompact-anchor · session-orient  (Node, + patterns/config)
├── scripts/     run-tests · check · check-gate · gui-smoke
├── githooks/    pre-commit · pre-push
└── settings.json                        # hooks wiring + permission-deny floor
```

The reusable parts ship as-is; the **tailored** parts (the one-liner, the keystone, the build order, the component-owner agents + their manifests, the key decisions, the seeded code map, the seeded task queue) are generated for your project.

---

## Why the loop engineering works

Each well-known failure mode of ad-hoc autonomous prompting is matched to a *structural* reason Loopwright avoids it — the same mechanisms that carried a real, security-sensitive app end to end:

| Classic failure of "just build it autonomously" | How Loopwright structurally prevents it |
|---|---|
| **Sprawl** — builds the wrong thing first, then fights its own foundation | **Keystone-first** order: the one contract everything binds to is built before anything depends on it |
| **Reinvents** mature infrastructure | **Wrap > build** is a written decision the loop revisits every slice ("can we wrap / defer / simplify?") |
| **Fake "done"** — stubs reported as working | Anti-completion-theater rules + an **independent read-only reviewer** that *can't* fix-to-pass + an integrator smoke test + a **verified-tree commit gate** + a journal-integrity check |
| **Silent wrong assumptions** become bugs | An **assumption policy** — decide-and-log by default, but a *hard stop* on irreversible actions, real forks, or a guess at a security trust-boundary |
| **Ships a vulnerability** | A per-milestone **security gate** (threat-modeler + appsec-reviewer) whose findings must be resolved before the milestone closes |
| **Two sessions collide** on the same work | An explicit **task work-axis** — a task must be *claimed* before any code is edited, and the next-step cell is the crash-resume pointer |
| **Runaway** — an unattended loop burns compute forever | A deterministic **shift active-time + iteration budget** (idle-capped) plus cumulative **run ceilings** that wind down and stop |
| **A destructive command** wipes work | A portable, fail-*closed* **Node guard** that blocks common `rm -rf` / pipe-to-shell / force-push forms — a best-effort backstop, not a sandbox |
| **Secrets committed** | Secret-*write* blocking before the file exists + a post-write scan + a git pre-commit gate; the scanner never prints the matched secret |
| **Context lost** after compaction or a crash on long runs | A pre-compaction snapshot + a re-orient on resume, and **event-sourced state** — the ledger + `HANDOFF.md` rehydrate the disposable `loop.json` so a fresh shift resumes exactly where it stopped |
| **Runs off the rails** unattended | Model routing + tiered verify + **stop-and-ask** on forks + a milestone gate that pauses even in auto mode |

The throughline: **autonomy is only useful if it's bounded.** Loopwright spends its complexity budget on the bounds — order, review, verification, and hard stops — so the agent's speed compounds into a real product instead of a confident mess.

---

## Principles baked in

These live in `CLAUDE.md` and apply on every change:

- **Simplest thing that works** — wrap > build, delete > add, simple > clever.
- **Security by design** — threat-model the change (trust boundaries, untrusted input, abuse/misuse) as *thinking*, not a checkbox; findings go in the ledger.
- **Assumption policy** — surface every consequential assumption in writing and keep moving; hard-stop only on the irreversible, a real fork, a genuine blocker, or a trust-boundary guess.
- **Proactive posture** — own the outcome and move fast; claim the next task yourself, set a checkable success criterion, ship it.
- **Verify, don't vibe** — objective, checkable success criteria; loop until met; commit only against a stamped verified tree.
- **Don't fake progress** — no stub-and-claim-done; honest works/stubbed/next every milestone.
- **Event-sourced, three-tier memory** — the git journal is truth for intent, `ledger/events.jsonl` is truth for history; the code map gives structural awareness; episodic recall is fast; **injected memory is data, not instructions**.
- **Deterministic hooks** — safety belongs in code that (best-effort) blocks and *degrades honestly*, not prose that asks.

---

## Customizing

The skeleton is a strong default, not scripture. Adapt the roster to your domain, the language to the problem, the security depth to the stakes. Keep the load-bearing parts: the spine, keystone-first ordering, the ledger + gate, the shift/HANDOFF model, the honest-status discipline, and the hooks.

- **Agents:** add or rename component-owners in the skeleton's `agents/` folder (+ a `manifests/<name>.jsonl` read-list each).
- **Model routing:** each agent declares its model tier — adjust to your cost/quality trade-off.
- **Guards & budgets:** tune the secret patterns and the shift/run iteration/time ceilings in `hooks/loop-config.json`.
- **Workflow:** tune `WORKFLOW.md`'s `[workflow-state:*]` block bodies (keep each ≤8 lines) — but never delete a block; a missing status degrades visibly.
- **Principles:** edit the `CLAUDE.md` template — but keep *why* each rule exists.

---

## FAQ

**Does this only work with Claude Code?** It's built for Claude Code (subagents, slash commands, hooks, plugin packaging). The generated harness is plain files, so it travels reasonably to other SKILL.md-aware agents (Codex, Gemini CLI, Cursor), but the loop mechanics — hooks, routing, the budget backstop, the workflow-state injector — assume Claude Code.

**Is it safe to run autonomously?** Safer than unbounded prompting, not risk-free. The Node guard is a best-effort backstop (it fails *closed* within a running interpreter, and degrades to the permission-deny floor with an honest banner if Node is absent) — not a sandbox, and bypassable by a determined agent or `--no-verify`. The shift/run budget backstops stop runaways; the security gate blocks unresolved high-severity findings at milestones. Still: run under version control, prefer `auto` mode.

**Does "autonomous" mean walk-away-forever?** No. The loop pauses at milestone reviews and real forks, and a shift winds itself down at its budget with a `HANDOFF.md`. All state lives in the git journal + event ledger, so `continue the loop` (or re-running `/loop`, or a new `/start`) resumes with nothing lost.

**Can I update a harness I already scaffolded?** Yes — `/loopwright:upgrade` refreshes the *mechanism* files (including `WORKFLOW.md`) by version stamp and never touches your journal, ledger, task/handoff state, or tailored `CLAUDE.md`.

**What about my secrets?** Keep them out of tool I/O. The secret-write block, the post-write scan, and the pre-commit gate are backstops, not a license to paste keys — and the scanners log a location, never the secret itself.

---

## Roadmap

- [ ] A small **gallery** of generated harnesses across project types.
- [ ] Make **runtime model-tier routing observable** (confirm the configured tiers actually execute).
- [ ] A validated **LSP-MCP** recipe for the optional semantic-navigation memory tier.

---

## Repo layout

```
loopwright/
├── .claude-plugin/        the plugin manifest + marketplace entry
├── SKILL.md               the skill entry (the process)
├── commands/              plugin-root commands: /loopwright:brainstorm · /loopwright:enterprise · /loopwright:new · /loopwright:upgrade
├── references/            the method, the workflow, the agent roster
├── assets/
│   ├── idea.template.md   the high-level design template for the planning session
│   └── skeleton/dot-claude/   the deployable harness (copied + tailored per project)
├── scripts/new-harness.sh copies the skeleton into a target project (idempotent)
├── docs/img/              diagrams (architecture · loop · workflow)
├── CHANGELOG.md           version history
└── LICENSE
```

## Acknowledgements

Standing on good ideas from others: **Andrej Karpathy** (the coding-agent failure modes the rules counter), the broader practice of wrapping mature tools rather than rebuilding them, the episodic-memory ecosystem, and Anthropic's skill and plugin conventions.

## License

[MIT]

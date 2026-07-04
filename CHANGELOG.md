# Changelog

All notable changes to the **Loopwright plugin** are documented here. Versioning follows
[Semantic Versioning](https://semver.org).

This file tracks two *deliberately decoupled* version identities:

- **Plugin version** (`.claude-plugin/plugin.json`'s `version`) — what build of the *scaffolding
  tool* you have. Controls `/plugin update` semantics.
- **Harness-Version** (the `Harness-Version:` line stamped into every *generated* project's
  `.claude/CLAUDE.md`, and carried in `WORKFLOW.md`'s header) — what contract shape that deployed
  project's `.claude/` conforms to. Survives independently of the plugin, travels with the
  project's own git history. Read by `/loopwright:upgrade` as the drift anchor.

A plugin version bump does **not** necessarily change the Harness-Version — e.g. a copy-editing
pass on `references/blueprint.md` can ship as plugin `3.0.1` while the stamped `Harness-Version`
stays `3.0`. The table below is the greppable map between the two.

## Harness-Version compatibility

| Harness-Version | First shipped in plugin | Notes |
|---|---|---|
| 2.0 | 2.0.0 | SP1 ledger (GOAL/STATE/PROGRESS/DECISIONS/FINDINGS/LEARNINGS/CODEMAP/PERF) + the three constitution pillars (assumption policy, security-by-design, proactive posture) + the `Harness-Version: 2.0` stamp itself. |
| 3.0 | 3.0.0 | Event-sourced run ledger (`ledger/events.jsonl`) + operator **shifts** with `HANDOFF.md` continuity + the `WORKFLOW.md` run→shift→iteration→slice mechanism with the every-turn `workflow-state` injector + the `TASKS.md` work-axis + curated `manifests/` subagent context + the verified-tree commit gate + the shift/run budget model. Adds hooks `ledger.mjs` / `tasks.mjs` / `workflow-state.mjs` / `subagent-context.mjs`; adds the `/shift`, `/handoff`, `/routine` commands. |

## [3.1.0] — 2026-07-05

Plugin-only feature; **Harness-Version stays `3.0`** (this command operates on `idea.md` before any
scaffold — it never touches the generated `.claude/` contract).

### Added
- **`/loopwright:enterprise`** — a new plugin-root command that deepens an existing `idea.md` into a
  comprehensive, **enterprise-grade PRD**. It walks the *entire* file (every `##` section + every
  `Mx` milestone, in order, skipping nothing) and enriches each with in-depth **features / style /
  system design**. It is an **ultracode** (multi-agent) command: the orchestrating session runs on
  **Opus 4.8** and fans out one questionnaire-author **Sonnet-5** worker per unit (each returns a
  schema-validated deep questionnaire — 2–3 options + a recommendation per question, threads 3–4
  levels deep). The main session then interviews the user unit-by-unit (`AskUserQuestion`, house
  brainstorm style), summarizes, and **installs the answers non-destructively** back into `idea.md`
  (snapshot to `idea.md.bak` first; insert-only, every original line preserved). Sits between
  `/loopwright:brainstorm` and `/loopwright:new` in the pipeline; optional.
- Pipeline references updated across `SKILL.md` and `README.md`:
  `/loopwright:brainstorm` → `/loopwright:enterprise` *(optional)* → `/loopwright:new` → `/start`.

## [3.0.0] — 2026-07-04

The v3 build. The scaffolding tool and the shipped harness both move to `Harness-Version: 3.0`.
Where v2 kept loop state as a set of journal docs + a single `loop-state` counter, v3 makes the
loop's structure explicit, event-sourced, and crash-durable.

### Added
- **Event-sourced run ledger.** `assets/skeleton/dot-claude/ledger/events.jsonl` is the
  append-only source of truth for *history* (run/shift/slice/approval events), merged union-safe
  via a `.gitattributes` `merge=union` rule and rotated to `ledger/archive/`. The former
  `loop.json` becomes a git-ignored disposable cache rehydrated from the ledger — deleting it
  loses nothing. New hook `hooks/ledger.mjs`.
- **Operator shifts + `HANDOFF.md`.** A shift is one operator + one budget envelope, ending in
  exactly one authored `HANDOFF.md`; it survives `/clear`, compaction, and crashes, and the next
  shift reads the handoff first. New commands `/shift` (open/close) and `/handoff` (author +
  wind-down). Wind-down is `--record-handoff --kind authored` + `--end-shift --reason <r>`; re-arm
  is always a *new* shift.
- **`WORKFLOW.md` — the verbatim run→shift→iteration→slice mechanism.** New hook
  `hooks/workflow-state.mjs` parses its `[workflow-state:*]` blocks and injects the one matching
  the current status **every turn** with an exact-resume pointer; there is no fallback dict in
  code, so a deleted/renamed block degrades *visibly*. `WORKFLOW.md` carries the `Harness-Version`
  stamp and is upgrade-refreshable.
- **`TASKS.md` work-axis.** New hook `hooks/tasks.mjs` — tasks move through a strict lifecycle
  (queued → planning → in_progress → verifying → committing → done, + blocked/dropped) and a task
  must be *claimed* before any code is edited. The scaffolder seeds the first milestone's queue.
- **Curated subagent context (`manifests/`).** New hook `hooks/subagent-context.mjs` prepends a
  per-`subagent_type` read-list (`manifests/<type>.jsonl` — paths + reasons, never inlined
  content) to every Task dispatch. Ships seeds for `reviewer` / `test-engineer` / `integrator`;
  each new component-owner gets a matching manifest.
- **Verified-tree commit gate.** A slice is committed only against a stamped `git write-tree`
  (`--set-verified-tree`); a tree that drifted since verify is refused and re-verified, so "done"
  can't diverge from what was tested.
- **Shift + run budget model.** `hooks/loop-config.json` now carries per-shift ceilings
  (active-time, idle-capped, + iterations) and cumulative per-run ceilings, plus milestone-gate
  TTL/`gate_block_max` for a clean headless convergence, session-lease staleness, ledger rotation,
  and a `/routine` menu. `budget-stop.mjs` meters both scopes and posts the shift/run wind-down.
- `/loopwright:upgrade` now diffs `WORKFLOW.md` as a mechanism file, and excludes the new tailored/
  append-only state (`TASKS.md`, `HANDOFF.md`, `ledger/`, `manifests/`) from any diff or overwrite.

### Changed
- `SKILL.md`, `README.md`, and the `references/` (blueprint · workflow · agent-roster ·
  worked-example) now describe the v3 run/shift/iteration/slice model — the ledger, shifts +
  HANDOFF, the workflow-state keystone, the task axis, and curated manifests — replacing v2's
  single-loop framing.
- Step 4 of the scaffold materializes the v3 file set: fills `TASKS.md`; leaves `WORKFLOW.md`,
  `ledger/`, and `manifests/` seeds verbatim; confirms `Harness-Version: 3.0`.
- `scripts/new-harness.sh` recursively copies the whole skeleton tree (so it tracks the real file
  set, including `WORKFLOW.md`, `ledger/`, and `manifests/`), and chmods `scripts/`, `githooks/`,
  and the `.mjs` hooks.
- The generated project's command set is now `/start` · `/goal` · `/loop` · `/status` · `/shift` ·
  `/handoff` · `/routine` · `/dream` (v2's `/start`·`/goal`·`/loop`·`/status`·`/dream` + the new
  `/shift`·`/handoff`·`/routine`).

## [2.0.0] — 2026-07-01

Initial release of Loopwright v2 as a versioned Claude Code plugin (SP-pkg), packaging the full v2
build (SP1 keystone ledger/versioning, SP1.5 portable hooks, SP2 AppSec agents, SP3 loop
efficiency, SP4 bounded autonomy, SP5 dream/reflection, SP6 hardening/idempotency, SP-mem
three-tier memory).

### Added
- `.claude-plugin/plugin.json` — the plugin manifest (verified schema: `name` required;
  `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`,
  `keywords`, `defaultEnabled` all present). Explicit semver `2.0.0`, decoupled from but
  cross-referenced against `Harness-Version: 2.0`.
- `commands/new.md` and `commands/upgrade.md` at the plugin root — `/loopwright:new` and
  `/loopwright:upgrade`, the skill's own explicit entry points (distinct from the un-namespaced
  `/start`/`/goal`/`/loop`/`/status`/`/dream` commands the skill stamps out into a *target*
  project's `.claude/commands/`, which are never plugin components).
- `/loopwright:upgrade` — a `Harness-Version`-keyed diff/upgrade path:
  reads a deployed harness's stamp, compares it to the installed plugin's current skeleton,
  diffs only mechanism files (`CLAUDE.md`, `commands/`, spine `agents/`, `hooks/`, `scripts/`,
  `githooks/`, `settings.json`), and never touches journal/ledger files
  (`GOAL.md`/`STATE.md`/`PROGRESS.md`/`DECISIONS.md`/`FINDINGS.md`/`LEARNINGS.md`/`CODEMAP.md`),
  `DESIGN.md`, or component-owner agents.
- `scripts/new-harness.sh` now resolves the skeleton via `${CLAUDE_PLUGIN_ROOT}` when running
  from the installed plugin cache, falling back to its previous relative-path resolution when
  invoked from a dev/sandbox checkout. SP6's idempotency behavior (default-refuse / `--backup` /
  `--force`) is unchanged.
- `.claude-plugin/marketplace.json` — a self-hosted marketplace entry (`source: "."`) for
  personal/team distribution via `/plugin marketplace add` + `/plugin install`.
- README.md — plugin-install instructions alongside the existing git-clone method.

### Unchanged (explicitly, per SP-pkg's scope)
- `SKILL.md` at the plugin root — still the single-skill entry point, still triggers on
  natural-language description of an autonomous-build intent, unchanged content.
- `assets/skeleton/dot-claude/` — the harness the skill stamps out. Not a plugin component
  (outside the auto-discovery paths `skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
  `.mcp.json`, `.lsp.json`), so nothing here collides with the plugin's own namespace.
- Hook internals, security-agent content, and loop mechanics (owned by SP1.5/SP2/SP3-SP6
  respectively) — SP-pkg is packaging and distribution only.

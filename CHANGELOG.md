# Changelog

All notable changes to the **Loopwright plugin** are documented here. Versioning follows
[Semantic Versioning](https://semver.org).

This file tracks two *deliberately decoupled* version identities:

- **Plugin version** (`.claude-plugin/plugin.json`'s `version`) — what build of the *scaffolding
  tool* you have. Controls `/plugin update` semantics.
- **Harness-Version** (the `Harness-Version:` line stamped into every *generated* project's
  `.claude/CLAUDE.md`) — what contract shape that deployed project's `.claude/` conforms to.
  Survives independently of the plugin, travels with the project's own git history. Read by
  `/loopwright:upgrade` as the drift anchor.

A plugin version bump does **not** necessarily change the Harness-Version — e.g. a copy-editing
pass on `references/blueprint.md` can ship as plugin `2.0.1` while the stamped `Harness-Version`
stays `2.0`. The table below is the greppable map between the two.

## Harness-Version compatibility

| Harness-Version | First shipped in plugin | Notes |
|---|---|---|
| 2.0 | 2.0.0 | SP1 ledger (GOAL/STATE/PROGRESS/DECISIONS/FINDINGS/LEARNINGS/CODEMAP/PERF) + the three constitution pillars (assumption policy, security-by-design, proactive posture) + the `Harness-Version: 2.0` stamp itself. |

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

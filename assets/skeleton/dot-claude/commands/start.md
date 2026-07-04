---
description: Set up and start the autonomous build in one go — first-time setup, open the run, enter the loop.
allowed-tools: Read, Edit, Bash(git init:*), Bash(git config:*), Bash(chmod:*), Bash(node:*)
---
First-time setup (idempotent — safe to re-run):
1. If this isn't a git repo yet, run `git init` (recommended). Then wire the optional git-layer safety hooks: `git config core.hooksPath .claude/githooks` and `chmod +x .claude/githooks/* .claude/hooks/*.sh .claude/scripts/*.sh` (harmless if some globs match nothing). The Claude Code hooks in `.claude/settings.json` are already active regardless.
2. **Guard self-test (deterministic safety layer).** Run `node .claude/hooks/guard.mjs --selftest`.
   - **If it exits 0 (all vectors pass):** the deterministic guard is active. You may state that a best-effort deterministic guard is protecting Bash calls in this session — but always phrase it as a **best-effort backstop, not a sandbox**. Never claim it's a "physical wall," a sandbox, or that it "fires in every mode."
   - **If it exits non-zero, or `node` is not on PATH / fails to launch:** print this exact downgrade banner and do not claim more protection than is actually active:
     > Deterministic guard INACTIVE on this environment — only the `permissions.deny` floor is protecting this session. This is a best-effort backstop, not a sandbox.
     Then offer the remediation: install/enable Node (v18+), and re-run `/start` once available. The `permissions.deny` entries in `.claude/settings.json` still apply regardless (Claude Code enforces them, not this script), but that floor is glob-prefix matching, not tokenized — acknowledge it's leaky, not a substitute for the guard.
3. Note the environment (OS, language toolchain present) and anything the project needs to run locally.
4. Confirm or change the language in `.claude/DECISIONS.md` (D2) before any keystone code is generated — ask me if unsure.
5. **SAST/SCA coverage.** Check for `semgrep` + the stack's dependency auditor (e.g. `cargo-audit`, `pip-audit`, `npm audit`); install them, or record their absence as an `accepted` `F#` row in `.claude/FINDINGS.md` so a milestone can't pass reporting "scanned-clean" with SAST/SCA dark.

Then open the run:
6. **Start the run:** `node .claude/hooks/loop-state.mjs --init` — this appends `run_started`, opens shift **s-001** (operator resolved from `--operator`/`$LOOPWRIGHT_OPERATOR`/`git config user.name`), and writes `.claude/loop.json`. If it prints "already exists," the run is already open — skip to step 7. (Pass `--operator <name>` to name the first operator explicitly.)
7. Confirm state is sane: `node .claude/hooks/loop-state.mjs --doctor`.

Then build:
8. Lock the mission (run the steps in `/goal`) and enter the autonomous loop (run `/loop`). Start with the **keystone** — the first scope in the build order, the one contract everything else binds to. Don't stop between slices; pause only for an irreversible action, a real fork, or a genuine blocker.

You're the lead engineer + PM: dispatch the specialist subagents in `.claude/agents/`, keep changes simple and surgical, verify before committing, keep commits clean, and prove each slice works in the actual build. Build something worth running.

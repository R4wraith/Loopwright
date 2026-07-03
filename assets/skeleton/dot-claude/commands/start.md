---
description: Set up and start the autonomous build in one go.
allowed-tools: Read, Edit, Bash(git init:*), Bash(git config:*), Bash(chmod:*), Bash(node:*)
---
First-time setup (idempotent — safe to re-run):
1. If this isn't a git repo yet, run `git init` (recommended). Then wire the optional git-layer safety hooks: `git config core.hooksPath .claude/githooks` and `chmod +x .claude/githooks/* .claude/hooks/*.sh .claude/scripts/*.sh`. (The Claude Code hooks in .claude/settings.json are already active regardless.)
2. **Guard self-test (deterministic safety layer).** Run `node .claude/hooks/guard.mjs --selftest`.
   - **If it exits 0 (all vectors pass):** the deterministic guard is active. You may state that a
     best-effort deterministic guard is protecting Bash calls in this session — but always phrase it
     as a **best-effort backstop, not a sandbox**. Never claim it's a "physical wall," a sandbox, or
     that it "fires in every mode."
   - **If it exits non-zero, or `node` is not on PATH / fails to launch:** print this exact downgrade
     banner and do not claim more protection than is actually active:
     > Deterministic guard INACTIVE on this environment — only the `permissions.deny` floor is
     > protecting this session. This is a best-effort backstop, not a sandbox.
     Then offer the remediation: install/enable Node (v18+), and re-run `/start` once available. The
     `permissions.deny` entries in `.claude/settings.json` still apply regardless (they're enforced by
     Claude Code itself, not by this script), but that floor is glob-prefix matching, not tokenized —
     acknowledge it's leaky, not a substitute for the guard.
3. Note the environment (OS, language toolchain present) and anything the project needs to run locally.
4. Confirm or change the language in .claude/DECISIONS.md (D2) before any keystone code is generated — ask me if unsure.
5. **SAST/SCA coverage (SP7/F1).** Check for `semgrep` + `cargo-audit`; install them, or record their absence as an `accepted` `F#` row in FINDINGS so a milestone can't pass reporting "scanned-clean" with SAST/SCA dark.

Then build:
6. Lock the mission (run the steps in `/goal`) and enter the autonomous loop (run `/loop`). Start with the **keystone** — the first scope in the build order, the one contract everything else binds to. Don't stop between slices; pause only for an irreversible action, a real fork, or a genuine blocker.

You're the lead engineer + PM: dispatch the specialist subagents in .claude/agents/, keep changes simple and surgical, verify before merging, keep commits clean, and prove each slice works in the actual build. Build something worth running.

---
description: Diff a deployed .claude/ harness's mechanism files against the current plugin skeleton by Harness-Version, and let the user accept updates (F26).
argument-hint: "(optional: target project directory, default is the current directory)"
allowed-tools: Read, Bash(diff:*), Bash(grep:*), AskUserQuestion
---

# /loopwright:upgrade

Run this **inside a target project** that already has a deployed `.claude/` from an earlier
Loopwright scaffold. It closes audit finding **F26**: a deployed harness can (a) tell it's stale by
reading its own version stamp, and (b) get an explicit, reviewable upgrade path instead of silent
drift or a blind re-scaffold.

Target project directory: `$ARGUMENTS` if given, else the current working directory. Its
harness is expected at `<target>/.claude/`.

## What this command does NOT touch

**Never** read-diffs-and-overwrites, and never even proposes changes to, the project's journal /
ledger files — these are append-only project history, not scaffolding output — **plus
`CLAUDE.md`**, which is a *tailored*, filled-in file (not shipped verbatim):

```
GOAL.md  STATE.md  PROGRESS.md  DECISIONS.md  FINDINGS.md  LEARNINGS.md  CODEMAP.md  CLAUDE.md
```

`CLAUDE.md` is protected from overwrite for two reasons: (1) `/loopwright:new` fills it with
project-specific, non-`{{PLACEHOLDER}}` content (`{{PROJECT_NAME}}`, `{{ONE_LINE}}`, tailored
principles wording) that a raw skeleton copy would clobber, reintroducing raw `{{...}}` tokens or
erasing the user's tailoring; and (2) it carries the `Harness-Version:` stamp this very command
reads to decide staleness — never something this command diffs or writes. The **only** thing
`/loopwright:upgrade` ever does with `CLAUDE.md` is *read* its `Harness-Version:` line (step 1 below).
It is never diffed against the skeleton and never offered for whole-file accept/reject, even if
the constitution prose changed between versions — see step 4a for what happens instead.

Also excluded from the diff: `DESIGN.md`, `GOAL.md` (already listed above), any component-owner
agent file (`agents/<name>.md` that isn't one of the seven spine agents), and any file whose
content still contains a filled-in (non-`{{PLACEHOLDER}}`) project-specific value — these were
*tailored* for this project by `/loopwright:new`, not shipped verbatim, so a fresh skeleton copy is
never the right answer for them.

Only **mechanism** files — the truly verbatim set from `SKILL.md`'s Step 4 — are ever diffed or
offered for whole-file update: `commands/`, the seven spine agents in `agents/` (`reviewer`,
`test-engineer`, `integrator`, `release-manager`, `performance-engineer`, `appsec-reviewer`,
`threat-modeler`), `hooks/`, `scripts/`, `githooks/`, and `settings.json`. **`CLAUDE.md` is never
in this set** — see above. To be unambiguous: CLAUDE.md is never a mechanism file, never diffed,
and never overwritten by this command; it is read-version-only.

## Steps

1. **Read the target's stamp.** Read `<target>/.claude/CLAUDE.md` and extract *only* the
   `Harness-Version:` line (the SP1 drift anchor). Do not treat any other part of this read as
   diffable content — this is a version-stamp read, not a preview of a future overwrite. If the
   file or the line is missing, tell the user this doesn't look like a Loopwright-scaffolded
   `.claude/` and stop.
2. **Read the plugin's current stamp.** Read
   `${CLAUDE_PLUGIN_ROOT}/assets/skeleton/dot-claude/CLAUDE.md` and extract its own
   `Harness-Version:` line — this is what a fresh `/loopwright:new` would stamp today. Again, this is
   a version-stamp read only; the skeleton's `CLAUDE.md` body is never proposed as a replacement
   for the target's tailored `CLAUDE.md`.
3. **Compare.**
   - **Equal** → report "up to date" (harness version matches the installed plugin's current
     skeleton contract) and stop. This is a no-op; no files are touched.
   - **Target is behind** → continue to step 4.
4. **Diff, never overwrite — mechanism files only.** For each mechanism file/dir listed above
   (the verbatim set: `commands/`, spine `agents/`, `hooks/`, `scripts/`, `githooks/`,
   `settings.json`) that exists in both the target and the plugin skeleton, run something
   equivalent to:
   ```
   diff -u "<target>/.claude/<path>" "${CLAUDE_PLUGIN_ROOT}/assets/skeleton/dot-claude/<path>"
   ```
   Skip (never diff, never touch) anything under the excluded list above — journal/ledger files,
   `CLAUDE.md`, `DESIGN.md`, component-owner agents, and any file carrying filled-in
   project-specific content. Present each non-empty diff to the user.
4a. **`CLAUDE.md` advisory note, not a diff/accept.** If the plugin's skeleton `CLAUDE.md` prose
   changed between the target's stamped `Harness-Version` and the plugin's current one (per
   `CHANGELOG.md`), surface this as a plain-prose **advisory note** listing what changed in the
   constitution — never a `diff -u` block, and never an `AskUserQuestion` accept/reject like the
   mechanism files get. Tell the user this is theirs to hand-merge into their tailored
   `CLAUDE.md` at their own discretion; this command will not touch the file.
5. **Ask, don't auto-apply.** For each *mechanism* file with a real diff, ask the user (via
   `AskUserQuestion` where available; otherwise ask in plain prose — same fallback note as
   `/loopwright:new`) whether to accept the plugin's current version for that file. Apply only the
   files the user explicitly accepts. Never batch-apply without per-file confirmation, and never
   touch a file outside the mechanism set — including `CLAUDE.md` — even if the user says "just
   update everything."
6. **Report.** Summarize what was updated, what was left as-is, and remind the user that
   `Harness-Version` in their `CLAUDE.md` reflects the *harness contract shape*, not this plugin's
   own release version — bumping one doesn't require bumping the other (see `CHANGELOG.md`'s
   compatibility table). Repeat that `CLAUDE.md` itself was never overwritten and any constitution
   prose changes noted in step 4a are theirs to hand-merge.

---
**Namespace note:** see `commands/new.md` for why this command's own namespacing
(`/loopwright:upgrade`) never collides with the target project's un-namespaced `/start`/`/goal`/
`/loop`/`/status`/`/dream` commands, which are plain files in the *target* project's
`.claude/commands/`, not plugin components.

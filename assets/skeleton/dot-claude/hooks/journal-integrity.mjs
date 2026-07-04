#!/usr/bin/env node
// SP4 journal-integrity.mjs — PostToolUse(Bash) hook (F9).
//
// After any Bash call, check whether a NEW commit landed (HEAD advanced past
// loop.json's last_commit_sha). If it did and the commit touched neither
// .claude/STATE.md nor .claude/PROGRESS.md, emit a "don't fake progress" advisory
// (Constitution) — `decision:"block"` on PostToolUse surfaces the reason to Claude
// (the tool already ran; this cannot undo it), nudging a journal update rather than
// hard-failing. `last_commit_sha` is intentionally NOT advanced past a dirty commit —
// the advisory keeps re-firing on subsequent Bash calls until a later commit's diff
// range includes a STATE/PROGRESS touch, at which point the whole range is considered
// caught up and the watermark jumps to the new HEAD.
//
// Different matcher (Bash) from SP1.5's secret-scan.mjs (Edit|Write|MultiEdit) — the
// two PostToolUse entries in settings.json do not interfere with each other.
//
// Fail-safe: not a git repo, git not on PATH, or any internal error => log to stderr
// and exit 0 (no-op). A hook bug must not break every Bash call in the session.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readState, writeState } from './loop-state.mjs';

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

const JOURNAL_FILES = ['STATE.md', 'PROGRESS.md'];

/** True if `sha` looks like a real (abbreviated or full) git commit hash: lowercase hex,
 * 7-40 chars. `last_commit_sha` comes from loop.json — machine-only state, but state a
 * SIGKILL, manual edit, or a bug elsewhere could leave in an attacker-influenced shape
 * (e.g. `--upload-pack=/bin/sh`, an option-injection attempt). Validating BEFORE it is
 * ever interpolated into a git argv means an option-shaped value never reaches git at
 * all, rather than relying on git itself to reject it as an unrecognized flag. */
export function isValidSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha);
}

/** True if any of `paths` (git-relative, forward or back slashes) names STATE.md or
 * PROGRESS.md (matched by suffix, so `.claude/STATE.md` and bare `STATE.md` both hit). */
export function changedPathsTouchJournal(paths) {
  if (!paths || !paths.length) return false;
  return paths.some((p) => {
    const norm = String(p).replace(/\\/g, '/');
    return JOURNAL_FILES.some((j) => norm === j || norm.endsWith(`/${j}`));
  });
}

// ---------------------------------------------------------------------------
// Paths / git plumbing
// ---------------------------------------------------------------------------

function here() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function claudeDir() {
  return path.dirname(here());
}

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function projectDir() {
  return process.env.LOOPWRIGHT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function git(args) {
  return execFileSync('git', args, { cwd: projectDir(), encoding: 'utf8' }).trim();
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function main() {
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) { try { JSON.parse(raw); } catch { /* command detection below doesn't need the payload */ } }
  } catch { /* ignore */ }

  let currentHead;
  try {
    currentHead = git(['rev-parse', 'HEAD']);
  } catch (e) {
    process.stderr.write(`journal-integrity: not a git repo (or git unavailable), no-op: ${e.message}\n`);
    process.exit(0);
    return;
  }

  try {
    const ljPath = loopJsonPath();
    const state = readState(ljPath);

    if (state.last_commit_sha === currentHead) {
      process.exit(0); // no new commit since last check
      return;
    }

    if (!state.last_commit_sha || !isValidSha(state.last_commit_sha)) {
      // First time we've seen this repo (no watermark yet) — nothing to diff against.
      // Also: a `last_commit_sha` that doesn't look like a real hex sha (e.g. corrupt
      // state, or an option-injection-shaped value like `--upload-pack=/bin/sh`) is
      // treated as untrusted and never interpolated into a git argv — bootstrap the
      // watermark to HEAD instead, same as the "never seen this repo" case, rather than
      // flagging pre-existing history or handing git an attacker-influenced argument.
      if (state.last_commit_sha && !isValidSha(state.last_commit_sha)) {
        process.stderr.write(`journal-integrity: last_commit_sha "${state.last_commit_sha}" is not a valid sha, bootstrapping instead of diffing\n`);
      }
      writeState(ljPath, { ...state, last_commit_sha: currentHead, journal_dirty: false });
      process.exit(0);
      return;
    }

    let changed;
    try {
      const diffOut = git(['diff', '--name-only', `${state.last_commit_sha}..${currentHead}`]);
      changed = diffOut ? diffOut.split('\n').filter(Boolean) : [];
    } catch (e) {
      // last_commit_sha unknown to this repo (e.g. history rewritten) — bootstrap
      // rather than crash.
      process.stderr.write(`journal-integrity: could not diff ${state.last_commit_sha}..${currentHead}, bootstrapping: ${e.message}\n`);
      writeState(ljPath, { ...state, last_commit_sha: currentHead, journal_dirty: false });
      process.exit(0);
      return;
    }

    // SP7/F6 — stale-partial-commit guard: if the loop recorded a `verified_tree_sha` at
    // its last DoD/verify pass (via `loop-state.mjs --set-verified-tree`), compare it to
    // what actually got committed. Unset => no-op (backward compatible with pre-SP7
    // loop.json). A mismatch means the committed tree drifted from what was last verified
    // — exactly the class of bug that shipped that prior run's stale-partial commit
    // (`066a52a`), which this file's STATE/PROGRESS-only check didn't catch.
    //
    // SP7 post-eval fix (F6.1) — ONE-SHOT, not sticky: `verified_tree_sha` is stamped once
    // per verified slice (loop.md's step 4/7, right before that slice's commit), so it is
    // only ever meaningful for the ONE commit that lands immediately after the stamp. Once
    // this check has run against a commit (match OR mismatch — either way it has been
    // "consumed"), clear it back to unset. Without this, the stamp stayed live forever and
    // every LATER, legitimate forward commit (a new milestone's slices — a different tree
    // by design) was diffed against a stale, months-old snapshot and wrongly flagged as
    // "stale/partial" — the guard cried wolf on ordinary forward progress instead of only
    // catching an actual stale/partial commit of the slice it was stamped for.
    let treeAdvisory = null;
    let consumeVerifiedTree = false;
    if (state.verified_tree_sha) {
      try {
        const currentTree = git(['rev-parse', `${currentHead}^{tree}`]);
        if (currentTree !== state.verified_tree_sha) {
          treeAdvisory = `committed tree ${currentTree} differs from last-verified tree ` +
            `${state.verified_tree_sha} (possible stale/partial commit).`;
        }
        consumeVerifiedTree = true; // checked (match or mismatch) — one-shot, never re-check it.
      } catch (e) {
        process.stderr.write(`journal-integrity: could not resolve tree for ${currentHead}, skipping tree check: ${e.message}\n`);
      }
    }
    const baseState = consumeVerifiedTree ? { ...state, verified_tree_sha: null } : state;

    if (changedPathsTouchJournal(changed)) {
      writeState(ljPath, { ...baseState, last_commit_sha: currentHead, journal_dirty: false });
      if (treeAdvisory) {
        block(treeAdvisory);
        return;
      }
      process.exit(0);
      return;
    }

    // Commit(s) landed touching neither STATE.md nor PROGRESS.md — advise, keep the
    // watermark where it was so this keeps re-firing until the journal catches up.
    writeState(ljPath, { ...baseState, journal_dirty: true });
    let reason = `Commit ${currentHead} landed but STATE.md/PROGRESS.md didn't advance — update the journal ` +
      `to match reality before continuing (Constitution: don't fake progress).`;
    if (treeAdvisory) reason += ` Also: ${treeAdvisory}`;
    block(reason);
  } catch (e) {
    process.stderr.write(`journal-integrity: internal error, no-op: ${e.stack || e.message}\n`);
    process.exit(0);
  }
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // See budget-stop.mjs's isMain comment: case-insensitive on Windows to avoid a
    // silent no-op from drive-letter/segment casing mismatches.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) main();

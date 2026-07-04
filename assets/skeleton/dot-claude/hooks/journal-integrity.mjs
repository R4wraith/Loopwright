#!/usr/bin/env node
// v3 journal-integrity.mjs — PostToolUse(Bash) hook (v2 F9 logic carried verbatim,
// plus the v3 ledger duties).
//
// After any Bash call, check whether a NEW commit landed (HEAD advanced past
// loop.json's last_commit_sha). If it did and the commit touched no journal file,
// emit a "don't fake progress" advisory — `decision:"block"` on PostToolUse surfaces
// the reason to Claude (the tool already ran; this cannot undo it), nudging a journal
// update rather than hard-failing. `last_commit_sha` is intentionally NOT advanced
// past a dirty commit — the advisory keeps re-firing on subsequent Bash calls until a
// later commit's diff range includes a journal touch, at which point the whole range
// is considered caught up and the watermark jumps to the new HEAD.
//
// v3 changes (§8/WP2):
//   - The journal set is now {STATE.md, PROGRESS.md, TASKS.md, HANDOFF.md, anything
//     under ledger/} — committing the ledger at Record satisfies the check instead of
//     nagging (§2.2: the ledger is part of the journal).
//   - New-HEAD detection appends `slice_committed{sha, journal_touched}` to the run
//     ledger (ONCE per new HEAD — the nag path re-fires per Bash call, so the append
//     is deduped against the ledger before writing; union merges stay idempotent).
//     The event lands BEFORE the loop.json watermark write (§2.2 ordering).
//   - Watermark bootstrap consults the ledger's last `slice_committed` BEFORE
//     forgiving: a null/invalid watermark prefers the ledger value over HEAD, so
//     deleting loop.json no longer forgives an un-journaled commit (kills v2's
//     watermark forgiveness; §2.3.5).
//
// Fail-safe: not a git repo, git not on PATH, or any internal error => log to stderr
// and exit 0 (no-op). A hook bug must not break every Bash call in the session.
// LOOPWRIGHT_HOOKS=0 disables it (exit 0 + stderr).

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readState, writeState } from './loop-state.mjs';
import { appendEvent, readLedger } from './ledger.mjs';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const JOURNAL_FILES = ['STATE.md', 'PROGRESS.md', 'TASKS.md', 'HANDOFF.md'];

/** True if `sha` looks like a real (abbreviated or full) git commit hash: lowercase hex,
 * 7-40 chars. `last_commit_sha` comes from loop.json — machine-only state, but state a
 * SIGKILL, manual edit, or a bug elsewhere could leave in an attacker-influenced shape
 * (e.g. `--upload-pack=/bin/sh`, an option-injection attempt). Validating BEFORE it is
 * ever interpolated into a git argv means an option-shaped value never reaches git at
 * all, rather than relying on git itself to reject it as an unrecognized flag. */
export function isValidSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha);
}

/** True if any of `paths` (git-relative, forward or back slashes) names a journal file
 * (matched by suffix, so `.claude/STATE.md` and bare `STATE.md` both hit) or lives
 * under a `ledger/` directory (`.claude/ledger/events.jsonl`, `ledger/archive/…`). */
export function changedPathsTouchJournal(paths) {
  if (!paths || !paths.length) return false;
  return paths.some((p) => {
    const norm = String(p).replace(/\\/g, '/');
    if (JOURNAL_FILES.some((j) => norm === j || norm.endsWith(`/${j}`))) return true;
    return norm.startsWith('ledger/') || norm.includes('/ledger/');
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

function ledgerPath() {
  return process.env.LOOPWRIGHT_LEDGER || path.join(claudeDir(), 'ledger', 'events.jsonl');
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

/** Last slice_committed sha in the ledger, or null. Also honors a rotation genesis
 * (`ledger_rotated.carried.last_commit_sha`) so a freshly rotated file still informs
 * the bootstrap. */
function lastLedgerCommitSha(events) {
  let sha = null;
  for (const ev of events) {
    if (ev.event === 'slice_committed' && ev.data && ev.data.sha) sha = ev.data.sha;
    else if (ev.event === 'ledger_rotated' && ev.data && ev.data.carried && ev.data.carried.last_commit_sha) {
      sha = ev.data.carried.last_commit_sha;
    }
  }
  return sha;
}

function main() {
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('journal-integrity: disabled (LOOPWRIGHT_HOOKS=0) — no-op\n');
    process.exit(0);
    return;
  }

  // Payload is best-effort: the decision is driven by git + loop.json; we only lift
  // session_id for ledger attribution when present.
  let sid = process.env.LOOPWRIGHT_SESSION_ID || 'cli';
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) {
      const payload = JSON.parse(raw);
      if (payload && typeof payload.session_id === 'string' && payload.session_id) sid = payload.session_id;
    }
  } catch {
    /* payload not required */
  }

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
    const ledger = ledgerPath();
    // readState with the ledger: a deleted loop.json rehydrates last_commit_sha (and
    // verified_tree_sha) from replay — un-journaled commits stay caught (§2.3.5/6).
    let state = readState(ljPath, ledger);
    const envelope = { run: state.run_id, shift: state.shift_id, session: sid, actor: 'hook:journal-integrity' };

    if (state.last_commit_sha === currentHead) {
      process.exit(0); // no new commit since last check
      return;
    }

    if (!state.last_commit_sha || !isValidSha(state.last_commit_sha)) {
      // No watermark (or one that doesn't look like a real hex sha — corrupt state or
      // an option-injection-shaped value like `--upload-pack=/bin/sh`; never
      // interpolated into a git argv). v2 forgave straight to HEAD here; v3 consults
      // the ledger's last slice_committed FIRST, so a lost loop.json no longer
      // launders an un-journaled commit.
      if (state.last_commit_sha && !isValidSha(state.last_commit_sha)) {
        process.stderr.write(`journal-integrity: last_commit_sha "${state.last_commit_sha}" is not a valid sha, consulting ledger instead of diffing\n`);
      }
      const ledgerSha = lastLedgerCommitSha(readLedger(ledger));
      if (isValidSha(ledgerSha) && ledgerSha !== currentHead) {
        process.stderr.write(`journal-integrity: watermark restored from ledger slice_committed (${ledgerSha}) — checking the range to HEAD\n`);
        state = { ...state, last_commit_sha: ledgerSha };
        // fall through to the diff below with the restored watermark
      } else {
        // Genuinely first sight of this repo (no evented commits) — bootstrap to HEAD.
        writeState(ljPath, { ...state, last_commit_sha: currentHead, journal_dirty: false });
        process.exit(0);
        return;
      }
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

    // SP7/F6 (carried verbatim) — stale-partial-commit guard: if the loop recorded a
    // `verified_tree_sha` at its last DoD/verify pass (`--set-verified-tree`), compare
    // it to what actually got committed. Unset => no-op. ONE-SHOT (F6.1): once checked
    // against a commit (match OR mismatch), clear it — otherwise every later,
    // legitimate forward commit would be diffed against a stale snapshot and wrongly
    // flagged (the cry-wolf bug).
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

    const journalTouched = changedPathsTouchJournal(changed);

    // §2.2: append slice_committed{sha, journal_touched} ONCE per new HEAD, BEFORE
    // the watermark write. The nag path leaves the watermark behind and re-detects
    // this same HEAD on every Bash call, so dedupe against the ledger (fail-soft: a
    // ledger hiccup must not break the advisory itself).
    try {
      const already = readLedger(ledger).some(
        (e) => e.event === 'slice_committed' && e.data && e.data.sha === currentHead,
      );
      if (!already) {
        appendEvent(ledger, envelope, 'slice_committed', { sha: currentHead, journal_touched: journalTouched });
      }
    } catch (e) {
      process.stderr.write(`journal-integrity: ledger append failed (non-fatal): ${e.message}\n`);
    }

    if (journalTouched) {
      writeState(ljPath, { ...baseState, last_commit_sha: currentHead, journal_dirty: false });
      if (treeAdvisory) {
        block(treeAdvisory);
        return;
      }
      process.exit(0);
      return;
    }

    // Commit(s) landed touching no journal file — advise, keep the watermark where it
    // was so this keeps re-firing until the journal catches up.
    writeState(ljPath, { ...baseState, journal_dirty: true });
    let reason = `Commit ${currentHead} landed but no journal file advanced (STATE.md/PROGRESS.md/TASKS.md/HANDOFF.md/ledger) — ` +
      `update the journal to match reality before continuing (Constitution: don't fake progress).`;
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

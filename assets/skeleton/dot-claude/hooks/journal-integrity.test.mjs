// v3 journal-integrity.test.mjs — the PostToolUse(Bash) "don't fake progress" check.
// Carries the v2 F9 pins (advisory on an un-journaled commit; watermark not advanced;
// isValidSha argv-injection guard; verified_tree stale-partial guard) AND covers the v3
// additions (§8/WP2): the journal set now includes TASKS.md/HANDOFF.md/ledger; each new
// HEAD appends ONE slice_committed{sha, journal_touched} to the ledger (deduped against
// the nag re-fire); and a lost loop.json restores its watermark from the ledger's last
// slice_committed instead of forgiving straight to HEAD (§2.3.5). Hook is driven as a
// real child process; all state lives in mkdtemp git sandboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedPathsTouchJournal, isValidSha } from './journal-integrity.mjs';
import { appendEvent, readLedger } from './ledger.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'journal-integrity.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-journal-'));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(dir, '.claude', 'ledger'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n', 'utf8');
  writeFileSync(path.join(dir, '.claude', 'PROGRESS.md'), '# PROGRESS\n', 'utf8');
  writeFileSync(path.join(dir, '.claude', 'TASKS.md'), '# Tasks\n', 'utf8');
  writeFileSync(path.join(dir, '.claude', 'HANDOFF.md'), '# HANDOFF\n', 'utf8');
  writeFileSync(path.join(dir, '.claude', 'ledger', 'events.jsonl'), '', 'utf8');
  writeFileSync(path.join(dir, 'code.txt'), 'v0\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

function head(dir) {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Runtime event ledger, kept OUTSIDE the tracked tree so the hook's own
 * slice_committed appends never show up in a git diff. */
function runtimeLedger(dir) {
  return path.join(dir, '.runtime', 'events.jsonl');
}

function runHook(dir, { loopJsonState, command, extraEnv = {} } = {}) {
  const loopJsonPath = path.join(dir, 'loop.json');
  if (loopJsonState !== undefined) writeFileSync(loopJsonPath, JSON.stringify(loopJsonState), 'utf8');
  const ledger = runtimeLedger(dir);
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      LOOPWRIGHT_HOOKS: '',
      LOOPWRIGHT_SESSION_ID: '',
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
      LOOPWRIGHT_LEDGER: ledger,
      LOOPWRIGHT_PROJECT_DIR: dir,
      ...extraEnv,
    },
  });
  let finalState = null;
  try { finalState = JSON.parse(readFileSync(loopJsonPath, 'utf8')); } catch { /* not written */ }
  return { ...res, finalState, ledger };
}

function sliceCommitted(ledger) {
  return readLedger(ledger).filter((e) => e.event === 'slice_committed');
}

// ---------------------------------------------------------------------------
// Pure exports
// ---------------------------------------------------------------------------

test('changedPathsTouchJournal: the v3 journal set (STATE/PROGRESS/TASKS/HANDOFF + ledger/)', () => {
  assert.equal(changedPathsTouchJournal(['src/a.js', '.claude/STATE.md']), true);
  assert.equal(changedPathsTouchJournal(['PROGRESS.md']), true);
  assert.equal(changedPathsTouchJournal(['.claude/TASKS.md']), true, 'TASKS.md is journal in v3');
  assert.equal(changedPathsTouchJournal(['.claude/HANDOFF.md']), true, 'HANDOFF.md is journal in v3');
  assert.equal(changedPathsTouchJournal(['.claude/ledger/events.jsonl']), true, 'ledger counts as journal in v3');
  assert.equal(changedPathsTouchJournal(['ledger/archive/events-x.jsonl']), true, 'ledger/ at repo root too');
  assert.equal(changedPathsTouchJournal(['src\\a.js', '.claude\\STATE.md']), true, 'backslash paths normalized');
  assert.equal(changedPathsTouchJournal(['src/a.js', 'src/b.js']), false);
  assert.equal(changedPathsTouchJournal(['stateful.md']), false, 'suffix match is anchored on /STATE.md, not substring');
  assert.equal(changedPathsTouchJournal([]), false);
});

test('isValidSha: accepts abbreviated/full lowercase hex, rejects option-shaped/garbage values', () => {
  assert.equal(isValidSha('a1b2c3d'), true);
  assert.equal(isValidSha('a'.repeat(40)), true);
  assert.equal(isValidSha('--upload-pack=/bin/sh'), false, 'option-shaped argv-injection attempt');
  assert.equal(isValidSha('--'), false);
  assert.equal(isValidSha('-abc1234'), false);
  assert.equal(isValidSha('not-hex!!'), false);
  assert.equal(isValidSha('a'.repeat(41)), false, 'too long');
  assert.equal(isValidSha('abc'), false, 'too short');
  assert.equal(isValidSha(''), false);
  assert.equal(isValidSha(null), false);
});

// ---------------------------------------------------------------------------
// End-to-end — the advisory decision
// ---------------------------------------------------------------------------

test('commit touching STATE.md: ok, no advisory, watermark advances, slice_committed{journal_touched:true} appended', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);
    const after = head(dir);

    const { status, stdout, finalState, ledger } = runHook(dir, {
      loopJsonState: { last_commit_sha: before },
      command: 'git commit -m "feat: thing + journal"',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected no advisory, got: ${stdout}`);
    assert.equal(finalState.last_commit_sha, after);
    const sc = sliceCommitted(ledger);
    assert.equal(sc.length, 1);
    assert.equal(sc[0].data.sha, after);
    assert.equal(sc[0].data.journal_touched, true);
    assert.equal(sc[0].actor, 'hook:journal-integrity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit touching only TASKS.md counts as a journal touch (v3 expanded set)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, '.claude', 'TASKS.md'), '# Tasks\n\n| T1 | ... |\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: task board']);
    const { status, stdout } = runHook(dir, { loopJsonState: { last_commit_sha: before }, command: 'git commit' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `TASKS.md should satisfy the check, got: ${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit touching only a ledger/ path counts as a journal touch (v3: committing the ledger at Record satisfies it)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, '.claude', 'ledger', 'events.jsonl'), '{"event":"iteration","data":{"n":1}}\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'record: ledger']);
    const { status, stdout, finalState } = runHook(dir, { loopJsonState: { last_commit_sha: before }, command: 'git commit' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `ledger commit should satisfy the check, got: ${stdout}`);
    assert.equal(finalState.last_commit_sha, head(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit touching no journal file: advisory, watermark NOT advanced, journal_dirty, slice_committed{journal_touched:false}', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, 'code.txt'), 'v1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: code only']);
    const after = head(dir);

    const { status, stdout, finalState, ledger } = runHook(dir, {
      loopJsonState: { last_commit_sha: before },
      command: 'git commit -m "feat: code only"',
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /STATE|PROGRESS|TASKS|HANDOFF|ledger/);
    assert.match(parsed.reason, /fake progress/i);
    assert.equal(finalState.last_commit_sha, before, 'not advanced until the journal catches up');
    assert.equal(finalState.journal_dirty, true);
    const sc = sliceCommitted(ledger);
    assert.equal(sc.length, 1);
    assert.equal(sc[0].data.sha, after);
    assert.equal(sc[0].data.journal_touched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slice_committed is appended ONCE per HEAD even when the nag re-fires on later Bash calls (dedupe)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, 'code.txt'), 'v1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: code only']);

    // First Bash call after the un-journaled commit: advisory + one slice_committed.
    const first = runHook(dir, { loopJsonState: { last_commit_sha: before }, command: 'git commit' });
    assert.equal(JSON.parse(first.stdout).decision, 'block');
    // Second Bash call (no new commit): the nag re-fires but must NOT append a second event.
    const second = runHook(dir, { command: 'ls' }); // reuse the hook's own loop.json write (watermark still `before`)
    assert.equal(JSON.parse(second.stdout).decision, 'block', 'still nagging until the journal catches up');
    assert.equal(sliceCommitted(first.ledger).length, 1, 'exactly one slice_committed for this HEAD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lost loop.json does NOT forgive an un-journaled commit: watermark restored from the ledger, advisory fires (§2.3.5)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const c1 = head(dir);
    // Seed the ledger with a prior slice_committed at c1 — the v3 watermark source.
    appendEvent(runtimeLedger(dir), { run: 'r-x', shift: 's-001', session: 'cli', actor: 'hook:journal-integrity' },
      'slice_committed', { sha: c1, journal_touched: true });
    // A code-only commit lands afterwards.
    writeFileSync(path.join(dir, 'code.txt'), 'v1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: code only, no journal']);

    // loop.json is ABSENT — v2 would have forgiven straight to HEAD.
    const { status, stdout } = runHook(dir, { command: 'git commit' }); // no loopJsonState → file missing
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block', 'the ledger watermark keeps the un-journaled commit caught');
    assert.match(parsed.reason, /fake progress/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-git bash command with no new HEAD: no-op, exit 0, no advisory', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const { status, stdout } = runHook(dir, { loopJsonState: { last_commit_sha: head(dir) }, command: 'ls -la' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed last_commit_sha (option-injection shape) with no ledger history: bootstraps to HEAD, never reaches git as an argv token', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const h = head(dir);
    const { status, stdout, stderr, finalState } = runHook(dir, {
      loopJsonState: { last_commit_sha: '--upload-pack=/bin/sh' },
      command: 'git log',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.last_commit_sha, h, 'treated as untrusted/invalid, bootstrapped to HEAD');
    assert.match(stderr, /not a valid sha/i, 'rejected by the explicit hex pre-check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh state (last_commit_sha null) with no ledger: bootstraps to HEAD without an advisory', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const h = head(dir);
    const { status, stdout, finalState } = runHook(dir, { loopJsonState: { last_commit_sha: null }, command: 'git log' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.last_commit_sha, h);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SP7/F6 — stale-partial-commit guard (verified_tree_sha assertion), carried
// ---------------------------------------------------------------------------

test('verified_tree_sha matches the committed tree: clean, no advisory (journal also touched)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);
    const afterTree = git(dir, ['rev-parse', 'HEAD^{tree}']).trim();

    const { status, stdout, finalState } = runHook(dir, {
      loopJsonState: { last_commit_sha: before, verified_tree_sha: afterTree },
      command: 'git commit',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected clean (tree matches), got: ${stdout}`);
    assert.equal(finalState.last_commit_sha, head(dir));
    assert.equal(finalState.verified_tree_sha, null, 'one-shot: consumed after being checked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified_tree_sha differs from the committed tree: advisory fires (stale/partial), even though the journal was touched', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    const staleTree = git(dir, ['rev-parse', 'HEAD^{tree}']).trim(); // OLD tree — will differ
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);

    const { status, stdout, finalState } = runHook(dir, {
      loopJsonState: { last_commit_sha: before, verified_tree_sha: staleTree },
      command: 'git commit',
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /tree/i);
    assert.match(parsed.reason, /stale|partial/i);
    assert.equal(finalState.last_commit_sha, head(dir), 'watermark still advances — journal WAS touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOPWRIGHT_HOOKS=0 disables the hook: exit 0, no advisory even on an un-journaled commit', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = head(dir);
    writeFileSync(path.join(dir, 'code.txt'), 'v1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: code only']);
    const { status, stdout, stderr } = runHook(dir, {
      loopJsonState: { last_commit_sha: before },
      command: 'git commit',
      extraEnv: { LOOPWRIGHT_HOOKS: '0' },
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.match(stderr, /disabled|LOOPWRIGHT_HOOKS=0/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SP4 journal-integrity.test.mjs — RED-first tests for the PostToolUse(Bash) journal
// integrity check (F9): when a git commit lands, verify STATE.md/PROGRESS.md were part
// of it; if a commit landed touching neither, emit a "don't fake progress" advisory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedPathsTouchJournal, isValidSha } from './journal-integrity.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'journal-integrity.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sp4-journal-'));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n', 'utf8');
  writeFileSync(path.join(dir, '.claude', 'PROGRESS.md'), '# PROGRESS\n', 'utf8');
  writeFileSync(path.join(dir, 'code.txt'), 'v0\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

test('changedPathsTouchJournal true when STATE.md or PROGRESS.md is among the paths', () => {
  assert.equal(changedPathsTouchJournal(['src/a.js', '.claude/STATE.md']), true);
  assert.equal(changedPathsTouchJournal(['PROGRESS.md']), true);
  assert.equal(changedPathsTouchJournal(['src/a.js', 'src/b.js']), false);
  assert.equal(changedPathsTouchJournal([]), false);
});

test('isValidSha: accepts abbreviated/full lowercase hex shas, rejects option-shaped/garbage values', () => {
  assert.equal(isValidSha('a1b2c3d'), true, '7-char abbreviated sha');
  assert.equal(isValidSha('a'.repeat(40)), true, 'full 40-char sha');
  assert.equal(isValidSha('--upload-pack=/bin/sh'), false, 'option-shaped, argv-injection attempt');
  assert.equal(isValidSha('--'), false);
  assert.equal(isValidSha('-abc1234'), false, 'leading dash still option-shaped');
  assert.equal(isValidSha('not-hex!!'), false);
  assert.equal(isValidSha(''), false);
  assert.equal(isValidSha(null), false);
  assert.equal(isValidSha(undefined), false);
});

function runHook({ dir, loopJsonState, command }) {
  const loopJsonPath = path.join(dir, 'loop.json');
  writeFileSync(loopJsonPath, JSON.stringify(loopJsonState), 'utf8');
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, LOOPWRIGHT_LOOP_JSON: loopJsonPath, LOOPWRIGHT_PROJECT_DIR: dir },
  });
  let finalState = null;
  try { finalState = JSON.parse(readFileSync(loopJsonPath, 'utf8')); } catch { /* not written */ }
  return { ...res, finalState };
}

test('commit touching STATE.md: ok, no advisory, last_commit_sha updated', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);
    const after = git(dir, ['rev-parse', 'HEAD']).trim();

    const { status, stdout, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: before },
      command: 'git commit -m "feat: thing + journal"',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected no advisory, got: ${stdout}`);
    assert.equal(finalState.last_commit_sha, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit touching neither STATE.md nor PROGRESS.md: advisory, last_commit_sha NOT advanced', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(dir, 'code.txt'), 'v1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: code only']);

    const { status, stdout, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: before },
      command: 'git commit -m "feat: code only"',
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /STATE|PROGRESS/);
    assert.match(parsed.reason, /don't fake progress|fake progress/i);
    assert.equal(finalState.last_commit_sha, before, 'not advanced until journal catches up');
    assert.equal(finalState.journal_dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-git bash command with no new HEAD: no-op, exit 0', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const { status, stdout } = runHook({ dir, loopJsonState: { last_commit_sha: head }, command: 'ls -la' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed last_commit_sha (not a real sha, e.g. option-injection attempt): bootstraps rather than passing it to git', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const { status, stdout, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: '--upload-pack=/bin/sh' },
      command: 'git log',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.last_commit_sha, head, 'treated as untrusted/invalid, bootstrapped to HEAD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare "--"-shaped last_commit_sha: bootstraps via the pre-check, never reaches git as an argv token', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    // "--" alone is the classic argv "end of options" marker — if this ever reached git
    // uninspected as part of a range expression, behavior would be git-version-dependent.
    // isValidSha() must reject it before it's ever interpolated into a git argv.
    const { status, stdout, stderr, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: '--' },
      command: 'git log',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.last_commit_sha, head, 'treated as invalid, bootstrapped to HEAD');
    assert.match(stderr, /not a valid sha/i, 'rejected by the explicit hex pre-check, not a git error fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh state (last_commit_sha null): bootstraps to current HEAD without an advisory', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const { status, stdout, finalState } = runHook({ dir, loopJsonState: { last_commit_sha: null }, command: 'git log' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.last_commit_sha, head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SP7/F6 — stale-partial-commit guard (verified_tree_sha assertion)
// ---------------------------------------------------------------------------

test('verified_tree_sha matches the committed tree: clean, no advisory (journal also touched)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);
    const after = git(dir, ['rev-parse', 'HEAD']).trim();
    const afterTree = git(dir, ['rev-parse', 'HEAD^{tree}']).trim();

    const { status, stdout, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: before, verified_tree_sha: afterTree },
      command: 'git commit -m "feat: thing + journal"',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected clean (tree matches), got: ${stdout}`);
    assert.equal(finalState.last_commit_sha, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified_tree_sha differs from the committed tree: advisory fires (stale/partial commit), even though the journal was touched', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    const staleTree = git(dir, ['rev-parse', 'HEAD^{tree}']).trim(); // the OLD (pre-commit) tree — will differ
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);

    const { status, stdout, finalState } = runHook({
      dir,
      loopJsonState: { last_commit_sha: before, verified_tree_sha: staleTree },
      command: 'git commit -m "feat: thing + journal"',
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /tree/i);
    assert.match(parsed.reason, /stale|partial/i);
    // last_commit_sha still advances — the journal itself WAS touched; this is an
    // advisory about tree drift, not the "don't fake progress" journal-missing case.
    assert.equal(finalState.last_commit_sha, git(dir, ['rev-parse', 'HEAD']).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified_tree_sha unset: no tree-related advisory regardless of the commit (backward compatible, pure no-op on that check)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nupdated\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: thing + journal']);

    const { status, stdout } = runHook({
      dir,
      loopJsonState: { last_commit_sha: before }, // no verified_tree_sha at all
      command: 'git commit -m "feat: thing + journal"',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected no-op on the tree check, got: ${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified_tree_sha is ONE-SHOT: cleared after checking the commit it was stamped for (match or mismatch), so a SECOND, later forward commit with a different tree is never compared against a stale snapshot (no cry-wolf on normal forward progress)', () => {
  const dir = tmpDir();
  try {
    initRepo(dir);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nslice 1\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: slice 1 + journal']);
    const after1 = git(dir, ['rev-parse', 'HEAD']).trim();
    const tree1 = git(dir, ['rev-parse', 'HEAD^{tree}']).trim();

    // First verify+commit: verified_tree_sha matches the committed tree — the guard should
    // consume (clear) the stamp here, whether it matched or not.
    const first = runHook({
      dir,
      loopJsonState: { last_commit_sha: before, verified_tree_sha: tree1 },
      command: 'git commit -m "feat: slice 1 + journal"',
    });
    assert.equal(first.status, 0);
    assert.ok(!first.stdout.includes('"decision":"block"'), `expected clean match, got: ${first.stdout}`);
    assert.equal(first.finalState.last_commit_sha, after1);
    assert.equal(first.finalState.verified_tree_sha, null, 'one-shot: consumed (cleared) after being checked once');

    // A SECOND, later slice with a genuinely different tree (new content) — no fresh stamp
    // was taken for it (verified_tree_sha is unset, same as any other normal forward commit).
    // Before the one-shot fix, this would still have been compared against the now-stale
    // tree1 snapshot and wrongly flagged as a "stale/partial commit" on every subsequent
    // commit — the cry-wolf bug this test guards against.
    writeFileSync(path.join(dir, '.claude', 'STATE.md'), '# STATE\n\nslice 2\n', 'utf8');
    writeFileSync(path.join(dir, 'code.txt'), 'v2\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: slice 2 + journal']);
    const after2 = git(dir, ['rev-parse', 'HEAD']).trim();
    const tree2 = git(dir, ['rev-parse', 'HEAD^{tree}']).trim();
    assert.notEqual(tree2, tree1, 'sanity: the second commit really is a different tree');

    const second = runHook({
      dir,
      loopJsonState: first.finalState, // verified_tree_sha already cleared to null
      command: 'git commit -m "feat: slice 2 + journal"',
    });
    assert.equal(second.status, 0);
    assert.ok(
      !second.stdout.includes('"decision":"block"'),
      `expected no false-positive advisory on normal forward progress, got: ${second.stdout}`,
    );
    assert.equal(second.finalState.last_commit_sha, after2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

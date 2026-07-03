// SP4 precompact-anchor.test.mjs — RED-first tests for the PreCompact snapshot hook
// (F17): before context is squeezed, write a recoverable scope/intent block into the
// git-tracked STATE.md so SessionStart(compact) can re-orient from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertSection, buildAnchorBlock, extractOpenBlockerHighIds } from './precompact-anchor.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'precompact-anchor.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sp4-precompact-'));
}

test('upsertSection appends a new section when the heading is absent', () => {
  const md = '# STATE\n\nsome body\n';
  const out = upsertSection(md, 'Compaction anchor', 'the anchor body');
  assert.match(out, /## Compaction anchor\nthe anchor body/);
  assert.match(out, /some body/);
});

test('upsertSection replaces an existing section in place (idempotent, no duplication)', () => {
  const md = '# STATE\n\n## Compaction anchor\nold body\n\n## Milestones\n- [ ] M1\n';
  const out = upsertSection(md, 'Compaction anchor', 'new body');
  assert.match(out, /## Compaction anchor\nnew body/);
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /## Milestones\n- \[ \] M1/, 'later sections preserved');
  assert.equal((out.match(/## Compaction anchor/g) || []).length, 1);
});

test('extractOpenBlockerHighIds pulls only open blocker/high rows', () => {
  const findings = [
    '| ID | sev | type | status | mitigation | verified | source |',
    '| F1 | high | injection | open | x | - | reviewer |',
    '| F2 | blocker | secret | verified | x | reviewer | reviewer |',
    '| F3 | low | nit | open | x | - | reviewer |',
    '| F4 | blocker | crash | planned | x | - | reviewer |',
  ].join('\n');
  assert.deepEqual(extractOpenBlockerHighIds(findings), ['F1', 'F4']);
});

test('buildAnchorBlock includes scope, open findings, and last commit', () => {
  const block = buildAnchorBlock({
    nowLine: '**Now:** M2 — build the thing',
    nextLine: '**Next:** M3 — ship it',
    openFindingIds: ['F1', 'F4'],
    lastCommitSha: 'deadbeef',
    timestamp: '2026-07-01T00:00:00.000Z',
  });
  assert.match(block, /M2 — build the thing/);
  assert.match(block, /M3 — ship it/);
  assert.match(block, /F1, F4/);
  assert.match(block, /deadbeef/);
});

test('buildAnchorBlock handles no open findings / no commit gracefully', () => {
  const block = buildAnchorBlock({ nowLine: '', nextLine: '', openFindingIds: [], lastCommitSha: null, timestamp: 'x' });
  assert.match(block, /none/i);
});

// --- end-to-end via the hook process ---

function runHook({ stateMd, findingsMd, loopJson, stdin = '{}' }) {
  const dir = tmpDir();
  const stateMdPath = path.join(dir, 'STATE.md');
  const findingsMdPath = path.join(dir, 'FINDINGS.md');
  const loopJsonPath = path.join(dir, 'loop.json');
  if (stateMd !== undefined) writeFileSync(stateMdPath, stateMd, 'utf8');
  if (findingsMd !== undefined) writeFileSync(findingsMdPath, findingsMd, 'utf8');
  if (loopJson !== undefined) writeFileSync(loopJsonPath, JSON.stringify(loopJson), 'utf8');

  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      TRELLIS_STATE_MD: stateMdPath,
      TRELLIS_FINDINGS_MD: findingsMdPath,
      TRELLIS_LOOP_JSON: loopJsonPath,
    },
  });
  let finalStateMd = null;
  try { finalStateMd = readFileSync(stateMdPath, 'utf8'); } catch { /* not written */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...res, finalStateMd };
}

test('hook writes a Compaction anchor into STATE.md and always exits 0', () => {
  const stateMd = '# STATE\n\n**Now:** M2 — build the thing\n**Next:** M3 — ship it\n';
  const findingsMd = '| ID | sev | type | status | mitigation | verified | source |\n| F1 | high | injection | open | x | - | reviewer |\n';
  const loopJson = { last_commit_sha: 'cafef00d' };
  const { status, finalStateMd } = runHook({ stateMd, findingsMd, loopJson });
  assert.equal(status, 0);
  assert.match(finalStateMd, /## Compaction anchor/);
  assert.match(finalStateMd, /M2 — build the thing/);
  assert.match(finalStateMd, /F1/);
  assert.match(finalStateMd, /cafef00d/);
});

test('hook never blocks compaction, even on missing STATE.md', () => {
  const { status } = runHook({ stdin: '{}' });
  assert.equal(status, 0);
});

test('STATE.md write is atomic (no leftover .tmp file after a successful run)', () => {
  const dir = tmpDir();
  try {
    const stateMdPath = path.join(dir, 'STATE.md');
    writeFileSync(stateMdPath, '# STATE\n\n**Now:** x\n**Next:** y\n', 'utf8');
    const res = spawnSync(process.execPath, [HOOK], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, TRELLIS_STATE_MD: stateMdPath },
    });
    assert.equal(res.status, 0);
    assert.deepEqual(readdirSync(dir), ['STATE.md'], 'no leftover .tmp-* file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

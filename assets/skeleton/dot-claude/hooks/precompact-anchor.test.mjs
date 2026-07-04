// v3 precompact-anchor.test.mjs — the PreCompact snapshot hook (F17 carried to v3):
// before context is squeezed, write a recoverable scope/intent/shift/budget block into
// the git-tracked STATE.md so SessionStart(compact) can re-orient from it, and append a
// compaction_anchor_written ledger event. Pure exports are unit-tested; the hook is
// driven as a real child process via the LOOPWRIGHT_* env overrides (v2/v3 convention).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertSection, buildAnchorBlock, extractOpenBlockerHighIds } from './precompact-anchor.mjs';
import { freshState, nowSec } from './loop-state.mjs';
import { readLedger } from './ledger.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'precompact-anchor.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-precompact-'));
}

/** A schema-3 loop.json with one open shift — the state precompact normally sees. */
function stateFixture(now, over = {}) {
  return {
    ...freshState(now),
    shift_id: 's-002',
    shift_seq: 2,
    operator: 'testop',
    iteration: 5,
    active_seconds: 1200,
    run_totals: { shifts: 2, iterations: 30, active_seconds: 5000 },
    last_commit_sha: 'cafef00d',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure exports
// ---------------------------------------------------------------------------

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

test('upsertSection is idempotent across two consecutive writes', () => {
  const md = '# STATE\n\n**Now:** x\n';
  const once = upsertSection(md, 'Compaction anchor', 'body v1');
  const twice = upsertSection(once, 'Compaction anchor', 'body v1');
  assert.equal((twice.match(/## Compaction anchor/g) || []).length, 1);
});

test('extractOpenBlockerHighIds (re-exported from loop-state) pulls only open blocker/high rows', () => {
  const findings = [
    '| ID | sev | type | status | mitigation | verified | source |',
    '| F1 | high | injection | open | x | - | reviewer |',
    '| F2 | blocker | secret | verified | x | reviewer | reviewer |',
    '| F3 | low | nit | open | x | - | reviewer |',
    '| F4 | blocker | crash | planned | x | - | reviewer |',
  ].join('\n');
  assert.deepEqual(extractOpenBlockerHighIds(findings), ['F1', 'F4']);
});

test('buildAnchorBlock includes scope, open findings, last commit, and the v3 shift/budget lines', () => {
  const block = buildAnchorBlock({
    nowLine: '**Now:** M2 — build the thing',
    nextLine: '**Next:** M3 — ship it',
    openFindingIds: ['F1', 'F4'],
    lastCommitSha: 'deadbeef',
    shiftLine: 's-002 (testop) — iteration 5/40',
    budgetLine: '1200s/21600s active · milestone_gate=clear',
    timestamp: '2026-07-04T00:00:00.000Z',
  });
  assert.match(block, /M2 — build the thing/);
  assert.match(block, /M3 — ship it/);
  assert.match(block, /F1, F4/);
  assert.match(block, /deadbeef/);
  assert.match(block, /s-002 \(testop\)/);
  assert.match(block, /1200s\/21600s active/);
});

test('buildAnchorBlock handles no findings / no commit / no shift gracefully', () => {
  const block = buildAnchorBlock({ nowLine: '', nextLine: '', openFindingIds: [], lastCommitSha: null, shiftLine: '', budgetLine: '', timestamp: 'x' });
  assert.match(block, /none/i);
  assert.match(block, /none yet/);
});

// ---------------------------------------------------------------------------
// End-to-end via the hook process
// ---------------------------------------------------------------------------

function runHook(dir, { stateMd, findingsMd, loopJson, config, stdin = '{}', extraEnv = {} } = {}) {
  const stateMdPath = path.join(dir, 'STATE.md');
  const findingsMdPath = path.join(dir, 'FINDINGS.md');
  const loopJsonPath = path.join(dir, 'loop.json');
  const configPath = path.join(dir, 'loop-config.json');
  const ledgerFile = path.join(dir, 'ledger', 'events.jsonl');
  if (stateMd !== undefined) writeFileSync(stateMdPath, stateMd, 'utf8');
  if (findingsMd !== undefined) writeFileSync(findingsMdPath, findingsMd, 'utf8');
  if (loopJson !== undefined) writeFileSync(loopJsonPath, JSON.stringify(loopJson), 'utf8');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOPWRIGHT_HOOKS: '',
      LOOPWRIGHT_SESSION_ID: '',
      LOOPWRIGHT_STATE_MD: stateMdPath,
      LOOPWRIGHT_FINDINGS_MD: findingsMdPath,
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
      LOOPWRIGHT_LOOP_CONFIG: configPath,
      LOOPWRIGHT_LEDGER: ledgerFile,
      ...extraEnv,
    },
  });
  let finalStateMd = null;
  try { finalStateMd = readFileSync(stateMdPath, 'utf8'); } catch { /* not written */ }
  return { ...res, finalStateMd, ledgerFile };
}

test('hook writes a Compaction anchor into STATE.md with scope/findings/commit/shift/budget and exits 0', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const stateMd = '# STATE\n\n**Now:** M2 — build the thing\n**Next:** M3 — ship it\n';
    const findingsMd = '| ID | sev | type | status | mitigation | verified | source |\n| F1 | high | injection | open | x | - | reviewer |\n';
    const { status, finalStateMd } = runHook(dir, {
      stateMd,
      findingsMd,
      loopJson: stateFixture(now),
      config: { shift: { max_iterations: 40, max_wall_clock_sec: 21600 } },
    });
    assert.equal(status, 0);
    assert.match(finalStateMd, /## Compaction anchor/);
    assert.match(finalStateMd, /M2 — build the thing/);
    assert.match(finalStateMd, /F1/);
    assert.match(finalStateMd, /cafef00d/);
    assert.match(finalStateMd, /s-002 \(testop\)/, 'shift line captured');
    assert.match(finalStateMd, /iteration 5\/40/, 'iteration ceiling captured');
    assert.match(finalStateMd, /1200s\/21600s active/, 'active-second ceiling captured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook appends exactly one compaction_anchor_written ledger event (audit)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, ledgerFile } = runHook(dir, {
      stateMd: '# STATE\n\n**Now:** x\n**Next:** y\n',
      loopJson: stateFixture(now),
    });
    assert.equal(status, 0);
    const evs = readLedger(ledgerFile).filter((e) => e.event === 'compaction_anchor_written');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].actor, 'hook:precompact-anchor');
    assert.equal(evs[0].shift, 's-002');
    assert.equal(evs[0].data.shift, 's-002');
    assert.equal(evs[0].data.findings, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2-flat loop.json (no schema) is migrated in-memory — last_commit_sha survives into the anchor', () => {
  const dir = tmpDir();
  try {
    const { status, finalStateMd } = runHook(dir, {
      stateMd: '# STATE\n\n**Now:** a\n**Next:** b\n',
      loopJson: { last_commit_sha: 'beadfeed' }, // v2 flat shape, no schema field
    });
    assert.equal(status, 0);
    assert.match(finalStateMd, /## Compaction anchor/);
    assert.match(finalStateMd, /beadfeed/);
    assert.match(finalStateMd, /s-001/, 'v2 run migrates to shift s-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook never blocks compaction, even on missing STATE.md (exit 0, no write)', () => {
  const dir = tmpDir();
  try {
    const { status, finalStateMd } = runHook(dir, { stdin: '{}' });
    assert.equal(status, 0);
    assert.equal(finalStateMd, null, 'no STATE.md created — nothing to snapshot into');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook re-run replaces the anchor in place (no duplicate section across compactions)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const first = runHook(dir, { stateMd: '# STATE\n\n**Now:** x\n**Next:** y\n', loopJson: stateFixture(now) });
    assert.equal(first.status, 0);
    // Second compaction: STATE.md already carries an anchor; loop.json/config persist.
    const second = runHook(dir, { loopJson: stateFixture(now, { iteration: 9 }) });
    assert.equal(second.status, 0);
    assert.equal((second.finalStateMd.match(/## Compaction anchor/g) || []).length, 1);
    assert.match(second.finalStateMd, /iteration 9\/40/, 'anchor refreshed to the newer position');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STATE.md write is atomic (no leftover .tmp file after a successful run)', () => {
  const dir = tmpDir();
  try {
    const stateMdPath = path.join(dir, 'STATE.md');
    writeFileSync(stateMdPath, '# STATE\n\n**Now:** x\n**Next:** y\n', 'utf8');
    const res = spawnSync(process.execPath, [HOOK], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, LOOPWRIGHT_HOOKS: '', LOOPWRIGHT_STATE_MD: stateMdPath, LOOPWRIGHT_LEDGER: path.join(dir, 'ledger', 'events.jsonl') },
    });
    assert.equal(res.status, 0);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('STATE.md.tmp-')), 'no leftover .tmp-* file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOPWRIGHT_HOOKS=0 disables the hook: exit 0, STATE.md untouched', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, finalStateMd } = runHook(dir, {
      stateMd: '# STATE\n\n**Now:** x\n',
      loopJson: stateFixture(now),
      extraEnv: { LOOPWRIGHT_HOOKS: '0' },
    });
    assert.equal(status, 0);
    assert.doesNotMatch(finalStateMd, /## Compaction anchor/, 'disabled: no anchor written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

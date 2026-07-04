// v3 session-orient.test.mjs — the SessionStart(source=compact) re-orient hook: re-inject
// the HANDOFF pointer (v3 primary anchor) + STATE's compaction anchor + open FINDINGS +
// a shift/budget summary as additionalContext so the post-compaction turn resumes
// on-scope. Pure exports unit-tested; the hook (and a precompact→orient round-trip) is
// driven as a real child process via the LOOPWRIGHT_* env overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOrientContext, buildHandoffPointer, extractSection } from './session-orient.mjs';
import { freshState, nowSec } from './loop-state.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HOOKS_DIR, 'session-orient.mjs');
const PRECOMPACT_HOOK = path.join(HOOKS_DIR, 'precompact-anchor.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-session-orient-'));
}

function stateFixture(now, over = {}) {
  return {
    ...freshState(now),
    shift_id: 's-002',
    shift_seq: 2,
    operator: 'ofek',
    iteration: 5,
    active_seconds: 1200,
    started_at: now - 300,
    heartbeat_at: now - 10,
    run_totals: { shifts: 2, iterations: 30, active_seconds: 5000 },
    ...over,
  };
}

const HANDOFF_MD = [
  '# HANDOFF — shift s-002',
  '_Written: 2026-07-04T08:00:00Z · operator: ofek · kind: authored · shift-open: no_',
  '**Run:** r-20260704T0800Z · **Shift:** s-002 (start → end) · **End reason:** budget_time',
  '',
  '## In flight — exact next step',
  '**Task:** T14 (in_progress) — next: wire the parser',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Pure exports
// ---------------------------------------------------------------------------

test('buildOrientContext includes the handoff pointer, compaction anchor, open findings, and budget', () => {
  const ctx = buildOrientContext({
    handoffPointer: 'HANDOFF.md — shift s-002 · kind authored · shift closed',
    anchorBlock: '**Now:** M2 — build the thing',
    openFindingIds: ['F1', 'F4'],
    budgetSummary: 'shift s-002, iteration 5/40, active 1200s/21600s (wall-clock 300s elapsed), milestone_gate=clear',
  });
  assert.match(ctx, /HANDOFF pointer/);
  assert.match(ctx, /shift s-002 · kind authored/);
  assert.match(ctx, /M2 — build the thing/);
  assert.match(ctx, /F1, F4/);
  assert.match(ctx, /iteration 5\/40/);
});

test('buildOrientContext degrades gracefully when the handoff / anchor are absent', () => {
  const ctx = buildOrientContext({ handoffPointer: '', anchorBlock: '', openFindingIds: [], budgetSummary: 's' });
  assert.match(ctx, /no HANDOFF\.md found/);
  assert.match(ctx, /no compaction anchor found/);
  assert.match(ctx, /Open blocker\/high findings: none/);
});

test('buildHandoffPointer surfaces the stamp header + the in-flight task line', () => {
  const p = buildHandoffPointer(HANDOFF_MD);
  assert.match(p, /HANDOFF\.md — shift s-002/);
  assert.match(p, /kind authored/);
  assert.match(p, /shift closed/);
  assert.match(p, /\*\*Task:\*\* T14 \(in_progress\) — next: wire the parser/);
});

test('buildHandoffPointer returns empty string for a blank/absent HANDOFF (e.g. the shipped placeholder)', () => {
  assert.equal(buildHandoffPointer(''), '');
  assert.equal(buildHandoffPointer('   \n  \n'), '');
});

test('buildHandoffPointer handles an unstamped-but-present HANDOFF', () => {
  const p = buildHandoffPointer('# HANDOFF\n\nsome freeform notes, no stamp\n');
  assert.match(p, /HANDOFF\.md present \(unstamped/);
});

test('extractSection pulls a section body up to the next heading', () => {
  const md = '# STATE\n\n## Compaction anchor\nline a\nline b\n\n## Milestones\n- [ ] M1\n';
  assert.equal(extractSection(md, 'Compaction anchor'), 'line a\nline b');
  assert.equal(extractSection(md, 'Nope'), '');
});

// ---------------------------------------------------------------------------
// End-to-end via the hook process
// ---------------------------------------------------------------------------

function runHook(dir, HOOK_PATH, { stateMd, findingsMd, handoffMd, loopJson, config, stdin, extraEnv = {} } = {}) {
  const stateMdPath = path.join(dir, 'STATE.md');
  const findingsMdPath = path.join(dir, 'FINDINGS.md');
  const handoffMdPath = path.join(dir, 'HANDOFF.md');
  const loopJsonPath = path.join(dir, 'loop.json');
  const configPath = path.join(dir, 'loop-config.json');
  const ledgerFile = path.join(dir, 'ledger', 'events.jsonl');
  if (stateMd !== undefined) writeFileSync(stateMdPath, stateMd, 'utf8');
  if (findingsMd !== undefined) writeFileSync(findingsMdPath, findingsMd, 'utf8');
  if (handoffMd !== undefined) writeFileSync(handoffMdPath, handoffMd, 'utf8');
  if (loopJson !== undefined) writeFileSync(loopJsonPath, JSON.stringify(loopJson), 'utf8');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const res = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOPWRIGHT_HOOKS: '',
      LOOPWRIGHT_SESSION_ID: '',
      LOOPWRIGHT_STATE_MD: stateMdPath,
      LOOPWRIGHT_FINDINGS_MD: findingsMdPath,
      LOOPWRIGHT_HANDOFF_MD: handoffMdPath,
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
      LOOPWRIGHT_LOOP_CONFIG: configPath,
      LOOPWRIGHT_LEDGER: ledgerFile,
      ...extraEnv,
    },
  });
  let finalStateMd = null;
  try { finalStateMd = readFileSync(stateMdPath, 'utf8'); } catch { /* not written */ }
  return { ...res, finalStateMd };
}

test('source=compact: emits SessionStart additionalContext with handoff + anchor + findings + budget', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const stateMd = '# STATE\n\n## Compaction anchor\n**Now:** M2 — build the thing\n**Next:** M3\n';
    const findingsMd = '| ID | sev | type | status | mitigation | verified | source |\n| F1 | high | injection | open | x | - | reviewer |\n';
    const { status, stdout } = runHook(dir, HOOK, {
      stateMd,
      findingsMd,
      handoffMd: HANDOFF_MD,
      loopJson: stateFixture(now),
      stdin: JSON.stringify({ source: 'compact' }),
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /HANDOFF\.md — shift s-002/, 'handoff pointer surfaced');
    assert.match(ctx, /wire the parser/, 'in-flight task surfaced');
    assert.match(ctx, /M2 — build the thing/, 'compaction anchor surfaced');
    assert.match(ctx, /F1/, 'open finding surfaced');
    assert.match(ctx, /iteration 5\/40/, 'budget summary surfaced');
    assert.match(ctx, /active 1200s\/21600s/, 'active-second budget surfaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source != compact: self-checks and no-ops (exit 0, empty stdout)', () => {
  const dir = tmpDir();
  try {
    const { status, stdout } = runHook(dir, HOOK, { stateMd: '# STATE\n', stdin: JSON.stringify({ source: 'startup' }) });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source=compact with no HANDOFF.md: still emits context, degrading the handoff line', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout } = runHook(dir, HOOK, {
      stateMd: '# STATE\n\n## Compaction anchor\n**Now:** x\n',
      loopJson: stateFixture(now),
      stdin: JSON.stringify({ source: 'compact' }),
    });
    assert.equal(status, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /no HANDOFF\.md found/);
    assert.match(ctx, /## Compaction anchor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing STATE.md on source=compact: fail-safe, exit 0, no crash', () => {
  const dir = tmpDir();
  try {
    const { status, stdout } = runHook(dir, HOOK, { stdin: JSON.stringify({ source: 'compact' }) });
    assert.equal(status, 0);
    // Still emits context (anchor line degrades) — the summary is derived from loop.json.
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed stdin: no-op, exit 0, empty stdout', () => {
  const dir = tmpDir();
  try {
    const { status, stdout } = runHook(dir, HOOK, { stateMd: '# STATE\n', stdin: 'not json{' });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOPWRIGHT_HOOKS=0 disables the hook even on source=compact: exit 0, empty stdout', () => {
  const dir = tmpDir();
  try {
    const { status, stdout } = runHook(dir, HOOK, {
      stateMd: '# STATE\n',
      stdin: JSON.stringify({ source: 'compact' }),
      extraEnv: { LOOPWRIGHT_HOOKS: '0' },
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trip: precompact-anchor writes the anchor, session-orient re-injects it', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    // 1) PreCompact snapshots the anchor into STATE.md.
    const pre = runHook(dir, PRECOMPACT_HOOK, {
      stateMd: '# STATE\n\n**Now:** M2 — the keystone slice\n**Next:** M3 — integrate\n',
      findingsMd: '| ID | sev | type | status | mitigation | verified | source |\n| F7 | blocker | crash | open | x | - | reviewer |\n',
      handoffMd: HANDOFF_MD,
      loopJson: stateFixture(now, { last_commit_sha: 'abc1234' }),
      stdin: '{}',
    });
    assert.equal(pre.status, 0);
    assert.match(pre.finalStateMd, /## Compaction anchor/);

    // 2) SessionStart(compact) reads it back — reuse the same files (STATE.md now has the anchor).
    const orient = runHook(dir, HOOK, {
      handoffMd: HANDOFF_MD,
      loopJson: stateFixture(now, { last_commit_sha: 'abc1234' }),
      stdin: JSON.stringify({ source: 'compact' }),
    });
    assert.equal(orient.status, 0);
    const ctx = JSON.parse(orient.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /M2 — the keystone slice/, 'anchor round-tripped');
    assert.match(ctx, /abc1234/, 'last commit round-tripped through the anchor');
    assert.match(ctx, /F7/, 'open blocker finding surfaced');
    assert.match(ctx, /HANDOFF\.md — shift s-002/, 'handoff pointer surfaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

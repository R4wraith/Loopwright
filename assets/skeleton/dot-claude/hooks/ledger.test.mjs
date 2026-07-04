// v3 ledger.test.mjs — pins for the append-only substrate (spec §2, §8/WP1).
// Run from a temp dir: every test creates its own sandbox; nothing touches the
// plugin tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EVENTS, MAX_LINE_BYTES, appendEvent, readLedger, replay, rotate, countUnparseableLines, isoNow } from './ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_MJS = path.join(HERE, 'ledger.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-ledger-'));
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = orig;
  }
}

const ENV = { run: 'r-20260704T0800Z', shift: 's-001', session: 'sess-1', actor: 'cli:test' };

test('EVENTS is the closed §2.2 vocabulary (24 kinds, no seq field anywhere)', () => {
  assert.equal(EVENTS.length, 24);
  for (const e of [
    'run_started', 'run_completed', 'shift_started', 'shift_ended', 'session_started', 'session_ended',
    'session_takeover', 'iteration', 'task_created', 'task_status', 'dispatch', 'slice_verified',
    'slice_committed', 'milestone_gate_pending', 'approval_granted', 'approval_consumed', 'approval_expired',
    'winddown_posted', 'budget_extended', 'handoff_written', 'compaction_anchor_written', 'routine_run',
    'ledger_rotated', 'migrated',
  ]) {
    assert.ok(EVENTS.includes(e), `missing event kind ${e}`);
  }
});

test('appendEvent → readLedger round-trip: envelope shape, ts format, no seq field', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'ledger', 'events.jsonl'); // dir does not exist yet — appendEvent creates it
    appendEvent(p, ENV, 'run_started', { goal_hash: 'abc' });
    appendEvent(p, ENV, 'iteration', { n: 1, active_seconds: 12 });
    appendEvent(p, { ...ENV, shift: null }, 'session_started', { source: 'startup' });
    const events = readLedger(p);
    assert.equal(events.length, 3);
    assert.deepEqual(Object.keys(events[0]), ['ts', 'run', 'shift', 'session', 'actor', 'event', 'data']);
    assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(events[1].event, 'iteration');
    assert.deepEqual(events[1].data, { n: 1, active_seconds: 12 });
    assert.equal(events[2].shift, null, 'shift may be null pre-shift');
    assert.ok(!('seq' in events[0]), 'R10: no seq field in the envelope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('torn tail (partial last line, no newline) is dropped with the pinned stderr count line', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    appendEvent(p, ENV, 'iteration', { n: 1, active_seconds: 5 });
    appendFileSync(p, '{"ts":"2026-07-04T18:2'); // kill -9 mid-append (S1)
    const { result, stderr } = captureStderr(() => readLedger(p));
    assert.equal(result.length, 2);
    assert.match(stderr, /^ledger: skipped 1 unparseable line\(s\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mid-file garbage line is skipped too — tolerance is anywhere, not just the tail', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    appendFileSync(p, '<<<<<<< merge damage\n');
    appendFileSync(p, 'not json at all\n');
    appendEvent(p, ENV, 'iteration', { n: 1, active_seconds: 5 });
    const { result, stderr } = captureStderr(() => readLedger(p));
    assert.equal(result.length, 2);
    assert.equal(result[1].event, 'iteration');
    assert.match(stderr, /ledger: skipped 2 unparseable line\(s\)/);
    assert.equal(countUnparseableLines(p), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown event kind: skipped with warning on read, THROWN on write (closed vocabulary)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    // A future-schema event lands in the file (e.g. written by a newer plugin).
    appendFileSync(p, JSON.stringify({ ts: isoNow(), run: 'r', shift: null, session: 's', actor: 'x', event: 'teleported', data: {} }) + '\n');
    const { result, stderr } = captureStderr(() => readLedger(p));
    assert.equal(result.length, 1);
    assert.match(stderr, /ledger: skipped 1 unknown event kind\(s\): teleported/);
    // Writers are strict:
    assert.throws(() => appendEvent(p, ENV, 'teleported', {}), /unknown event kind "teleported"/);
    const raw = readFileSync(p, 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 2, 'refused write appended nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exact-duplicate lines are deduped before replay (merge=union simulation)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    appendEvent(p, { ...ENV, ts: '2026-07-04T10:00:00Z' }, 'shift_started', { seq: 1, operator: 'ofek', mode: 'interactive', budget: {}, implicit: false });
    const endedLine = JSON.stringify({
      ts: '2026-07-04T12:00:00Z', run: ENV.run, shift: 's-001', session: 'sess-1', actor: 'cli:end-shift',
      event: 'shift_ended', data: { reason: 'manual', iterations: 7, active_seconds: 100, commits: 2 },
    });
    // union merge duplicated the shift_ended line:
    appendFileSync(p, endedLine + '\n' + endedLine + '\n');
    const events = readLedger(p);
    assert.equal(events.filter((e) => e.event === 'shift_ended').length, 1, 'dedupe on exact line identity');
    const rep = replay(events);
    assert.equal(rep.run_totals.shifts, 1, 'replay idempotent across union duplicates');
    assert.equal(rep.run_totals.iterations, 7);
    assert.equal(rep.run_totals.active_seconds, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay is deterministic and order-sensitive (verified-then-committed ≠ committed-then-verified)', () => {
  const ev = (event, data, extra = {}) => ({ ts: '2026-07-04T10:00:00Z', run: 'r-x', shift: 's-001', session: 's', actor: 'a', event, data, ...extra });
  const verified = ev('slice_verified', { task: 'T1', tier: 'T1', tree_sha: 'tree1' });
  const committed = ev('slice_committed', { sha: 'sha1', journal_touched: true });
  const a1 = replay([verified, committed]);
  const a2 = replay([verified, committed]);
  assert.deepEqual(a1, a2, 'deterministic');
  assert.equal(a1.verified_tree_sha, null, '§2.3.6: a later commit invalidates the verified stamp');
  assert.equal(a1.last_commit_sha, 'sha1');
  const b = replay([committed, verified]);
  assert.equal(b.verified_tree_sha, 'tree1', 'verify after commit keeps the stamp');
});

test('replay §2.3: gate/approval/watermark/open-shift derivation', () => {
  const ev = (ts, event, data, shift = 's-001') => ({ ts, run: 'r-x', shift, session: 's', actor: 'a', event, data });
  const base = [
    { ...ev('2026-07-04T08:00:00Z', 'run_started', { goal_hash: 'g' }), shift: null },
    ev('2026-07-04T08:01:00Z', 'shift_started', { seq: 1, operator: 'ofek', mode: 'interactive', budget: {}, implicit: false }),
    ev('2026-07-04T09:00:00Z', 'iteration', { n: 1, active_seconds: 100 }),
    ev('2026-07-04T09:10:00Z', 'iteration', { n: 2, active_seconds: 250 }),
    ev('2026-07-04T09:20:00Z', 'milestone_gate_pending', { count: 1 }),
    ev('2026-07-04T09:30:00Z', 'approval_granted', { kind: 'human', operator: 'ofek', token: 'ok-1', granted_at: '2026-07-04T09:30:00Z', expires_at: '2026-07-07T09:30:00Z' }),
  ];
  const pending = replay(base);
  assert.equal(pending.run_id, 'r-x');
  assert.equal(pending.gate, 'pending-approval', 'gate armed with no later consume');
  assert.deepEqual(pending.approval_token, { value: 'ok-1', class: 'human', operator: 'ofek', granted_at: '2026-07-04T09:30:00Z', expires_at: '2026-07-07T09:30:00Z' });
  assert.equal(pending.open_shift.id, 's-001');
  assert.equal(pending.open_shift.iteration, 2, 'max n of the shift iteration events');
  assert.equal(pending.open_shift.active_seconds, 250, 'last active_seconds');
  assert.equal(pending.run_totals.shifts, 0, 'replay run_totals count CLOSED shifts only');

  const consumed = replay([...base, ev('2026-07-04T09:40:00Z', 'approval_consumed', { kind: 'human', operator: 'ofek', milestone_count: 1 })]);
  assert.equal(consumed.gate, 'clear');
  assert.equal(consumed.approval_token, null);
  assert.equal(consumed.milestone_ticked_count, 1, 'watermark = last approval_consumed.milestone_count');

  const expired = replay([...base, ev('2026-07-07T10:00:00Z', 'approval_expired', { operator: 'ofek', granted_at: '2026-07-04T09:30:00Z' })]);
  assert.equal(expired.approval_token, null, 'expired token dropped');
  assert.equal(expired.gate, 'pending-approval', 'expiry does not clear the gate');

  const wound = replay([...base, ev('2026-07-04T09:50:00Z', 'winddown_posted', { scope: 'shift', reason: 'budget' })]);
  assert.equal(wound.open_shift.winddown_posted, true);
  const gateWound = replay([...base, ev('2026-07-04T09:50:00Z', 'winddown_posted', { scope: 'gate', reason: 'gate_block_max' })]);
  assert.equal(gateWound.open_shift.gate_winddown_posted, true);
  assert.equal(gateWound.open_shift.winddown_posted, false);
});

test('replay task_latest keeps title/milestone from task_created across task_status updates', () => {
  const ev = (ts, event, data) => ({ ts, run: 'r-x', shift: 's-001', session: 's', actor: 'a', event, data });
  const rep = replay([
    ev('2026-07-04T08:00:00Z', 'task_created', { task: 'T1', title: 'parser EOF', milestone: 'M1' }),
    ev('2026-07-04T08:10:00Z', 'task_status', { task: 'T1', from: 'queued', to: 'in_progress', next_step: 'write the test' }),
  ]);
  assert.equal(rep.task_latest.T1.to, 'in_progress');
  assert.equal(rep.task_latest.T1.from, 'queued');
  assert.equal(rep.task_latest.T1.next_step, 'write the test');
  assert.equal(rep.task_latest.T1.title, 'parser EOF');
  assert.equal(rep.task_latest.T1.milestone, 'M1');
});

test('two concurrent appender processes: every line lands intact and parseable', async () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    const script = (who) => `
      import { appendEvent } from ${JSON.stringify(pathToFileURL(LEDGER_MJS).href)};
      for (let i = 0; i < 50; i++) {
        appendEvent(${JSON.stringify(p)}, { run: 'r-x', shift: 's-001', session: '${who}', actor: 'hook:test' }, 'iteration', { n: i, active_seconds: i, who: '${who}' });
      }
    `;
    const run = (who) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script(who)], { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`appender ${who} exited ${code}`))));
      });
    await Promise.all([run('alpha'), run('beta')]);
    const { result, stderr } = captureStderr(() => readLedger(p));
    assert.equal(result.length, 100, 'all 100 appends intact (single-write append atomicity)');
    assert.equal(stderr, '', 'no unparseable lines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation: archive move + genesis carrying run_totals/shift_history; fresh-file replay reproduces derived state', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'ledger', 'events.jsonl');
    const ev = (ts, event, data, shift) => appendEvent(p, { ts, run: 'r-x', shift, session: 's', actor: 'a' }, event, data);
    ev('2026-07-01T08:00:00Z', 'run_started', { goal_hash: 'g' }, null);
    ev('2026-07-01T08:01:00Z', 'shift_started', { seq: 1, operator: 'ofek', mode: 'interactive', budget: {}, implicit: false }, 's-001');
    ev('2026-07-01T09:00:00Z', 'slice_committed', { sha: 'sha-a', journal_touched: true }, 's-001');
    ev('2026-07-01T10:00:00Z', 'milestone_gate_pending', { count: 1 }, 's-001');
    ev('2026-07-01T10:05:00Z', 'approval_granted', { kind: 'human', operator: 'ofek', token: 't', granted_at: '2026-07-01T10:05:00Z', expires_at: null }, 's-001');
    ev('2026-07-01T10:06:00Z', 'approval_consumed', { kind: 'human', operator: 'ofek', milestone_count: 1 }, 's-001');
    ev('2026-07-01T12:00:00Z', 'shift_ended', { reason: 'manual', iterations: 9, active_seconds: 3600, commits: 1 }, 's-001');

    const before = replay(readLedger(p));
    const carried = {
      run_id: before.run_id,
      run_totals: before.run_totals,
      milestone_ticked_count: before.milestone_ticked_count,
      last_commit_sha: before.last_commit_sha,
      shift_history: before.shift_history,
    };
    const res = rotate(p, carried, 3); // 7 lines > 3 ⇒ rotates
    assert.ok(res, 'rotation happened');
    assert.ok(existsSync(res.archived), 'archive file exists');
    assert.ok(/events-\d{8}T\d{6}Z(-\d+)?\.jsonl$/.test(path.basename(res.archived)), 'archive naming');
    assert.equal(readFileSync(res.archived, 'utf8').split('\n').filter(Boolean).length, 7, 'archive holds the full old file');

    const freshEvents = readLedger(p);
    assert.equal(freshEvents.length, 1, 'fresh file = one genesis event');
    assert.equal(freshEvents[0].event, 'ledger_rotated');
    const after = replay(freshEvents);
    assert.equal(after.run_id, before.run_id);
    assert.deepEqual(after.run_totals, before.run_totals);
    assert.equal(after.milestone_ticked_count, before.milestone_ticked_count);
    assert.equal(after.last_commit_sha, before.last_commit_sha);
    assert.deepEqual(after.shift_history, before.shift_history, '--shifts history is rotation-proof (R11)');

    // Below threshold ⇒ no-op.
    assert.equal(rotate(p, carried, 5000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('≤4 KB line guard: oversized event throws and appends nothing', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    assert.throws(() => appendEvent(p, ENV, 'iteration', { blob: 'x'.repeat(MAX_LINE_BYTES) }), /exceeds 4096 bytes/);
    assert.equal(readLedger(p).length, 1, 'file unchanged after refused write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation sheds oldest shift_history rows when the genesis would exceed the 4 KB cap', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    for (let i = 0; i < 5; i++) appendEvent(p, ENV, 'iteration', { n: i, active_seconds: i });
    const history = Array.from({ length: 60 }, (_, i) => ({
      shift: `s-${String(i + 1).padStart(3, '0')}`, seq: i + 1, operator: 'operator-name-long-enough',
      mode: 'interactive', started: '2026-07-01T08:00:00Z', ended: '2026-07-01T12:00:00Z',
      iterations: 40, active_seconds: 21600, reason: 'budget_time', last_commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    }));
    const res = rotate(p, { run_id: 'r-x', run_totals: { shifts: 60, iterations: 2400, active_seconds: 10 }, milestone_ticked_count: 3, last_commit_sha: 'sha', shift_history: history }, 2);
    assert.ok(res, 'rotated');
    const genesis = readLedger(p)[0];
    const kept = genesis.data.carried.shift_history;
    assert.ok(kept.length > 0 && kept.length < 60, `history trimmed to fit (kept ${kept.length})`);
    assert.equal(kept[kept.length - 1].shift, 's-060', 'newest rows kept, oldest shed');
    assert.ok(Buffer.byteLength(JSON.stringify(genesis), 'utf8') < MAX_LINE_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLedger on a missing file returns [] (no ledger yet is not an error)', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readLedger(path.join(dir, 'nope.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay defensively closes an unterminated shift when a new one starts (torn shift_ended)', () => {
  const ev = (ts, event, data, shift) => ({ ts, run: 'r-x', shift, session: 's', actor: 'a', event, data });
  const rep = replay([
    ev('2026-07-01T08:00:00Z', 'shift_started', { seq: 1, operator: 'a', mode: 'interactive', budget: {}, implicit: false }, 's-001'),
    ev('2026-07-01T09:00:00Z', 'iteration', { n: 3, active_seconds: 60 }, 's-001'),
    ev('2026-07-02T08:00:00Z', 'shift_started', { seq: 2, operator: 'b', mode: 'interactive', budget: {}, implicit: false }, 's-002'),
  ]);
  assert.equal(rep.open_shift.id, 's-002');
  assert.equal(rep.shift_history.length, 1);
  assert.equal(rep.shift_history[0].shift, 's-001');
  assert.equal(rep.shift_history[0].reason, 'unknown');
  assert.equal(rep.shift_history[0].iterations, 3, 'totals fall back to the shift iteration events');
});

test('no stray files: appendEvent writes exactly the ledger file', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'events.jsonl');
    appendEvent(p, ENV, 'run_started', {});
    assert.deepEqual(readdirSync(dir), ['events.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

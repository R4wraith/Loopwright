// v3 loop-state.test.mjs — all v2 pins carried where semantics survive, plus the
// v3 substrate pins (§8/WP1): rehydration (§2.3), event-before-write + forward-only
// doctor repair (§10.4 kill simulations), shift lifecycle (§4.1), token expiry
// objects (§4.4), budget overrides (§5.2).
//
// CLI verbs are driven as REAL child processes via the LOOPWRIGHT_* env overrides
// (v2 convention); every test runs in its own temp sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  utimesSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  loadConfig,
  effectiveBudget,
  freshState,
  readState,
  writeState,
  migrateV2State,
  rehydrateFromLedger,
  incrementIteration,
  updateHeartbeat,
  setLastCommitSha,
  setApprovalToken,
  clearApprovalAndGate,
  elapsedWallClockSec,
  accumulateActiveSeconds,
  setVerifiedTreeSha,
  countTickedMilestones,
  extractOpenBlockerHighIds,
  resolveApprovalToken,
  makeApprovalToken,
  readApprovalToken,
  isTokenExpired,
  mintRunId,
  shiftIdFromSeq,
  resolveOperator,
  parseHandoffStamp,
  canOverwriteHandoff,
  buildHandoffSkeleton,
  atomicWriteFileSync,
  nowSec,
} from './loop-state.mjs';
import { appendEvent, readLedger } from './ledger.mjs';
import { parseBoard } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOP_STATE = path.join(HERE, 'loop-state.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-loop-state-'));
}

function envFor(dir, extra = {}) {
  return {
    ...process.env,
    LOOPWRIGHT_LOOP_JSON: path.join(dir, 'loop.json'),
    LOOPWRIGHT_LOOP_CONFIG: path.join(dir, 'loop-config.json'),
    LOOPWRIGHT_STATE_MD: path.join(dir, 'STATE.md'),
    LOOPWRIGHT_TASKS_MD: path.join(dir, 'TASKS.md'),
    LOOPWRIGHT_HANDOFF_MD: path.join(dir, 'HANDOFF.md'),
    LOOPWRIGHT_FINDINGS_MD: path.join(dir, 'FINDINGS.md'),
    LOOPWRIGHT_LEDGER: path.join(dir, 'ledger', 'events.jsonl'),
    LOOPWRIGHT_RUNTIME_DIR: path.join(dir, '.runtime'),
    LOOPWRIGHT_PROJECT_DIR: dir,
    LOOPWRIGHT_OPERATOR: 'testop',
    ...extra,
  };
}

function cli(dir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [LOOP_STATE, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: envFor(dir, extraEnv),
  });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function ledgerPath(dir) {
  return path.join(dir, 'ledger', 'events.jsonl');
}

function eventsOf(dir, kind) {
  return readLedger(ledgerPath(dir)).filter((e) => (kind ? e.event === kind : true));
}

// ---------------------------------------------------------------------------
// Config (v2 pins carried onto the v3 nested shape)
// ---------------------------------------------------------------------------

test('DEFAULT_CONFIG carries the v3 nested shape with the pinned values (§5.1)', () => {
  assert.equal(DEFAULT_CONFIG.shift.max_iterations, 40);
  assert.equal(DEFAULT_CONFIG.shift.max_wall_clock_sec, 21600);
  assert.equal(DEFAULT_CONFIG.shift.idle_gap_cap_sec, 600);
  assert.deepEqual(DEFAULT_CONFIG.run, { max_shifts: 0, max_iterations: 0, max_active_seconds: 0 });
  assert.equal(DEFAULT_CONFIG.milestone.gate_block_max, 3);
  assert.equal(DEFAULT_CONFIG.milestone.approval_ttl_hours, 72);
  assert.equal(DEFAULT_CONFIG.milestone.milestone_iter_soft, 12);
  assert.equal(DEFAULT_CONFIG.session.lease_stale_sec, 900);
  assert.equal(DEFAULT_CONFIG.session.stale_after_sec, 259200);
  assert.equal(DEFAULT_CONFIG.ledger.rotate_lines, 5000);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG) && Object.isFrozen(DEFAULT_CONFIG.shift));
});

test('loadConfig falls back to defaults when missing or unparseable (fail-safe)', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(loadConfig(path.join(dir, 'nope.json')).shift, { ...DEFAULT_CONFIG.shift });
    const p = path.join(dir, 'bad.json');
    writeFileSync(p, '{ not json', 'utf8');
    assert.deepEqual(loadConfig(p).run, { ...DEFAULT_CONFIG.run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig merges per-key over defaults (nested v3 shape)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop-config.json');
    writeFileSync(p, JSON.stringify({ shift: { max_iterations: 5 }, run: { max_shifts: 3 } }), 'utf8');
    const cfg = loadConfig(p);
    assert.equal(cfg.shift.max_iterations, 5);
    assert.equal(cfg.shift.max_wall_clock_sec, DEFAULT_CONFIG.shift.max_wall_clock_sec, 'unset keys keep defaults');
    assert.equal(cfg.run.max_shifts, 3);
    assert.equal(cfg.milestone.gate_block_max, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig accepts the v2 FLAT shape, mapping onto shift.*/milestone.* (upgrade tolerance, pinned)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop-config.json');
    writeFileSync(p, JSON.stringify({ max_iterations: 7, max_wall_clock_sec: 111, idle_gap_cap_sec: 120, milestone_iter_soft: 4 }), 'utf8');
    const cfg = loadConfig(p);
    assert.equal(cfg.shift.max_iterations, 7);
    assert.equal(cfg.shift.max_wall_clock_sec, 111);
    assert.equal(cfg.shift.idle_gap_cap_sec, 120);
    assert.equal(cfg.milestone.milestone_iter_soft, 4);
    // nested wins when both present:
    writeFileSync(p, JSON.stringify({ max_iterations: 7, shift: { max_iterations: 9 } }), 'utf8');
    assert.equal(loadConfig(p).shift.max_iterations, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads routines as an opaque object (menu only — no hook semantics)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop-config.json');
    writeFileSync(p, JSON.stringify({ routines: { nightly: { steps: ['/loop continue'], note: 'n' } } }), 'utf8');
    assert.deepEqual(loadConfig(p).routines.nightly.steps, ['/loop continue']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveBudget: fresh config wins, budget_override beats config (§5.2)', () => {
  const cfg = loadConfig('/nonexistent');
  const state = { budget_override: { 'shift.max_iterations': 60, 'run.max_shifts': 9 } };
  const eff = effectiveBudget(cfg, state);
  assert.equal(eff.shift.max_iterations, 60);
  assert.equal(eff.run.max_shifts, 9);
  assert.equal(eff.shift.max_wall_clock_sec, 21600, 'un-overridden keys come from config');
  assert.equal(effectiveBudget(cfg, { budget_override: null }).shift.max_iterations, 40);
  assert.equal(effectiveBudget(cfg, { budget_override: { 'shift.bogus_key': 1, 'nonsense': 2 } }).shift.max_iterations, 40, 'unknown override keys ignored');
});

// ---------------------------------------------------------------------------
// State shape + fail-safe reads (v2 pins carried onto schema 3)
// ---------------------------------------------------------------------------

test('freshState seeds the pinned flat schema-3 shape', () => {
  const s = freshState(1000, DEFAULT_CONFIG);
  assert.equal(s.schema, 3);
  assert.match(s.run_id, /^r-\d{8}T\d{4}Z$/);
  assert.equal(s.shift_id, null);
  assert.equal(s.shift_seq, 0);
  assert.equal(s.operator, null);
  assert.equal(s.mode, 'interactive');
  assert.equal(s.iteration, 0);
  assert.equal(s.started_at, 1000);
  assert.equal(s.heartbeat_at, 1000);
  assert.equal(s.active_seconds, 0);
  assert.equal(s.lease_session, null);
  assert.equal(s.lease_renewed_at, 0);
  assert.equal(s.winddown_posted, false);
  assert.equal(s.gate_blocks, 0);
  assert.equal(s.gate_winddown_posted, false);
  assert.equal(s.shift_ended, false);
  assert.deepEqual(s.budget, { ...DEFAULT_CONFIG.shift });
  assert.equal(s.budget_override, null);
  assert.deepEqual(s.run_totals, { shifts: 0, iterations: 0, active_seconds: 0 });
  assert.equal(s.milestone_gate, 'clear');
  assert.equal(s.milestone_ticked_count, 0);
  assert.equal(s.approval_token, null);
  assert.equal(s.last_commit_sha, null);
  assert.equal(s.verified_tree_sha, null);
  assert.equal(s.journal_dirty, false);
});

test('readState: missing file and corrupt JSON both return fresh state without a ledger (fail-safe, no throw)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    assert.equal(readState(p, null, DEFAULT_CONFIG, 42).iteration, 0);
    writeFileSync(p, '{{{not json', 'utf8');
    assert.equal(readState(p, null, DEFAULT_CONFIG, 42).iteration, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeState + readState round-trip; atomic write leaves no temp file', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    writeState(p, { ...freshState(100, DEFAULT_CONFIG), iteration: 7, last_commit_sha: 'abc123' });
    const back = readState(p, null, DEFAULT_CONFIG, 999);
    assert.equal(back.iteration, 7);
    assert.equal(back.last_commit_sha, 'abc123');
    assert.equal(back.started_at, 100);
    assert.deepEqual(readdirSync(dir), ['loop.json'], 'no partial/temp file left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pure transitions never mutate their input (v2 pins)', () => {
  const s0 = freshState(100, DEFAULT_CONFIG);
  const s1 = incrementIteration(s0, 200);
  assert.equal(s0.iteration, 0);
  assert.equal(s1.iteration, 1);
  assert.equal(s1.heartbeat_at, 200);
  assert.equal(updateHeartbeat(s0, 250).heartbeat_at, 250);
  assert.equal(setLastCommitSha(s0, 'deadbeef').last_commit_sha, 'deadbeef');
  assert.equal(s0.last_commit_sha, null);
  assert.equal(setVerifiedTreeSha(s0, 'tree1').verified_tree_sha, 'tree1');
  assert.equal(s0.verified_tree_sha, null);
});

test('setApprovalToken alone does NOT clear the gate; clearApprovalAndGate consumes and advances the watermark (v2 pin)', () => {
  const pending = { ...freshState(100, DEFAULT_CONFIG), milestone_gate: 'pending-approval', milestone_ticked_count: 1, gate_blocks: 2 };
  const tok = makeApprovalToken({ operator: 'ofek' }, 200);
  const withToken = setApprovalToken(pending, tok);
  assert.equal(withToken.milestone_gate, 'pending-approval', 'token set does not clear the gate');
  const cleared = clearApprovalAndGate(withToken, 2);
  assert.equal(cleared.milestone_gate, 'clear');
  assert.equal(cleared.approval_token, null);
  assert.equal(cleared.milestone_ticked_count, 2);
  assert.equal(cleared.gate_blocks, 0, 'gate-block counter resets on consume');
});

test('elapsedWallClockSec computes now - started_at (v2 pin)', () => {
  assert.equal(elapsedWallClockSec(freshState(100, DEFAULT_CONFIG), 400), 300);
});

test('accumulateActiveSeconds: v2 math carried verbatim (gap, 3h-gap cap, repeated Stops)', () => {
  const s0 = { ...freshState(1000, DEFAULT_CONFIG), heartbeat_at: 1000, active_seconds: 0 };
  assert.equal(accumulateActiveSeconds(s0, 1300, 600).active_seconds, 300, 'in-cap gap adds the real gap');
  assert.equal(s0.active_seconds, 0, 'input not mutated');
  const s1 = { ...freshState(1000, DEFAULT_CONFIG), heartbeat_at: 1000, active_seconds: 40 };
  assert.equal(accumulateActiveSeconds(s1, 1000 + 10800, 600).active_seconds, 640, '3h idle gap adds exactly the cap (209% bug)');
  let s = { ...freshState(0, DEFAULT_CONFIG), heartbeat_at: 0, active_seconds: 0 };
  s = updateHeartbeat(accumulateActiveSeconds(s, 100, 600), 100);
  s = updateHeartbeat(accumulateActiveSeconds(s, 250, 600), 250);
  assert.equal(s.active_seconds, 250, 'accumulates across Stops, caller advances heartbeat');
});

test('countTickedMilestones: section-scoped, fail-safe (v2 pins)', () => {
  const md = ['# STATE', '', '## Milestones', '- [x] M1', '- [ ] M2', '- [x] M3', '', '## Compaction anchor', '- [x] not a milestone'].join('\n');
  assert.equal(countTickedMilestones(md), 2);
  assert.equal(countTickedMilestones('# STATE\n\nnothing\n'), 0);
  assert.equal(countTickedMilestones(''), 0);
  assert.equal(countTickedMilestones(undefined), 0);
});

test('extractOpenBlockerHighIds: same positional FINDINGS grammar as precompact-anchor', () => {
  const md = [
    '| ID | sev | type | status | mitigation | verified | source |',
    '|----|-----|------|--------|------------|----------|--------|',
    '| F1 | high | injection | open | fix | — | reviewer |',
    '| F2 | low | dos | open | fix | — | reviewer |',
    '| F3 | blocker | authz | verified | done | rev | reviewer |',
  ].join('\n');
  assert.deepEqual(extractOpenBlockerHighIds(md), ['F1']);
  assert.deepEqual(extractOpenBlockerHighIds(''), []);
});

// ---------------------------------------------------------------------------
// Approval tokens (v2 value minting carried + v3 object/expiry)
// ---------------------------------------------------------------------------

test('resolveApprovalToken: v2 value shapes carried verbatim', () => {
  assert.equal(resolveApprovalToken({ self: true, rationale: 'standing authorization' }, 1000), 'self:standing authorization');
  assert.equal(resolveApprovalToken({ self: true }, 1000), `self:${new Date(1000 * 1000).toISOString()}`);
  assert.equal(resolveApprovalToken({}, 1000), 'approved-1000');
  assert.equal(resolveApprovalToken({ explicitToken: 'human-ok' }, 1000), 'human-ok');
  assert.equal(resolveApprovalToken({ self: true, rationale: 'why', explicitToken: 'ignored' }, 1000), 'self:why');
});

test('makeApprovalToken builds the §4.4 object: class, operator, granted_at, expires_at = granted + TTL', () => {
  const tok = makeApprovalToken({ operator: 'ofek', ttlHours: 72 }, 1000);
  assert.equal(tok.class, 'human');
  assert.equal(tok.operator, 'ofek');
  assert.equal(tok.granted_at, '1970-01-01T00:16:40Z');
  assert.equal(tok.expires_at, '1970-01-04T00:16:40Z');
  const self = makeApprovalToken({ self: true, rationale: 'standing', operator: 'auto', ttlHours: 0 }, 1000);
  assert.equal(self.class, 'self');
  assert.match(self.value, /^self:/);
  assert.equal(self.expires_at, null, 'ttl 0 ⇒ no expiry');
});

test('readApprovalToken: legacy v2 STRING tokens read as {class:"human", operator:"unknown", no expiry} (pinned)', () => {
  const legacy = readApprovalToken('approved-12345');
  assert.deepEqual(legacy, { value: 'approved-12345', class: 'human', operator: 'unknown', granted_at: null, expires_at: null });
  const legacySelf = readApprovalToken('self:why');
  assert.equal(legacySelf.class, 'human', 'spec letter: ALL legacy strings read as human/no-expiry');
  assert.equal(readApprovalToken(null), null);
  const obj = readApprovalToken({ value: 'v', class: 'self', operator: 'ofek', granted_at: 'g', expires_at: 'e' });
  assert.equal(obj.class, 'self');
});

test('isTokenExpired: past expiry ⇒ true; before ⇒ false; no expiry (legacy) ⇒ never', () => {
  const tok = makeApprovalToken({ operator: 'o', ttlHours: 1 }, 1000); // expires at 4600
  assert.equal(isTokenExpired(tok, 1000), false);
  assert.equal(isTokenExpired(tok, 4599), false);
  assert.equal(isTokenExpired(tok, 4600), true);
  assert.equal(isTokenExpired(tok, 999999), true);
  assert.equal(isTokenExpired('approved-1', 999999999), false, 'legacy strings never expire');
  assert.equal(isTokenExpired(null, 1), false);
});

// ---------------------------------------------------------------------------
// Identity + HANDOFF stamp grammar
// ---------------------------------------------------------------------------

test('mintRunId / shiftIdFromSeq produce the pinned id shapes', () => {
  assert.match(mintRunId(1783300000), /^r-\d{8}T\d{4}Z$/);
  assert.equal(shiftIdFromSeq(1), 's-001');
  assert.equal(shiftIdFromSeq(42), 's-042');
  assert.equal(shiftIdFromSeq(1234), 's-1234');
});

test('parseHandoffStamp reads the §4.3 stamp line; canOverwriteHandoff enforces the anti-clobber guard', () => {
  const authored = [
    '# HANDOFF — shift s-007',
    '_Written: 2026-07-04T23:58:01Z · operator: ofek · kind: authored · shift-open: no_',
    '**Run:** r-x · **Shift:** s-007 (a → b) · **End reason:** budget_time',
  ].join('\n');
  const stamp = parseHandoffStamp(authored);
  assert.deepEqual(stamp, { shift: 's-007', written: '2026-07-04T23:58:01Z', operator: 'ofek', kind: 'authored', shift_open: false });
  // authored always wins for its own shift:
  assert.equal(canOverwriteHandoff(authored, 's-007'), false);
  // a different shift's handoff is overwritable:
  assert.equal(canOverwriteHandoff(authored, 's-008'), true);
  // same shift, non-authored kind is overwritable:
  const checkpoint = authored.replace('kind: authored', 'kind: auto-checkpoint').replace('shift-open: no', 'shift-open: yes');
  assert.equal(parseHandoffStamp(checkpoint).kind, 'auto-checkpoint');
  assert.equal(canOverwriteHandoff(checkpoint, 's-007'), true);
  // the shipped empty-by-design placeholder has no stamp — always writable:
  assert.equal(canOverwriteHandoff("# HANDOFF\n_No handoff yet — first shift hasn't ended._\n", 's-001'), true);
  assert.equal(parseHandoffStamp(''), null);
});

test('buildHandoffSkeleton emits the exact §4.3 stamp grammar and all sections', () => {
  const text = buildHandoffSkeleton({
    shiftId: 's-003',
    runId: 'r-20260704T0800Z',
    operator: 'auto',
    kind: 'crash-backfill',
    shiftOpen: false,
    startedIso: '2026-07-04T18:00:00Z',
    endedIso: '2026-07-04T23:58:01Z',
    endReason: 'crash',
    shipped: ['a1b2c3d'],
    active: { id: 'T14', status: 'verifying', next_step: 're-run T2 verify' },
    uncommitted: ' M src/parser.rs',
    findings: ['F12'],
    shiftBudgetLine: '38/40 iterations · 21410/21600 s active',
    runBudgetLine: '7 shifts · 214 iterations · 96300 s active (run ceilings: unlimited)',
    nowIso: '2026-07-04T23:58:01Z',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '# HANDOFF — shift s-003');
  assert.equal(lines[1], '_Written: 2026-07-04T23:58:01Z · operator: auto · kind: crash-backfill · shift-open: no_');
  const reparsed = parseHandoffStamp(text);
  assert.equal(reparsed.kind, 'crash-backfill');
  assert.equal(reparsed.shift, 's-003');
  for (const section of ['## What shipped', '## In flight — exact next step', '## Open findings (blocker/high)', '## Budget', '## Warnings / gotchas', '## Next-shift orders']) {
    assert.ok(text.includes(section), `missing ${section}`);
  }
  assert.ok(text.includes('**Task:** T14 (verifying) — next: re-run T2 verify'));
  assert.ok(text.includes('a1b2c3d'));
  assert.ok(text.includes('F12'));
  assert.ok(text.includes('**End reason:** crash'));
});

// ---------------------------------------------------------------------------
// v2 loop.json migration (in-memory, §7.2c)
// ---------------------------------------------------------------------------

test('a v2 flat loop.json (no schema field) migrates in-memory: position preserved, never reset', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    writeFileSync(p, JSON.stringify({
      run_id: '2026-07-01T08:00:00.000Z',
      iteration: 7,
      started_at: 100,
      heartbeat_at: 200,
      last_commit_sha: 'abc',
      milestone_gate: 'pending-approval',
      milestone_ticked_count: 2,
      approval_token: 'self:why',
      budget: { max_iterations: 10, max_wall_clock_sec: 111, milestone_iter_soft: 12, idle_gap_cap_sec: 60 },
      active_seconds: 50,
      verified_tree_sha: 'tree1',
      winddown_posted: false,
    }), 'utf8');
    const s = readState(p, null, DEFAULT_CONFIG, 5000);
    assert.equal(s.schema, 3);
    assert.equal(s.shift_id, 's-001', 'the v2 run becomes shift s-001');
    assert.equal(s.shift_seq, 1);
    assert.match(s.run_id, /^r-/, 'v3 run_id minted');
    assert.equal(s.iteration, 7);
    assert.equal(s.active_seconds, 50);
    assert.deepEqual(s.run_totals, { shifts: 1, iterations: 7, active_seconds: 50 });
    assert.equal(s.milestone_gate, 'pending-approval');
    assert.equal(s.milestone_ticked_count, 2);
    assert.equal(s.approval_token, 'self:why', 'legacy string token kept as-is (readApprovalToken normalizes)');
    assert.equal(s.last_commit_sha, 'abc');
    assert.equal(s.verified_tree_sha, 'tree1');
    assert.deepEqual(s.budget, { max_iterations: 10, max_wall_clock_sec: 111, idle_gap_cap_sec: 60 });
    // direct helper too:
    const m = migrateV2State({ iteration: 3 }, DEFAULT_CONFIG, 1000);
    assert.equal(m.run_totals.iterations, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: --init
// ---------------------------------------------------------------------------

test('--init appends run_started + shift_started(s-001) and writes loop.json; second --init refuses overwrite', () => {
  const dir = tmpDir();
  try {
    const r = cli(dir, ['--init']);
    assert.equal(r.status, 0, r.stderr);
    const state = readJson(path.join(dir, 'loop.json'));
    assert.equal(state.schema, 3);
    assert.equal(state.shift_id, 's-001');
    assert.equal(state.shift_seq, 1);
    assert.equal(state.operator, 'testop');
    assert.equal(state.run_totals.shifts, 1);
    const started = eventsOf(dir, 'run_started');
    assert.equal(started.length, 1);
    assert.equal(started[0].actor, 'cli:init');
    const shifts = eventsOf(dir, 'shift_started');
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0].shift, 's-001');
    assert.equal(shifts[0].data.seq, 1);
    assert.equal(shifts[0].data.operator, 'testop');
    assert.equal(shifts[0].data.implicit, false);
    const again = cli(dir, ['--init']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already exists .* not overwriting/);
    assert.equal(eventsOf(dir, 'run_started').length, 1, 'no duplicate genesis');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §10.4 kill simulation 2: loop.json deleted mid-shift → rehydrate restores the
// full §2.3 enumerated list including open-shift counters.
// ---------------------------------------------------------------------------

test('rehydrateFromLedger restores every §2.3 field with loop.json deleted mid-shift', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const lp = path.join(dir, 'loop.json');
    const baseline0 = readJson(lp);
    const runId = baseline0.run_id;
    const lg = ledgerPath(dir);
    // budget-stop-style iteration events (WP2 emits these on every allowed Stop):
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:budget-stop' }, 'iteration', { n: 1, active_seconds: 120 });
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:budget-stop' }, 'iteration', { n: 2, active_seconds: 340 });
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:budget-stop' }, 'iteration', { n: 3, active_seconds: 500 });
    // a committed slice, then a verified (staged) next slice:
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:journal-integrity' }, 'slice_committed', { sha: 'c0ffee1234', journal_touched: true });
    assert.equal(cli(dir, ['--set-verified-tree', 'treesha9999', '--task', 'T1', '--tier', 'T1']).status, 0);
    // gate armed + token granted but not yet consumed:
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:budget-stop' }, 'milestone_gate_pending', { count: 1 });
    assert.equal(cli(dir, ['--approve', '--operator', 'ofek']).status, 0);
    // shift-scope wind-down was posted:
    appendEvent(lg, { run: runId, shift: 's-001', session: 'sess-a', actor: 'hook:budget-stop' }, 'winddown_posted', { scope: 'shift', reason: 'budget_iterations' });

    const baseline = readJson(lp);
    unlinkSync(lp); // kill the cache
    const s = readState(lp, lg, DEFAULT_CONFIG, nowSec());

    assert.equal(s.run_id, runId, '§2.3.1 run_id');
    assert.equal(s.milestone_gate, 'pending-approval', '§2.3.3 gate');
    const tok = readApprovalToken(s.approval_token);
    assert.equal(tok.operator, 'ofek', '§2.3.4 approval token restored with operator');
    assert.equal(tok.class, 'human');
    assert.equal(tok.expires_at, readApprovalToken(baseline.approval_token).expires_at, 'expiry restored');
    assert.equal(s.last_commit_sha, 'c0ffee1234', '§2.3.5 last_commit_sha (no HEAD forgiveness)');
    assert.equal(s.verified_tree_sha, 'treesha9999', '§2.3.6 verified stamp survives (no later commit)');
    assert.deepEqual(s.run_totals, { shifts: 1, iterations: 0, active_seconds: 0 }, '§2.3.7 + open shift counted');
    assert.equal(s.shift_id, 's-001', '§2.3.8 open shift restored');
    assert.equal(s.shift_seq, 1);
    assert.equal(s.operator, 'testop');
    assert.equal(s.iteration, 3, 'open-shift iteration from iteration events (max n)');
    assert.equal(s.active_seconds, 500, 'open-shift active_seconds from last iteration event');
    assert.equal(s.winddown_posted, true, 'winddown flag from winddown_posted{scope:shift}');
    assert.equal(s.shift_ended, false);
    assert.equal(s.lease_session, null, '§2.3.9 lease never rehydrated');
    assert.equal(s.lease_renewed_at, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rehydrate after a clean shift end: no open shift, shift_ended true, totals folded', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const runId = readJson(path.join(dir, 'loop.json')).run_id;
    appendEvent(ledgerPath(dir), { run: runId, shift: 's-001', session: 's', actor: 'hook:budget-stop' }, 'iteration', { n: 5, active_seconds: 111 });
    // model closed the shift cleanly:
    unlinkSync(path.join(dir, 'loop.json'));
    let s = readState(path.join(dir, 'loop.json'), ledgerPath(dir), DEFAULT_CONFIG, nowSec());
    writeState(path.join(dir, 'loop.json'), s);
    assert.equal(cli(dir, ['--end-shift', '--reason', 'manual']).status, 0);
    unlinkSync(path.join(dir, 'loop.json'));
    s = readState(path.join(dir, 'loop.json'), ledgerPath(dir), DEFAULT_CONFIG, nowSec());
    assert.equal(s.shift_id, null);
    assert.equal(s.shift_ended, true, 'closed run position: Stop allows until a new shift starts');
    assert.equal(s.run_totals.shifts, 1);
    assert.equal(s.run_totals.iterations, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: --task + §10.4 kill simulation 1 (event-before-write, forward-only repair)
// ---------------------------------------------------------------------------

test('--task new creates the row (event first), --task --to transitions it, illegal transitions refused', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    let r = cli(dir, ['--task', 'new', '--title', 'parser first slice', '--milestone', 'M1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^T1 created \(queued\)/);
    const created = eventsOf(dir, 'task_created');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].data, { task: 'T1', title: 'parser first slice', milestone: 'M1' });

    r = cli(dir, ['--task', 'T1', '--to', 'in_progress', '--next', 'write the failing test']);
    assert.equal(r.status, 0, r.stderr);
    const board = parseBoard(readFileSync(path.join(dir, 'TASKS.md'), 'utf8'));
    assert.equal(board.rows[0].status, 'in_progress');
    assert.equal(board.rows[0].next_step, 'write the failing test');
    const statusEvents = eventsOf(dir, 'task_status');
    assert.equal(statusEvents.length, 1);
    assert.deepEqual(statusEvents[0].data, { task: 'T1', from: 'queued', to: 'in_progress', next_step: 'write the failing test' });

    r = cli(dir, ['--task', 'T1', '--to', 'queued']);
    assert.equal(r.status, 1, 'backward move refused');
    assert.match(r.stderr, /illegal transition/);
    assert.equal(eventsOf(dir, 'task_status').length, 1, 'no event appended for a refused transition');

    r = cli(dir, ['--task', 'T9', '--to', 'done']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no live board row/);

    r = cli(dir, ['--task', 'T1', '--to', 'sideways']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('KILL SIM (§10.4): task event appended but board write lost → --doctor --repair completes FORWARD; hand edits are never rolled back', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--task', 'new', '--title', 'a slice', '--milestone', 'M1']).status, 0);
    const runId = readJson(path.join(dir, 'loop.json')).run_id;
    // Simulate the crash window: the CLI appended the event, then died before the
    // board write (event-before-write ordering makes this the ONLY possible tear).
    appendEvent(ledgerPath(dir), { run: runId, shift: 's-001', session: 'cli', actor: 'cli:task' }, 'task_status', { task: 'T1', from: 'queued', to: 'in_progress', next_step: 'resume here' });

    let r = cli(dir, ['--doctor']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T1 board says queued but ledger says in_progress/, 'doctor detects the tear');

    r = cli(dir, ['--doctor', '--repair']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /repaired — T1 completed forward queued → in_progress/);
    const board = parseBoard(readFileSync(path.join(dir, 'TASKS.md'), 'utf8'));
    assert.equal(board.rows[0].status, 'in_progress');
    assert.equal(board.rows[0].next_step, 'resume here', 'next step completed forward too');

    // Hand edit: human sets the row to verifying with NO ledger event. Ledger's
    // last word is in_progress — doctor reports, repair must NOT revert (R25).
    const md = readFileSync(path.join(dir, 'TASKS.md'), 'utf8').replace('| in_progress |', '| verifying |');
    writeFileSync(path.join(dir, 'TASKS.md'), md, 'utf8');
    r = cli(dir, ['--doctor', '--repair']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hand edit\? reported only, never reverted/);
    const after = parseBoard(readFileSync(path.join(dir, 'TASKS.md'), 'utf8'));
    assert.equal(after.rows[0].status, 'verifying', 'markdown wins for intent — row untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--task updates the session pointer when LOOPWRIGHT_SESSION_ID is set, and skips with a greppable note when unset', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--task', 'new', '--title', 't', '--milestone', 'M1']).status, 0);
    let r = cli(dir, ['--task', 'T1', '--to', 'in_progress'], { LOOPWRIGHT_SESSION_ID: 'sess-42' });
    assert.equal(r.status, 0, r.stderr);
    const ptr = readJson(path.join(dir, '.runtime', 'sessions', 'sess-42.json'));
    assert.equal(ptr.active_task, 'T1');
    r = cli(dir, ['--task', 'T1', '--to', 'blocked'], { LOOPWRIGHT_SESSION_ID: 'sess-42' });
    assert.equal(r.status, 0);
    assert.equal(readJson(path.join(dir, '.runtime', 'sessions', 'sess-42.json')).active_task, null, 'blocked clears the pointer');
    // unset: greppable skip note, board still written
    r = cli(dir, ['--task', 'T1', '--to', 'in_progress']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /session pointer not updated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: shift lifecycle (§4.1)
// ---------------------------------------------------------------------------

test('--end-shift appends shift_ended (event before write), folds run_totals, sets shift_ended; refuses when nothing is open', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const runId = readJson(path.join(dir, 'loop.json')).run_id;
    appendEvent(ledgerPath(dir), { run: runId, shift: 's-001', session: 's', actor: 'hook:budget-stop' }, 'slice_committed', { sha: 'aaa', journal_touched: true });
    // give the shift some position:
    let st = readJson(path.join(dir, 'loop.json'));
    st.iteration = 4;
    st.active_seconds = 99;
    writeState(path.join(dir, 'loop.json'), st);

    let r = cli(dir, ['--end-shift', '--reason', 'manual']);
    assert.equal(r.status, 0, r.stderr);
    const ended = eventsOf(dir, 'shift_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].data.reason, 'manual');
    assert.equal(ended[0].data.iterations, 4);
    assert.equal(ended[0].data.commits, 1, 'commits counted from the shift slice_committed events');
    const after = readJson(path.join(dir, 'loop.json'));
    assert.equal(after.shift_ended, true);
    assert.equal(after.run_totals.iterations, 4);
    assert.ok(after.run_totals.active_seconds >= 99);
    assert.equal(after.lease_session, null);

    r = cli(dir, ['--end-shift']);
    assert.equal(r.status, 1, 'no open shift to end');
    r = cli(dir, ['--start-shift']);
    assert.equal(r.status, 0);
    r = cli(dir, ['--end-shift', '--reason', 'sideways']);
    assert.equal(r.status, 1, 'unknown reason refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--start-shift resets per-shift fields, PRESERVES watermarks/approvals, increments run_totals.shifts', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    let st = readJson(path.join(dir, 'loop.json'));
    st.iteration = 9;
    st.active_seconds = 500;
    st.winddown_posted = true;
    st.gate_blocks = 2;
    st.gate_winddown_posted = true;
    st.milestone_ticked_count = 3;
    st.last_commit_sha = 'keepme';
    st.verified_tree_sha = 'keeptree';
    st.approval_token = { value: 'v', class: 'human', operator: 'ofek', granted_at: 'g', expires_at: null };
    writeState(path.join(dir, 'loop.json'), st);
    assert.equal(cli(dir, ['--end-shift']).status, 0);

    const r = cli(dir, ['--start-shift', '--operator', 'nightop', '--mode', 'headless', '--budget-iters', '12']);
    assert.equal(r.status, 0, r.stderr);
    const after = readJson(path.join(dir, 'loop.json'));
    assert.equal(after.shift_id, 's-002');
    assert.equal(after.shift_seq, 2);
    assert.equal(after.operator, 'nightop', 'flag beats env (operator chain)');
    assert.equal(after.mode, 'headless');
    assert.equal(after.iteration, 0, 'per-shift counters reset');
    assert.equal(after.active_seconds, 0);
    assert.equal(after.winddown_posted, false);
    assert.equal(after.gate_blocks, 0);
    assert.equal(after.gate_winddown_posted, false);
    assert.equal(after.shift_ended, false);
    assert.equal(after.run_totals.shifts, 2, 'run_totals.shifts incremented');
    assert.equal(after.run_totals.iterations, 9, 'closed-shift totals kept');
    assert.equal(after.milestone_ticked_count, 3, 'watermark NEVER touched by shift start');
    assert.equal(after.last_commit_sha, 'keepme');
    assert.equal(after.verified_tree_sha, 'keeptree');
    assert.equal(after.approval_token.value, 'v', 'approval never touched by shift start');
    assert.deepEqual(after.budget_override, { 'shift.max_iterations': 12 });
    assert.equal(after.budget.max_iterations, 12, 'snapshot reflects the effective per-shift override');
    const started = eventsOf(dir, 'shift_started');
    assert.equal(started.length, 2);
    assert.equal(started[1].data.operator, 'nightop');
    assert.equal(started[1].data.mode, 'headless');
    assert.equal(started[1].data.budget.max_iterations, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--start-shift refuses on run exhaustion (exit 1) until --extend-budget run.* unblocks it', () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, 'loop-config.json'), JSON.stringify({ run: { max_shifts: 1 } }), 'utf8');
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--end-shift']).status, 0);
    let r = cli(dir, ['--start-shift']);
    assert.equal(r.status, 1, 'refused: 1/1 shifts');
    assert.match(r.stderr, /run budget exhausted \(1\/1 shifts\)/);
    assert.match(r.stderr, /--extend-budget run\./);
    assert.equal(eventsOf(dir, 'shift_started').length, 1, 'nothing appended by a refusal');

    r = cli(dir, ['--extend-budget', 'run.max_shifts=3', '--operator', 'ofek']);
    assert.equal(r.status, 0, r.stderr);
    const ext = eventsOf(dir, 'budget_extended');
    assert.equal(ext.length, 1);
    assert.deepEqual(ext[0].data, { scope: 'run', key: 'max_shifts', from: 1, to: 3, operator: 'ofek' });
    assert.deepEqual(readJson(path.join(dir, 'loop.json')).budget_override, { 'run.max_shifts': 3 });

    r = cli(dir, ['--start-shift']);
    assert.equal(r.status, 0, `extension unblocks the start: ${r.stderr}`);
    const after = readJson(path.join(dir, 'loop.json'));
    assert.equal(after.shift_id, 's-002');
    assert.deepEqual(after.budget_override, { 'run.max_shifts': 3 }, 'run.* extension persists across shift start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--extend-budget rejects malformed specs and unknown keys', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--extend-budget', 'nonsense']).status, 1);
    assert.equal(cli(dir, ['--extend-budget', 'run.bogus=5']).status, 1);
    assert.equal(cli(dir, ['--extend-budget', 'milestone.gate_block_max=5']).status, 1, 'only shift|run scopes are budget');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash vs auto_stale close labeling at explicit shift start (§4.1.5); fresh lease refuses', () => {
  const dir = tmpDir();
  try {
    // auto_stale: open shift, lease cleanly released.
    assert.equal(cli(dir, ['--init']).status, 0);
    let r = cli(dir, ['--start-shift', '--operator', 'day2']);
    assert.equal(r.status, 0, r.stderr);
    let ended = eventsOf(dir, 'shift_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].data.reason, 'auto_stale', 'released lease ⇒ deliberate suspension, not crash');
    assert.equal(readJson(path.join(dir, 'loop.json')).shift_id, 's-002');

    // crash: lease held and stale.
    let st = readJson(path.join(dir, 'loop.json'));
    st.lease_session = 'dead-session';
    st.lease_renewed_at = nowSec() - 3600; // > lease_stale_sec (900)
    st.iteration = 2;
    writeState(path.join(dir, 'loop.json'), st);
    r = cli(dir, ['--start-shift', '--operator', 'day3']);
    assert.equal(r.status, 0, r.stderr);
    ended = eventsOf(dir, 'shift_ended');
    assert.equal(ended.length, 2);
    assert.equal(ended[1].data.reason, 'crash', 'held-and-stale lease ⇒ crash');
    assert.equal(ended[1].data.iterations, 2, 'totals from the dead shift');
    // crash-backfill HANDOFF written (no authored handoff existed):
    const stamp = parseHandoffStamp(readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'));
    assert.equal(stamp.kind, 'crash-backfill');
    assert.equal(stamp.shift, 's-002');
    const hw = eventsOf(dir, 'handoff_written');
    assert.equal(hw[hw.length - 1].data.kind, 'crash-backfill');

    // fresh lease: refuse to yank a live shift.
    st = readJson(path.join(dir, 'loop.json'));
    st.lease_session = 'live-session';
    st.lease_renewed_at = nowSec();
    writeState(path.join(dir, 'loop.json'), st);
    r = cli(dir, ['--start-shift']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /holds the lease/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash close respects the stamp guard: an authored HANDOFF for the dying shift is never clobbered', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const authored = [
      '# HANDOFF — shift s-001',
      '_Written: 2026-07-04T20:00:00Z · operator: testop · kind: authored · shift-open: no_',
      'precious human-authored content',
      '',
    ].join('\n');
    writeFileSync(path.join(dir, 'HANDOFF.md'), authored, 'utf8');
    let st = readJson(path.join(dir, 'loop.json'));
    st.lease_session = 'dead';
    st.lease_renewed_at = 1;
    writeState(path.join(dir, 'loop.json'), st);
    const r = cli(dir, ['--start-shift']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /stamp guard/);
    assert.equal(readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'), authored, 'authored handoff byte-identical');
    assert.equal(eventsOf(dir, 'handoff_written').length, 0, 'no handoff_written event for a skipped write');
    assert.equal(eventsOf(dir, 'shift_ended')[0].data.reason, 'crash', 'the close itself still happened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: --approve / --set-verified-tree / --record-handoff / --log-routine / --complete-run
// ---------------------------------------------------------------------------

test('--approve writes the token OBJECT and the approval_granted event (who approved and when, durable)', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    let r = cli(dir, ['--approve', '--operator', 'ofek']);
    assert.equal(r.status, 0, r.stderr);
    const st = readJson(path.join(dir, 'loop.json'));
    assert.equal(st.approval_token.class, 'human');
    assert.equal(st.approval_token.operator, 'ofek');
    assert.ok(st.approval_token.expires_at, '72h TTL stamped');
    assert.equal(st.milestone_gate, 'clear', 'token set never pre-clears or arms the gate');
    const granted = eventsOf(dir, 'approval_granted');
    assert.equal(granted.length, 1);
    assert.equal(granted[0].data.kind, 'human');
    assert.equal(granted[0].data.operator, 'ofek');
    assert.equal(granted[0].data.expires_at, st.approval_token.expires_at);

    r = cli(dir, ['--approve', '--self', 'standing authorization', '--operator', 'auto']);
    assert.equal(r.status, 0);
    const g2 = eventsOf(dir, 'approval_granted')[1];
    assert.equal(g2.data.kind, 'self');
    assert.match(g2.data.token, /^self:standing authorization$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--set-verified-tree with an explicit sha emits slice_verified{task, tier, tree_sha} and stamps loop.json', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const r = cli(dir, ['--set-verified-tree', 'abc123tree', '--task', 'T3', '--tier', 'T2']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(path.join(dir, 'loop.json')).verified_tree_sha, 'abc123tree');
    const ev = eventsOf(dir, 'slice_verified');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].data, { task: 'T3', tier: 'T2', tree_sha: 'abc123tree' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--set-verified-tree defaults to the STAGED tree via git write-tree (v2 semantics carried)', (t) => {
  const dir = tmpDir();
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (git('init').status !== 0) {
      t.skip('git unavailable');
      return;
    }
    writeFileSync(path.join(dir, 'file.txt'), 'slice content\n', 'utf8');
    git('add', '-A');
    const expected = git('write-tree').stdout.trim();
    assert.equal(cli(dir, ['--init']).status, 0);
    const r = cli(dir, ['--set-verified-tree']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(path.join(dir, 'loop.json')).verified_tree_sha, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--record-handoff: authored requires the file and appends the event; auto-checkpoint writes a stamp-guarded skeleton with shift-open: yes', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    let r = cli(dir, ['--record-handoff']);
    assert.equal(r.status, 1, 'authored without a HANDOFF.md refuses');

    // /pause path first: mechanical checkpoint, shift stays open.
    r = cli(dir, ['--record-handoff', '--kind', 'auto-checkpoint']);
    assert.equal(r.status, 0, r.stderr);
    const stamp = parseHandoffStamp(readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'));
    assert.equal(stamp.kind, 'auto-checkpoint');
    assert.equal(stamp.shift, 's-001');
    assert.equal(stamp.shift_open, true, '/pause never ends the shift');
    assert.equal(readJson(path.join(dir, 'loop.json')).shift_ended, false);
    assert.equal(eventsOf(dir, 'handoff_written')[0].data.kind, 'auto-checkpoint');

    // model authors the real handoff over the checkpoint (allowed — kind ≠ authored):
    writeFileSync(path.join(dir, 'HANDOFF.md'), [
      '# HANDOFF — shift s-001',
      '_Written: 2026-07-04T23:00:00Z · operator: testop · kind: authored · shift-open: no_',
      'full authored handoff',
      '',
    ].join('\n'), 'utf8');
    r = cli(dir, ['--record-handoff', '--kind', 'authored']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(eventsOf(dir, 'handoff_written')[1].data.kind, 'authored');

    // a later auto-checkpoint for the SAME shift must not clobber authored:
    r = cli(dir, ['--record-handoff', '--kind', 'auto-checkpoint']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /stamp guard/);
    assert.match(readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'), /full authored handoff/);
    assert.equal(eventsOf(dir, 'handoff_written').length, 2, 'skipped write appends no event');

    r = cli(dir, ['--record-handoff', '--kind', 'crash-backfill']);
    assert.equal(r.status, 1, 'crash-backfill is --start-shift-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--log-routine appends routine_run; --complete-run appends run_completed', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--log-routine', 'full-check']).status, 0);
    assert.deepEqual(eventsOf(dir, 'routine_run')[0].data, { name: 'full-check' });
    assert.equal(cli(dir, ['--log-routine']).status, 1, 'name required');
    assert.equal(cli(dir, ['--complete-run']).status, 0);
    assert.equal(eventsOf(dir, 'run_completed').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: --status / --shifts (incl. rotation) / --doctor
// ---------------------------------------------------------------------------

test('--status --json is the machine surface: run headroom, shift, gate, token, tasks, handoff kind, doctor summary', () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, 'loop-config.json'), JSON.stringify({ run: { max_shifts: 1 } }), 'utf8');
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--task', 'new', '--title', 't', '--milestone', 'M1']).status, 0);
    assert.equal(cli(dir, ['--task', 'T1', '--to', 'in_progress', '--next', 'do the thing']).status, 0);
    assert.equal(cli(dir, ['--approve', '--operator', 'ofek']).status, 0);
    const r = cli(dir, ['--status', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.run.headroom, false, '1/1 shifts used ⇒ no headroom (run-shift.sh consumes this)');
    assert.equal(j.run.exhausted, '1/1 shifts');
    assert.equal(j.shift.id, 's-001');
    assert.equal(j.shift.open, true);
    assert.equal(j.shift.operator, 'testop');
    assert.equal(j.gate, 'clear');
    assert.equal(j.approval_token.operator, 'ofek');
    assert.equal(j.approval_token.expired, false);
    assert.equal(j.tasks.open, 1);
    assert.deepEqual(j.tasks.active, { id: 'T1', status: 'in_progress', next_step: 'do the thing' });
    assert.equal(j.handoff, null, 'no handoff yet');
    assert.equal(j.doctor.ledger_unparseable, 0);
    // human rendering mentions the same facts:
    const h = cli(dir, ['--status']);
    assert.match(h.stdout, /headroom: NO \(1\/1 shifts\)/);
    assert.match(h.stdout, /shift s-001 \(testop, interactive\) · open/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--status flags a non-authored current handoff as thin', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--record-handoff', '--kind', 'auto-checkpoint']).status, 0);
    const j = JSON.parse(cli(dir, ['--status', '--json']).stdout);
    assert.equal(j.handoff.kind, 'auto-checkpoint');
    assert.equal(j.handoff.thin, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--shifts renders full history ACROSS rotation (genesis shift_history — R11)', () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, 'loop-config.json'), JSON.stringify({ ledger: { rotate_lines: 2 } }), 'utf8');
    assert.equal(cli(dir, ['--init']).status, 0);
    let r = cli(dir, ['--end-shift', '--reason', 'manual']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ledger rotated → /, 'shift end triggered rotation');
    assert.equal(cli(dir, ['--start-shift', '--operator', 'op2']).status, 0);
    assert.equal(cli(dir, ['--end-shift', '--reason', 'budget_time']).status, 0);
    const archive = readdirSync(path.join(dir, 'ledger', 'archive')).filter((f) => f.endsWith('.jsonl'));
    assert.ok(archive.length >= 1, 'archive holds rotated file(s)');
    r = cli(dir, ['--shifts']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /s-001 · testop .* manual/);
    assert.match(r.stdout, /s-002 · op2 .* budget_time/);
    assert.match(r.stdout, /2 shift\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--doctor detects orphan temp files (and GCs old ones with --repair) and torn ledger tails', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    // torn tail:
    appendFileSync(ledgerPath(dir), '{"ts":"2026-07-0');
    // fresh orphan (left alone) + old orphan (GC'd):
    const freshTmp = path.join(dir, 'STATE.md.tmp-111-222');
    const oldTmp = path.join(dir, 'TASKS.md.tmp-333-444');
    writeFileSync(freshTmp, 'x', 'utf8');
    writeFileSync(oldTmp, 'x', 'utf8');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(oldTmp, old, old);

    let r = cli(dir, ['--doctor']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ledger has 1 unparseable line\(s\)/);
    assert.match(r.stdout, /orphan temp file .*STATE\.md\.tmp-111-222.*younger than 1h/);
    assert.match(r.stdout, /orphan temp file .*TASKS\.md\.tmp-333-444/);
    assert.match(r.stdout, /doctor: \d+ issue\(s\) found/);

    r = cli(dir, ['--doctor', '--repair']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /removed orphan temp .*TASKS\.md\.tmp-333-444/);
    assert.ok(!existsSync(oldTmp), 'old orphan removed');
    assert.ok(existsSync(freshTmp), 'young orphan left alone (might be a live write)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--doctor reports lease state and sweeps stale session files with --repair', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    const sessions = path.join(dir, '.runtime', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, 'old.json'), JSON.stringify({ session_id: 'old', last_seen_at: 1000 }), 'utf8');
    writeFileSync(path.join(sessions, 'fresh.json'), JSON.stringify({ session_id: 'fresh', last_seen_at: nowSec() }), 'utf8');
    let r = cli(dir, ['--doctor']);
    assert.match(r.stdout, /stale session file old\.json/);
    assert.match(r.stdout, /doctor: lease free/);
    r = cli(dir, ['--doctor', '--repair']);
    assert.match(r.stdout, /swept stale session file old\.json/);
    assert.ok(!existsSync(path.join(sessions, 'old.json')));
    assert.ok(existsSync(path.join(sessions, 'fresh.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--doctor completes forward a task_created that never reached the board', () => {
  const dir = tmpDir();
  try {
    assert.equal(cli(dir, ['--init']).status, 0);
    assert.equal(cli(dir, ['--task', 'new', '--title', 'landed', '--milestone', 'M1']).status, 0);
    const runId = readJson(path.join(dir, 'loop.json')).run_id;
    appendEvent(ledgerPath(dir), { run: runId, shift: 's-001', session: 'cli', actor: 'cli:task' }, 'task_created', { task: 'T2', title: 'lost to a crash', milestone: 'M1' });
    let r = cli(dir, ['--doctor']);
    assert.match(r.stdout, /T2 has ledger events but no board row/);
    r = cli(dir, ['--doctor', '--repair']);
    assert.match(r.stdout, /repaired — T2 evented in ledger but missing from board/);
    const board = parseBoard(readFileSync(path.join(dir, 'TASKS.md'), 'utf8'));
    const row = board.rows.find((x) => x.id === 'T2');
    assert.equal(row.status, 'queued');
    assert.equal(row.title, 'lost to a crash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Operator resolution chain (§4.1.1)
// ---------------------------------------------------------------------------

test('operator resolution: flag → env → git config → unknown', (t) => {
  const dir = tmpDir();
  const saved = {
    LOOPWRIGHT_OPERATOR: process.env.LOOPWRIGHT_OPERATOR,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  try {
    // flag beats env (child process, env set):
    assert.equal(cli(dir, ['--init', '--operator', 'flagop'], { LOOPWRIGHT_OPERATOR: 'envop' }).status, 0);
    assert.equal(readJson(path.join(dir, 'loop.json')).operator, 'flagop');
    // env rung:
    assert.equal(resolveOperator({ flag: '', projectDir: dir }), process.env.LOOPWRIGHT_OPERATOR || resolveOperator({ projectDir: dir }), 'sanity');
    process.env.LOOPWRIGHT_OPERATOR = 'envop2';
    assert.equal(resolveOperator({ projectDir: dir }), 'envop2');
    delete process.env.LOOPWRIGHT_OPERATOR;
    // isolate git from the host's global config:
    const emptyGitConfig = path.join(dir, 'empty-gitconfig');
    writeFileSync(emptyGitConfig, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const gitDir = path.join(dir, 'repo');
    mkdirSync(gitDir);
    const init = spawnSync('git', ['init'], { cwd: gitDir, encoding: 'utf8' });
    if (init.status === 0) {
      spawnSync('git', ['config', 'user.name', 'Git Op'], { cwd: gitDir, encoding: 'utf8' });
      assert.equal(resolveOperator({ projectDir: gitDir }), 'Git Op', 'git-config rung');
    } else {
      t.diagnostic('git unavailable — git rung skipped');
    }
    // unknown rung (no flag, no env, no git identity):
    const bare = path.join(dir, 'bare');
    mkdirSync(bare);
    assert.equal(resolveOperator({ projectDir: bare }), 'unknown');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Misc CLI behavior
// ---------------------------------------------------------------------------

test('no verb prints usage and exits 0; atomicWriteFileSync creates parent dirs', () => {
  const dir = tmpDir();
  try {
    const r = cli(dir, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: node loop-state\.mjs/);
    const nested = path.join(dir, 'a', 'b', 'c.txt');
    atomicWriteFileSync(nested, 'deep');
    assert.equal(readFileSync(nested, 'utf8'), 'deep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rehydrateFromLedger on an empty event list is a no-op fresh state', () => {
  const fresh = freshState(1000, DEFAULT_CONFIG);
  const s = rehydrateFromLedger(fresh, [], 1000);
  assert.equal(s.shift_id, null);
  assert.equal(s.shift_ended, false);
  assert.deepEqual(s.run_totals, { shifts: 0, iterations: 0, active_seconds: 0 });
});

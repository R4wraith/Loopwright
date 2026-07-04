// v3 budget-stop.test.mjs — the Stop-hook backstop, driven as a real child process
// via the LOOPWRIGHT_* env overrides (v2 convention). All v2 pins carried where
// semantics survive, plus the §5.4 rewrite pins: budget-before-gate, two-level
// budgets, config-read-every-Stop, gate_block_max convergence (§10 item 6),
// secondary-mode no-writes, per-Stop iteration events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshState, nowSec } from './loop-state.mjs';
import { readLedger } from './ledger.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'budget-stop.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'v3-budget-stop-'));
}

/** A schema-3 loop.json with one open shift — the state budget-stop normally sees. */
function baseState(now, over = {}) {
  return {
    ...freshState(now),
    shift_id: 's-001',
    shift_seq: 1,
    operator: 'testop',
    run_totals: { shifts: 1, iterations: 0, active_seconds: 0 },
    started_at: now - 10,
    heartbeat_at: now - 10,
    iteration: 1,
    ...over,
  };
}

/** Drive the hook once inside `dir`. loopJson/stateMd/config are written only when
 * provided, so multi-Stop sequences can re-run against the hook's own writes. */
function runHook(dir, { loopJson, stateMd, config, stdin = '{}', extraEnv = {} } = {}) {
  const loopJsonPath = path.join(dir, 'loop.json');
  const stateMdPath = path.join(dir, 'STATE.md');
  const configPath = path.join(dir, 'loop-config.json');
  const ledgerFile = path.join(dir, 'ledger', 'events.jsonl');
  if (loopJson !== undefined) writeFileSync(loopJsonPath, JSON.stringify(loopJson), 'utf8');
  if (stateMd !== undefined) writeFileSync(stateMdPath, stateMd, 'utf8');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOPWRIGHT_HOOKS: '',
      LOOPWRIGHT_SESSION_ID: '',
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
      LOOPWRIGHT_LOOP_CONFIG: configPath,
      LOOPWRIGHT_STATE_MD: stateMdPath,
      LOOPWRIGHT_LEDGER: ledgerFile,
      ...extraEnv,
    },
  });
  let finalState = null;
  try {
    finalState = JSON.parse(readFileSync(loopJsonPath, 'utf8'));
  } catch {
    /* not written */
  }
  return { ...res, finalState, ledgerFile };
}

function eventsOf(ledgerFile, kind) {
  return readLedger(ledgerFile).filter((e) => (kind ? e.event === kind : true));
}

const TICKED_MD = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';

// ---------------------------------------------------------------------------
// v2 pins carried
// ---------------------------------------------------------------------------

test('under budget: allows stop, increments iteration, appends the iteration event', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState, ledgerFile } = runHook(dir, {
      loopJson: baseState(now),
      stateMd: '# STATE\n',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected no block, got: ${stdout}`);
    assert.equal(finalState.iteration, 2, 'iteration incremented on allow');
    const iters = eventsOf(ledgerFile, 'iteration');
    assert.equal(iters.length, 1, 'one iteration event per allowed Stop (§2.2)');
    assert.equal(iters[0].data.n, 2);
    assert.ok(Number.isFinite(iters[0].data.active_seconds));
    assert.equal(iters[0].actor, 'hook:budget-stop');
    assert.equal(iters[0].shift, 's-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('iteration >= shift.max_iterations: blocks with the pinned "budget exhausted: 4/4 iterations" reason', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState, ledgerFile } = runHook(dir, {
      loopJson: baseState(now, { iteration: 3 }),
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 4 } },
    });
    assert.equal(status, 0, 'Stop-hook block is exit-0 JSON, not exit 2');
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted: 4\/4 iterations/);
    assert.match(parsed.reason, /--end-shift --reason budget_iterations/);
    assert.equal(finalState.winddown_posted, true);
    const wd = eventsOf(ledgerFile, 'winddown_posted');
    assert.equal(wd.length, 1);
    assert.equal(wd[0].data.scope, 'shift');
    assert.equal(eventsOf(ledgerFile, 'iteration').length, 1, 'the wind-down turn still counts as an iteration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active time >= shift.max_wall_clock_sec: blocks with the pinned "Xs/50s active" reason', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout } = runHook(dir, {
      loopJson: baseState(now, { started_at: now - 100, heartbeat_at: now - 100 }),
      stateMd: '# STATE\n',
      config: { shift: { max_wall_clock_sec: 50 } },
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted: \d+s\/50s active/);
    assert.match(parsed.reason, /--end-shift --reason budget_time/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticked milestone box without a token: blocks pending-approval + milestone_gate_pending event', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState, ledgerFile } = runHook(dir, {
      loopJson: baseState(now),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /[Mm]ilestone/);
    assert.match(parsed.reason, /go-ahead|approval|review/);
    assert.match(parsed.reason, /headless/, 'the §4.4 headless clause rides every gate block');
    assert.equal(finalState.milestone_gate, 'pending-approval');
    assert.equal(finalState.gate_blocks, 1);
    const armed = eventsOf(ledgerFile, 'milestone_gate_pending');
    assert.equal(armed.length, 1, 'gate-arm event on FIRST arm only');
    assert.equal(armed[0].data.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate pending WITH a valid token object: consumes it (approval_consumed), clears gate, advances watermark', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const token = { value: 'human-ok', class: 'human', operator: 'ofek', granted_at: null, expires_at: null };
    const { status, stdout, stderr, finalState, ledgerFile } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'pending-approval', approval_token: token }),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected no block, got: ${stdout}`);
    assert.equal(finalState.milestone_gate, 'clear');
    assert.equal(finalState.approval_token, null);
    assert.equal(finalState.milestone_ticked_count, 1);
    assert.match(stderr, /human-approved/i);
    const consumed = eventsOf(ledgerFile, 'approval_consumed');
    assert.equal(consumed.length, 1);
    assert.deepEqual(consumed[0].data, { kind: 'human', operator: 'ofek', milestone_count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy v2 STRING token still consumes while pending (reads as human, no expiry — upgrade compat)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, stderr, finalState } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'pending-approval', approval_token: 'approved-1234' }),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.milestone_gate, 'clear');
    assert.match(stderr, /human-approved/i, 'legacy strings read as {class:"human"} (§4.4 pinned)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a class:"self" token clears the gate and is audit-logged as self-approved', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const token = { value: 'self:standing authorization', class: 'self', operator: 'testop', granted_at: null, expires_at: null };
    const { status, stdout, stderr, finalState } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'pending-approval', approval_token: token }),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.milestone_gate, 'clear');
    assert.match(stderr, /self-approved/i, 'audit trail distinguishes self from human approvals');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wind-down exactly once via stop_hook_active (no wedge, O4 carried)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const first = runHook(dir, {
      loopJson: baseState(now, { iteration: 3 }),
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 4 } },
    });
    assert.equal(JSON.parse(first.stdout).decision, 'block');
    assert.equal(first.finalState.winddown_posted, true);

    // Re-invocation this turn: exhausted condition still true, must now allow.
    // Reset the persisted flag so stop_hook_active alone is proven sufficient.
    const second = runHook(dir, {
      loopJson: { ...first.finalState, winddown_posted: false },
      stdin: JSON.stringify({ stop_hook_active: true }),
    });
    assert.equal(second.status, 0);
    assert.ok(!second.stdout.includes('"decision":"block"'), `expected allow (termination), got: ${second.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wind-down exactly once via the persisted winddown_posted flag (belt-and-suspenders)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const first = runHook(dir, {
      loopJson: baseState(now, { iteration: 3 }),
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 4 } },
    });
    assert.equal(JSON.parse(first.stdout).decision, 'block');
    // No stop_hook_active at all — rely solely on the persisted flag.
    const second = runHook(dir, { stdin: '{}' });
    assert.equal(second.status, 0);
    assert.ok(!second.stdout.includes('"decision":"block"'), `expected allow via persisted flag, got: ${second.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token set BEFORE the box is ticked never pre-clears the future gate (v2 pinned invariant)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'clear', approval_token: 'stale-or-early-token' }),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block', 'the new milestone must get its own block-and-review cycle');
    assert.equal(finalState.milestone_gate, 'pending-approval');
    assert.equal(finalState.approval_token, 'stale-or-early-token', 'token not consumed until the gate is actually pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing loop.json + empty ledger: fresh state, allow (fail-safe, never a crash)', () => {
  const dir = tmpDir();
  try {
    const { status, stdout, finalState } = runHook(dir, { stateMd: '# STATE\n' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.schema, 3, 'materialized state is schema 3');
    assert.equal(finalState.iteration, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2-flat loop.json (no schema): migrated in-memory, hook still allows and writes schema 3', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const v2 = {
      iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
      milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
      budget: { max_iterations: 40, max_wall_clock_sec: 21600, idle_gap_cap_sec: 600 },
    };
    const { status, stdout, finalState } = runHook(dir, { loopJson: v2, stateMd: '# STATE\n' });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.schema, 3);
    assert.equal(finalState.iteration, 2);
    assert.equal(finalState.shift_id, 's-001', 'the v2 run becomes shift s-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed stdin JSON: fails open (allows stop) with a greppable stderr line', () => {
  const dir = tmpDir();
  try {
    const { status, stdout, stderr } = runHook(dir, { stdin: 'not json at all' });
    assert.equal(status, 0, 'fail-open per O4: a hook bug must not block Stop forever');
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.match(stderr, /budget-stop/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active-seconds (not calendar) drive exhaustion: huge calendar age + small real gap = allow', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState } = runHook(dir, {
      loopJson: baseState(now, {
        started_at: now - 46800, // 13h of calendar time (the 209%-of-6h real-run shape)
        heartbeat_at: now - 30, // but the last real heartbeat was recent
        active_seconds: 100, // well under the ceiling
      }),
      stateMd: '# STATE\n',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected allow despite huge calendar wall-clock, got: ${stdout}`);
    assert.ok(finalState.active_seconds >= 130 && finalState.active_seconds <= 133, `expected ~130-131, got ${finalState.active_seconds}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 3h idle gap adds exactly the idle_gap_cap (600s), never the raw gap', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState } = runHook(dir, {
      loopJson: baseState(now, { heartbeat_at: now - 10800, active_seconds: 0 }),
      stateMd: '# STATE\n',
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.active_seconds, 600, 'idle gap capped at idle_gap_cap_sec, not the raw 10800s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// New v3 pins
// ---------------------------------------------------------------------------

test('budget wind-down WINS over a pending gate (R8 — no headless infinite gate loop)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, ledgerFile } = runHook(dir, {
      loopJson: baseState(now, { iteration: 3, milestone_gate: 'pending-approval' }),
      stateMd: TICKED_MD,
      config: { shift: { max_iterations: 4 } },
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted/, 'budget reason, not the milestone-review reason');
    assert.doesNotMatch(parsed.reason, /Milestone complete/);
    assert.equal(eventsOf(ledgerFile, 'winddown_posted')[0].data.scope, 'shift');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§10.6 headless-gate convergence: gate pending, no token → allowed Stop in ≤5 blocks with winddown_posted{scope:gate} in the ledger', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    // First Stop seeds the state; subsequent Stops re-run against the hook's own writes.
    let res = runHook(dir, { loopJson: baseState(now), stateMd: TICKED_MD });
    let blocks = 0;
    let allowed = false;
    for (let stop = 1; stop <= 6; stop++) {
      assert.equal(res.status, 0);
      if (res.stdout.includes('"decision":"block"')) {
        blocks++;
        assert.ok(blocks <= 5, `should converge in ≤5 blocks, still blocking at ${blocks}`);
        res = runHook(dir, { stdin: '{}' });
      } else {
        allowed = true;
        break;
      }
    }
    assert.ok(allowed, 'never reached an allowed Stop');
    assert.ok(blocks <= 5 && blocks >= 2, `expected bounded convergence, got ${blocks} blocks`);
    const gateWd = eventsOf(dir + path.sep + 'ledger' + path.sep + 'events.jsonl', 'winddown_posted').filter(
      (e) => e.data.scope === 'gate',
    );
    assert.equal(gateWd.length, 1, 'winddown_posted{scope:gate} appended exactly once');
    assert.equal(eventsOf(path.join(dir, 'ledger', 'events.jsonl'), 'milestone_gate_pending').length, 1, 'gate armed once');
    const final = JSON.parse(readFileSync(path.join(dir, 'loop.json'), 'utf8'));
    assert.equal(final.gate_winddown_posted, true);
    assert.equal(final.milestone_gate, 'pending-approval', 'the gate itself stays pending until a real approval');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the wind-down block reason at gate_block_max carries the §4.4 wind-down instruction', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { stdout, finalState } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'pending-approval', gate_blocks: 3 }),
      stateMd: TICKED_MD,
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /wind down/i);
    assert.match(parsed.reason, /--end-shift --reason milestone_gate/);
    assert.equal(finalState.gate_winddown_posted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired token: NOT consumed — approval_expired appended, token cleared, gate re-blocks', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const token = {
      value: 'approved-old',
      class: 'human',
      operator: 'ofek',
      granted_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-04T00:00:00Z', // long past
    };
    const { status, stdout, stderr, finalState, ledgerFile } = runHook(dir, {
      loopJson: baseState(now, { milestone_gate: 'pending-approval', approval_token: token }),
      stateMd: TICKED_MD,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block', 'expired approval must not clear the gate');
    assert.equal(finalState.approval_token, null, 'expired token cleared');
    assert.equal(finalState.milestone_gate, 'pending-approval');
    assert.match(stderr, /expired/i);
    const exp = eventsOf(ledgerFile, 'approval_expired');
    assert.equal(exp.length, 1);
    assert.deepEqual(exp[0].data, { operator: 'ofek', granted_at: '2026-01-01T00:00:00Z' });
    assert.equal(eventsOf(ledgerFile, 'approval_consumed').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run-ceiling exhaustion: distinct reason (run ceiling + extend-budget instruction), winddown scope run', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, ledgerFile } = runHook(dir, {
      loopJson: baseState(now, { run_totals: { shifts: 3, iterations: 8, active_seconds: 0 } }),
      stateMd: '# STATE\n',
      config: { run: { max_iterations: 10 } },
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted: 10\/10 iterations \(run ceiling\)/);
    assert.match(parsed.reason, /--extend-budget run\./);
    assert.match(parsed.reason, /--end-shift --reason run_budget/);
    assert.equal(eventsOf(ledgerFile, 'winddown_posted')[0].data.scope, 'run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config edit mid-run applies at the NEXT Stop (read fresh every Stop, §5.2)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const first = runHook(dir, {
      loopJson: baseState(now, { iteration: 5 }),
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 40 } },
    });
    assert.ok(!first.stdout.includes('"decision":"block"'), 'under the generous ceiling: allow');
    // Human tightens the config between Stops — no restart, no re-arm.
    const second = runHook(dir, { config: { shift: { max_iterations: 3 } } });
    const parsed = JSON.parse(second.stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted: 7\/3 iterations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget_override in loop.json beats the config (per-shift runway grant, §5.2)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { stdout } = runHook(dir, {
      loopJson: baseState(now, { iteration: 2, budget_override: { 'shift.max_iterations': 3 } }),
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 40 } },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /budget exhausted: 3\/3 iterations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secondary session (fresh foreign lease): blocks with [secondary session] prefix, ZERO writes (§4.2)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const state = baseState(now, {
      milestone_gate: 'pending-approval',
      lease_session: 'other-session',
      lease_renewed_at: now - 5, // fresh (< 900s)
    });
    const before = JSON.stringify(state);
    writeFileSync(path.join(dir, 'loop.json'), before, 'utf8');
    const { status, stdout, stderr, ledgerFile } = runHook(dir, {
      stateMd: TICKED_MD,
      stdin: JSON.stringify({ session_id: 'me-the-second' }),
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /^\[secondary session\] /);
    assert.match(stderr, /another session holds shift s-001/);
    assert.equal(readFileSync(path.join(dir, 'loop.json'), 'utf8'), before, 'loop.json byte-identical (no writes)');
    assert.ok(!existsSync(ledgerFile), 'no ledger events appended by a secondary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secondary session under ceilings with a clear gate: allows (and still never writes)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const state = baseState(now, { lease_session: 'other-session', lease_renewed_at: now - 5 });
    const before = JSON.stringify(state);
    writeFileSync(path.join(dir, 'loop.json'), before, 'utf8');
    const { status, stdout, ledgerFile } = runHook(dir, {
      stateMd: '# STATE\n',
      stdin: JSON.stringify({ session_id: 'me-the-second' }),
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(readFileSync(path.join(dir, 'loop.json'), 'utf8'), before);
    assert.ok(!existsSync(ledgerFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a STALE foreign lease does not demote to secondary: hook processes as primary and re-stamps the lease', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { status, stdout, finalState } = runHook(dir, {
      loopJson: baseState(now, { lease_session: 'dead-session', lease_renewed_at: now - 100000 }),
      stateMd: '# STATE\n',
      stdin: JSON.stringify({ session_id: 'live-session' }),
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.equal(finalState.iteration, 2, 'metered as primary');
    assert.equal(finalState.lease_session, 'live-session', 'lease re-stamped to the live session');
    assert.ok(finalState.lease_renewed_at >= now);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shift already ended: allow immediately, nothing written (the mechanical exit after --end-shift)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const state = baseState(now, { shift_ended: true, iteration: 100, milestone_gate: 'pending-approval' });
    const before = JSON.stringify(state);
    writeFileSync(path.join(dir, 'loop.json'), before, 'utf8');
    const { status, stdout, ledgerFile } = runHook(dir, {
      stateMd: TICKED_MD,
      config: { shift: { max_iterations: 4 } },
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'), `expected allow after shift end, got: ${stdout}`);
    assert.equal(readFileSync(path.join(dir, 'loop.json'), 'utf8'), before, 'ended-shift totals left exactly as recorded');
    assert.ok(!existsSync(ledgerFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowed Stop renews the shift lease with the payload session id (§4.2)', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const { finalState } = runHook(dir, {
      loopJson: baseState(now),
      stateMd: '# STATE\n',
      stdin: JSON.stringify({ session_id: 'sess-42' }),
    });
    assert.equal(finalState.lease_session, 'sess-42');
    assert.ok(finalState.lease_renewed_at >= now);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOPWRIGHT_HOOKS=0: exits 0 with greppable stderr and touches nothing', () => {
  const dir = tmpDir();
  try {
    const now = nowSec();
    const state = baseState(now, { iteration: 100 });
    const before = JSON.stringify(state);
    writeFileSync(path.join(dir, 'loop.json'), before, 'utf8');
    const { status, stdout, stderr } = runHook(dir, {
      stateMd: '# STATE\n',
      config: { shift: { max_iterations: 4 } },
      extraEnv: { LOOPWRIGHT_HOOKS: '0' },
    });
    assert.equal(status, 0);
    assert.ok(!stdout.includes('"decision":"block"'));
    assert.match(stderr, /LOOPWRIGHT_HOOKS=0/);
    assert.equal(readFileSync(path.join(dir, 'loop.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SP4 budget-stop.test.mjs — RED-first tests for the Stop-hook budget backstop (F16)
// and the milestone-gate enforcement (F25). Feeds the hook its stdin JSON exactly like
// Claude Code would, via a real child process, and asserts stdout/exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'budget-stop.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sp4-budget-stop-'));
}

function runHook({ loopJson, stateMd, stdin = '{}' } = {}) {
  const dir = tmpDir();
  const loopJsonPath = path.join(dir, 'loop.json');
  const stateMdPath = path.join(dir, 'STATE.md');
  if (loopJson) writeFileSync(loopJsonPath, JSON.stringify(loopJson), 'utf8');
  if (stateMd !== undefined) writeFileSync(stateMdPath, stateMd, 'utf8');

  const res = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
      LOOPWRIGHT_STATE_MD: stateMdPath,
    },
  });
  let finalState = null;
  try { finalState = JSON.parse(readFileSync(loopJsonPath, 'utf8')); } catch { /* not written */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...res, finalState };
}

test('under budget: allows stop (exit 0, no block decision)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const { status, stdout, finalState } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'), `expected no block, got: ${stdout}`);
  assert.equal(finalState.iteration, 2, 'iteration incremented on allow');
});

test('iteration >= max_iterations: blocks with a "budget exhausted" reason', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 3, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 4, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const { status, stdout } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0, 'Stop-hook block is exit-0 JSON, not exit 2');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /budget exhausted: 4\/4 iterations/);
});

test('wall-clock >= max_wall_clock_sec: blocks with a "budget exhausted" reason', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 100, heartbeat_at: now - 100, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 40, max_wall_clock_sec: 50, milestone_iter_soft: 12 },
  };
  const { status, stdout } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /budget exhausted: \d+s\/50s wall-clock/);
});

test('ticked milestone box without an approval token: blocks pending-approval', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const stateMd = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';
  const { status, stdout, finalState } = runHook({ loopJson, stateMd });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /[Mm]ilestone/);
  assert.match(parsed.reason, /go-ahead|approval|review/);
  assert.equal(finalState.milestone_gate, 'pending-approval');
});

test('ticked milestone box WITH an approval token: proceeds (consumes token, clears gate)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'pending-approval', milestone_ticked_count: 0, approval_token: 'human-ok',
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const stateMd = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';
  const { status, stdout, finalState } = runHook({ loopJson, stateMd });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'), `expected no block, got: ${stdout}`);
  assert.equal(finalState.milestone_gate, 'clear');
  assert.equal(finalState.approval_token, null);
  assert.equal(finalState.milestone_ticked_count, 1);
});

test('second Stop after exhaustion with stop_hook_active=true: allows termination (no wedge, O4)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 3, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 4, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };

  // First Stop: exhausted, must still block with the wind-down reason exactly once.
  const first = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(first.status, 0);
  const firstParsed = JSON.parse(first.stdout);
  assert.equal(firstParsed.decision, 'block');
  assert.match(firstParsed.reason, /budget exhausted: 4\/4 iterations/);
  assert.equal(first.finalState.winddown_posted, true, 'wind-down flag persisted after first block');

  // Second Stop: Claude Code re-invokes with stop_hook_active=true because our hook
  // blocked once already this turn. The exhausted condition is still true (iteration
  // only grows) — without the fix this would block again, forever. Must now allow.
  const second = runHook({
    loopJson: first.finalState,
    stateMd: '# STATE\n',
    stdin: JSON.stringify({ stop_hook_active: true }),
  });
  assert.equal(second.status, 0);
  assert.ok(!second.stdout.includes('"decision":"block"'), `expected allow (termination), got: ${second.stdout}`);
});

test('second Stop after exhaustion, stop_hook_active absent but winddown_posted persisted: still allows (belt-and-suspenders)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 3, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    budget: { max_iterations: 4, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const first = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(JSON.parse(first.stdout).decision, 'block');

  // No stop_hook_active in this payload at all — rely solely on the persisted flag.
  const second = runHook({ loopJson: first.finalState, stateMd: '# STATE\n', stdin: '{}' });
  assert.equal(second.status, 0);
  assert.ok(!second.stdout.includes('"decision":"block"'), `expected allow via persisted winddown_posted, got: ${second.stdout}`);
});

test('approval_token set before the next milestone box is ticked does NOT pre-clear that future gate', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    // Gate is 'clear' (not pending) but a token is already sitting there — e.g. left
    // over from approving a previous milestone, or set speculatively.
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: 'stale-or-early-token',
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12 },
  };
  const stateMd = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';
  const { status, stdout, finalState } = runHook({ loopJson, stateMd });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'block', 'the new milestone must get its own block-and-review cycle');
  assert.equal(finalState.milestone_gate, 'pending-approval');
  assert.equal(finalState.approval_token, 'stale-or-early-token', 'token not consumed until gate is actually pending');
});

test('missing/corrupt loop.json is treated as a fresh run (fail-safe), not a crash', () => {
  const { status, stdout } = runHook({ stateMd: '# STATE\n' });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'));
});

test('malformed stdin JSON: fails open (allows stop) rather than wedging the loop (O4)', () => {
  const { status, stdout, stderr } = runHook({ stdin: 'not json at all' });
  assert.equal(status, 0, 'fail-open per O4: a hook bug must not block Stop forever');
  assert.ok(!stdout.includes('"decision":"block"'));
  assert.match(stderr, /budget-stop/);
});

// ---------------------------------------------------------------------------
// SP7/F7 — active-time (not calendar wall-clock) budget
// ---------------------------------------------------------------------------

test('active-time budget: accumulated active_seconds (not calendar started_at) drives exhaustion', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1,
    started_at: now - 10000, // a long calendar time ago
    heartbeat_at: now - 5, // but recently touched — small real gap
    last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    active_seconds: 46, // already accumulated close to the ceiling — +the small gap tips it over
    budget: { max_iterations: 40, max_wall_clock_sec: 50, milestone_iter_soft: 12, idle_gap_cap_sec: 600 },
  };
  const { status, stdout, finalState } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /budget exhausted: \d+s\/50s wall-clock/, `expected active-seconds-based exhaustion, got: ${parsed.reason}`);
  // 46 accumulated + a ~5-6s real gap since heartbeat (a second may tick during the
  // subprocess round-trip, so allow a small margin rather than asserting an exact value).
  assert.ok(finalState.active_seconds >= 50 && finalState.active_seconds <= 53, `expected ~51-52, got ${finalState.active_seconds}`);
});

test('active-time budget: an idle gap beyond the cap only adds the cap, does NOT itself exhaust (209%-of-ceiling regression)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1,
    started_at: now - 46800, // 13h ago (209% of a 6h ceiling) — mostly idle, like a prior real run
    heartbeat_at: now - 30, // but the last real heartbeat was recent
    last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    active_seconds: 100, // well under the ceiling
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12, idle_gap_cap_sec: 600 },
  };
  const { status, stdout, finalState } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'), `expected allow despite huge calendar wall-clock, got: ${stdout}`);
  // 100 accumulated + a ~30-31s real gap since heartbeat (small margin for subprocess timing).
  assert.ok(finalState.active_seconds >= 130 && finalState.active_seconds <= 133, `expected ~130-131, got ${finalState.active_seconds}`);
});

test('active-time budget: a raw idle gap far beyond the cap (3h since last heartbeat) only adds the capped 600s, not the full gap', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1,
    started_at: now - 10,
    heartbeat_at: now - 10800, // 3h idle gap since the last Stop
    last_commit_sha: null,
    milestone_gate: 'clear', milestone_ticked_count: 0, approval_token: null,
    active_seconds: 0,
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12, idle_gap_cap_sec: 600 },
  };
  const { status, stdout, finalState } = runHook({ loopJson, stateMd: '# STATE\n' });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'));
  assert.equal(finalState.active_seconds, 600, 'idle gap capped at idle_gap_cap_sec, not the raw 10800s');
});

// ---------------------------------------------------------------------------
// SP7/F2 — self-approval audit token flows through the same consume path
// ---------------------------------------------------------------------------

test('a self:-prefixed approval token clears the gate exactly like a human token (self-clear)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'pending-approval', milestone_ticked_count: 0,
    approval_token: 'self:standing authorization per operator',
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12, idle_gap_cap_sec: 600 },
  };
  const stateMd = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';
  const { status, stdout, stderr, finalState } = runHook({ loopJson, stateMd });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'), `expected no block, got: ${stdout}`);
  assert.equal(finalState.milestone_gate, 'clear');
  assert.equal(finalState.approval_token, null);
  assert.equal(finalState.milestone_ticked_count, 1);
  assert.match(stderr, /self-approved/i, 'audit trail: stderr distinguishes a self-approval from a human one');
});

test('a human-style approval token clears the gate and is logged as human-approved (not self)', () => {
  const now = Math.floor(Date.now() / 1000);
  const loopJson = {
    iteration: 1, started_at: now - 10, heartbeat_at: now - 10, last_commit_sha: null,
    milestone_gate: 'pending-approval', milestone_ticked_count: 0, approval_token: 'approved-1234',
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12, idle_gap_cap_sec: 600 },
  };
  const stateMd = '# STATE\n\n## Milestones\n- [x] M1 keystone\n- [ ] M2 next\n';
  const { status, stdout, stderr, finalState } = runHook({ loopJson, stateMd });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('"decision":"block"'));
  assert.equal(finalState.milestone_gate, 'clear');
  assert.match(stderr, /human-approved/i);
});

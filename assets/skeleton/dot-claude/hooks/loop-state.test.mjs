// SP4 loop-state.test.mjs — RED-first unit tests for the shared loop.json helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  loadConfig,
  freshState,
  readState,
  writeState,
  incrementIteration,
  updateHeartbeat,
  setLastCommitSha,
  setApprovalToken,
  clearApprovalAndGate,
  elapsedWallClockSec,
  countTickedMilestones,
  resolveApprovalToken,
  accumulateActiveSeconds,
  setVerifiedTreeSha,
} from './loop-state.mjs';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sp4-loop-state-'));
}

test('DEFAULT_CONFIG carries the conservative placeholders', () => {
  assert.equal(DEFAULT_CONFIG.max_iterations, 40);
  assert.equal(DEFAULT_CONFIG.max_wall_clock_sec, 21600);
  assert.equal(DEFAULT_CONFIG.milestone_iter_soft, 12);
  assert.equal(DEFAULT_CONFIG.idle_gap_cap_sec, 600, 'SP7/F7: default idle-gap cap');
});

test('loadConfig falls back to DEFAULT_CONFIG when the file is missing', () => {
  const dir = tmpDir();
  try {
    const cfg = loadConfig(path.join(dir, 'nope.json'));
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig falls back to DEFAULT_CONFIG on unparseable JSON', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'bad.json');
    writeFileSync(p, '{ not json', 'utf8');
    const cfg = loadConfig(p);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads real overrides and merges over the defaults', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop-config.json');
    writeFileSync(p, JSON.stringify({ max_iterations: 5 }), 'utf8');
    const cfg = loadConfig(p);
    assert.equal(cfg.max_iterations, 5);
    assert.equal(cfg.max_wall_clock_sec, DEFAULT_CONFIG.max_wall_clock_sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads an idle_gap_cap_sec override (SP7/F7)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop-config.json');
    writeFileSync(p, JSON.stringify({ idle_gap_cap_sec: 120 }), 'utf8');
    const cfg = loadConfig(p);
    assert.equal(cfg.idle_gap_cap_sec, 120);
    assert.equal(cfg.max_iterations, DEFAULT_CONFIG.max_iterations);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freshState seeds a clean run at iteration 0 with the given config', () => {
  const now = 1000;
  const s = freshState(now, DEFAULT_CONFIG);
  assert.equal(s.iteration, 0);
  assert.equal(s.started_at, now);
  assert.equal(s.heartbeat_at, now);
  assert.equal(s.last_commit_sha, null);
  assert.equal(s.milestone_gate, 'clear');
  assert.equal(s.milestone_ticked_count, 0);
  assert.equal(s.approval_token, null);
  assert.deepEqual(s.budget, DEFAULT_CONFIG);
  assert.equal(s.active_seconds, 0, 'SP7/F7: active-time accumulator starts at 0');
  assert.equal(s.verified_tree_sha, null, 'SP7/F6: no verified tree recorded yet');
});

test('readState on a missing file returns fresh state (fail-safe, no throw)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    const s = readState(p, DEFAULT_CONFIG, 42);
    assert.equal(s.iteration, 0);
    assert.equal(s.started_at, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readState on corrupt JSON returns fresh state (fail-safe, no throw)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    writeFileSync(p, '{{{not json', 'utf8');
    const s = readState(p, DEFAULT_CONFIG, 42);
    assert.equal(s.iteration, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeState + readState round-trip preserves fields', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    const s = { ...freshState(100, DEFAULT_CONFIG), iteration: 7, last_commit_sha: 'abc123' };
    writeState(p, s);
    const back = readState(p, DEFAULT_CONFIG, 999);
    assert.equal(back.iteration, 7);
    assert.equal(back.last_commit_sha, 'abc123');
    assert.equal(back.started_at, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeState is atomic (no partial file left behind, tmp file cleaned up)', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'loop.json');
    writeState(p, freshState(1, DEFAULT_CONFIG));
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['loop.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incrementIteration bumps iteration and stamps heartbeat, does not mutate input', () => {
  const s0 = freshState(100, DEFAULT_CONFIG);
  const s1 = incrementIteration(s0, 200);
  assert.equal(s0.iteration, 0, 'input not mutated');
  assert.equal(s1.iteration, 1);
  assert.equal(s1.heartbeat_at, 200);
});

test('updateHeartbeat stamps heartbeat_at without touching iteration', () => {
  const s0 = freshState(100, DEFAULT_CONFIG);
  const s1 = updateHeartbeat(s0, 250);
  assert.equal(s1.heartbeat_at, 250);
  assert.equal(s1.iteration, 0);
});

test('setLastCommitSha sets the sha, does not mutate input', () => {
  const s0 = freshState(100, DEFAULT_CONFIG);
  const s1 = setLastCommitSha(s0, 'deadbeef');
  assert.equal(s0.last_commit_sha, null);
  assert.equal(s1.last_commit_sha, 'deadbeef');
});

test('setApprovalToken / clearApprovalAndGate round-trip the milestone approval flow', () => {
  const s0 = { ...freshState(100, DEFAULT_CONFIG), milestone_gate: 'pending-approval', milestone_ticked_count: 1 };
  const approved = setApprovalToken(s0, 'human-ok');
  assert.equal(approved.approval_token, 'human-ok');
  assert.equal(approved.milestone_gate, 'pending-approval', 'setting the token alone does not clear the gate');
  const cleared = clearApprovalAndGate(approved, 2);
  assert.equal(cleared.milestone_gate, 'clear');
  assert.equal(cleared.approval_token, null);
  assert.equal(cleared.milestone_ticked_count, 2);
});

test('elapsedWallClockSec computes now - started_at', () => {
  const s = freshState(100, DEFAULT_CONFIG);
  assert.equal(elapsedWallClockSec(s, 400), 300);
});

test('countTickedMilestones counts only checked boxes under ## Milestones', () => {
  const md = [
    '# STATE',
    '',
    '## Milestones',
    '- [x] M1 keystone',
    '- [ ] M2 next',
    '- [x] M3 later',
    '',
    '## Compaction anchor',
    '- [x] not a milestone, different section',
  ].join('\n');
  assert.equal(countTickedMilestones(md), 2);
});

test('countTickedMilestones returns 0 when there is no Milestones section', () => {
  assert.equal(countTickedMilestones('# STATE\n\nnothing here\n'), 0);
});

test('countTickedMilestones returns 0 on empty/missing content (fail-safe)', () => {
  assert.equal(countTickedMilestones(''), 0);
  assert.equal(countTickedMilestones(undefined), 0);
});

// ---------------------------------------------------------------------------
// SP7/F2 — self-approval audit token
// ---------------------------------------------------------------------------

test('resolveApprovalToken: self-approve with a rationale yields a self:-prefixed token carrying it', () => {
  const token = resolveApprovalToken({ self: true, rationale: 'standing authorization per operator' }, 1000);
  assert.equal(token, 'self:standing authorization per operator');
});

test('resolveApprovalToken: self-approve with no rationale yields a self:-prefixed ISO-ish stamp', () => {
  const token = resolveApprovalToken({ self: true }, 1000);
  assert.match(token, /^self:/);
  assert.equal(token, `self:${new Date(1000 * 1000).toISOString()}`);
});

test('resolveApprovalToken: plain --approve (no self, no explicit token) yields the pre-SP7 human-style token, unprefixed', () => {
  const token = resolveApprovalToken({}, 1000);
  assert.equal(token, 'approved-1000');
  assert.ok(!token.startsWith('self:'));
});

test('resolveApprovalToken: --approve <token> (human-supplied) passes the token through unprefixed', () => {
  const token = resolveApprovalToken({ explicitToken: 'human-ok' }, 1000);
  assert.equal(token, 'human-ok');
});

test('resolveApprovalToken: self always wins the self: prefix even if an explicitToken is also present', () => {
  const token = resolveApprovalToken({ self: true, rationale: 'why', explicitToken: 'ignored' }, 1000);
  assert.equal(token, 'self:why');
});

test('self-approve and human-approve both clear the gate via the existing consume path', () => {
  const pending = { ...freshState(100, DEFAULT_CONFIG), milestone_gate: 'pending-approval', milestone_ticked_count: 1 };

  const selfToken = resolveApprovalToken({ self: true, rationale: 'standing auth' }, 200);
  const selfApproved = setApprovalToken(pending, selfToken);
  const selfCleared = clearApprovalAndGate(selfApproved, 2);
  assert.equal(selfCleared.milestone_gate, 'clear');
  assert.equal(selfCleared.approval_token, null);

  const humanToken = resolveApprovalToken({}, 200);
  const humanApproved = setApprovalToken(pending, humanToken);
  const humanCleared = clearApprovalAndGate(humanApproved, 2);
  assert.equal(humanCleared.milestone_gate, 'clear');
  assert.equal(humanCleared.approval_token, null);
});

// ---------------------------------------------------------------------------
// SP7/F7 — active-time (not calendar wall-clock) budget accumulation
// ---------------------------------------------------------------------------

test('accumulateActiveSeconds: two Stops within the idle-gap cap add the real gap', () => {
  const s0 = { ...freshState(1000, DEFAULT_CONFIG), heartbeat_at: 1000, active_seconds: 0 };
  // "5 minutes since the last Stop" — well under the default 600s idle-gap cap.
  const s1 = accumulateActiveSeconds(s0, 1000 + 300, 600);
  assert.equal(s1.active_seconds, 300);
  assert.equal(s0.active_seconds, 0, 'input not mutated');
});

test('accumulateActiveSeconds: a gap beyond the idle-gap cap only adds the cap (209%-of-ceiling bug)', () => {
  const s0 = { ...freshState(1000, DEFAULT_CONFIG), heartbeat_at: 1000, active_seconds: 40 };
  // "3 hours since the last Stop" (10800s) — idle, not active; only the 600s cap counts.
  const s1 = accumulateActiveSeconds(s0, 1000 + 10800, 600);
  assert.equal(s1.active_seconds, 40 + 600);
});

test('accumulateActiveSeconds: accumulates across repeated Stops (caller advances heartbeat between calls)', () => {
  // accumulateActiveSeconds does not itself advance heartbeat_at — callers do that separately
  // (mirrors incrementIteration/updateHeartbeat's existing division of labor), same as
  // budget-stop.mjs's real per-Stop sequence: accumulate against the OLD heartbeat, then
  // stamp a new one.
  let s = { ...freshState(0, DEFAULT_CONFIG), heartbeat_at: 0, active_seconds: 0 };
  s = accumulateActiveSeconds(s, 100, 600); // gap 0->100
  s = updateHeartbeat(s, 100);
  s = accumulateActiveSeconds(s, 250, 600); // gap 100->250
  s = updateHeartbeat(s, 250);
  assert.equal(s.active_seconds, 100 + 150);
});

// ---------------------------------------------------------------------------
// SP7/F6 — verified_tree_sha setter
// ---------------------------------------------------------------------------

test('setVerifiedTreeSha sets the tree sha, does not mutate input', () => {
  const s0 = freshState(100, DEFAULT_CONFIG);
  const s1 = setVerifiedTreeSha(s0, 'deadbeef00000000000000000000000000000000');
  assert.equal(s0.verified_tree_sha, null);
  assert.equal(s1.verified_tree_sha, 'deadbeef00000000000000000000000000000000');
});

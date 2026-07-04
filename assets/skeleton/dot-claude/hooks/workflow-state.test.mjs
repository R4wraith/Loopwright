// v3 workflow-state.test.mjs — the §3.5 invariant suite for the UserPromptSubmit
// keystone: shipped-WORKFLOW.md ↔ tasks.mjs STATUSES coverage (a/b), the
// required-step-has-enforcement-line invariant (c), grammar round-trip (d),
// block-size caps (e), process-level breadcrumb (f), the done dead-zone pin (g),
// pseudo-status priority (h), the no-child_process latency pin (i), fail-open on
// malformed stdin (j) — plus every §3.4 degrade-ladder rung and the ≥300 s
// last_seen_at throttle (R20). Hooks are driven as real child processes via the
// LOOPWRIGHT_* env overrides (v2 convention); all state lives in mkdtemp sandboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseWorkflowStates,
  resolveStatus,
  buildHeader,
  buildTaskLine,
  PSEUDO_STATUSES,
  WORKFLOW_BLOCK_RE,
} from './workflow-state.mjs';
import { STATUSES, parseBoard } from './tasks.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HOOKS_DIR, 'workflow-state.mjs');
const SHIPPED_WORKFLOW_PATH = path.join(HOOKS_DIR, '..', 'WORKFLOW.md');
const SHIPPED_WORKFLOW = readFileSync(SHIPPED_WORKFLOW_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE_MD = '# STATE\n\n## Milestones\n- [ ] M1 — first\n\n**Now:** M1 — build\n**Next:** M2\n';

function boardMd(rows) {
  return [
    '# Tasks',
    '',
    '| ID | milestone | title | status | next step | owner | updated |',
    '|----|-----------|-------|--------|-----------|-------|---------|',
    ...rows.map((r) => `| ${r.id} | ${r.milestone || 'M1'} | ${r.title || 'thing'} | ${r.status} | ${r.next_step || 'do it'} | — | 2026-07-04 |`),
    '',
    '## Done (archive)',
    '',
  ].join('\n');
}

function loopJson(overrides = {}) {
  return {
    schema: 3,
    run_id: 'r-20260704T0800Z',
    shift_id: 's-007',
    shift_seq: 7,
    operator: 'ofek',
    mode: 'interactive',
    iteration: 12,
    active_seconds: 8410,
    winddown_posted: false,
    gate_blocks: 0,
    gate_winddown_posted: false,
    shift_ended: false,
    budget: { max_iterations: 40, max_wall_clock_sec: 21600, idle_gap_cap_sec: 600 },
    budget_override: null,
    run_totals: { shifts: 7, iterations: 202, active_seconds: 90000 },
    milestone_gate: 'clear',
    ...overrides,
  };
}

/** Build a sandbox harness dir + env; caller must cleanup(dir). */
function sandbox({ stateMd = STATE_MD, tasksMd, workflowMd = SHIPPED_WORKFLOW, loop, sessions = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp4-workflow-state-'));
  const p = {
    stateMd: path.join(dir, 'STATE.md'),
    tasksMd: path.join(dir, 'TASKS.md'),
    workflowMd: path.join(dir, 'WORKFLOW.md'),
    loopJson: path.join(dir, 'loop.json'),
    runtimeDir: path.join(dir, '.runtime'),
  };
  if (stateMd !== undefined && stateMd !== null) writeFileSync(p.stateMd, stateMd, 'utf8');
  if (tasksMd !== undefined && tasksMd !== null) writeFileSync(p.tasksMd, tasksMd, 'utf8');
  if (workflowMd !== undefined && workflowMd !== null) writeFileSync(p.workflowMd, workflowMd, 'utf8');
  if (loop !== undefined && loop !== null) {
    writeFileSync(p.loopJson, typeof loop === 'string' ? loop : JSON.stringify(loop, null, 2), 'utf8');
  }
  for (const [sid, ptr] of Object.entries(sessions)) {
    const sessDir = path.join(p.runtimeDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(path.join(sessDir, `${sid}.json`), JSON.stringify(ptr, null, 2), 'utf8');
  }
  const env = {
    LOOPWRIGHT_STATE_MD: p.stateMd,
    LOOPWRIGHT_TASKS_MD: p.tasksMd,
    LOOPWRIGHT_WORKFLOW_MD: p.workflowMd,
    LOOPWRIGHT_LOOP_JSON: p.loopJson,
    LOOPWRIGHT_RUNTIME_DIR: p.runtimeDir,
  };
  return { dir, p, env };
}

function runHook(env, stdin, dir) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.LOOPWRIGHT_HOOKS;
  delete childEnv.LOOPWRIGHT_SESSION_ID;
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: childEnv, cwd: dir || tmpdir() });
}

function injectedContext(stdout) {
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return parsed.hookSpecificOutput.additionalContext;
}

const PROMPT = (sid = 'sid-1') => JSON.stringify({ session_id: sid, prompt: 'hello' });

// ---------------------------------------------------------------------------
// (a)+(b) — status set ↔ shipped blocks, both directions
// ---------------------------------------------------------------------------

test('(a) every tasks.mjs STATUS + the 3 pseudo-statuses has a block in shipped WORKFLOW.md', () => {
  const blocks = parseWorkflowStates(SHIPPED_WORKFLOW);
  assert.deepEqual([...PSEUDO_STATUSES], ['winddown', 'gate_pending', 'no_task']);
  for (const status of [...STATUSES, ...PSEUDO_STATUSES]) {
    assert.ok(blocks[status] !== undefined, `missing [workflow-state:${status}] block`);
  }
  assert.equal(Object.keys(blocks).length, 11, 'exactly 11 blocks ship (8 statuses + 3 pseudo)');
});

test('(b) every shipped block STATUS is in the known set — no orphans', () => {
  const known = new Set([...STATUSES, ...PSEUDO_STATUSES]);
  for (const status of Object.keys(parseWorkflowStates(SHIPPED_WORKFLOW))) {
    assert.ok(known.has(status), `orphan block [workflow-state:${status}]`);
  }
});

// ---------------------------------------------------------------------------
// (c) — required-step-has-enforcement-line invariant
// ---------------------------------------------------------------------------

test('(c) every [required·once] Phase Index step names an enforcing block that carries a MUST line', () => {
  const blocks = parseWorkflowStates(SHIPPED_WORKFLOW);
  // The Phase Index is everything before the first block TAG (line-start —
  // prose may mention `[workflow-state:*]` inline earlier).
  const firstBlockAt = SHIPPED_WORKFLOW.search(/^\[workflow-state:/m);
  const indexPart = firstBlockAt === -1 ? SHIPPED_WORKFLOW : SHIPPED_WORKFLOW.slice(0, firstBlockAt);
  const requiredLines = indexPart.split('\n').filter((l) => l.includes('[required·once'));
  assert.ok(requiredLines.length >= 8, `expected a substantive Phase Index (got ${requiredLines.length} required steps)`);
  for (const line of requiredLines) {
    const m = line.match(/\(enforced:\s*([a-z0-9_-]+)\)/);
    assert.ok(m, `required step lacks an (enforced: <status>) marker: ${line.trim()}`);
    const body = blocks[m[1]];
    assert.ok(body !== undefined, `enforcing block [workflow-state:${m[1]}] missing for: ${line.trim()}`);
    assert.match(body, /MUST/, `block [workflow-state:${m[1]}] has no MUST enforcement line`);
  }
});

// ---------------------------------------------------------------------------
// (d) — grammar round-trip: parse → serialize → parse, bodies byte-identical
// ---------------------------------------------------------------------------

test('(d) grammar round-trip is byte-stable and the parse regex is the pinned one', () => {
  assert.equal(
    WORKFLOW_BLOCK_RE.source,
    '\\[workflow-state:([a-z0-9_-]+)\\]\\s*\\n([\\s\\S]*?)\\n\\s*\\[\\/workflow-state:\\1\\]',
  );
  const blocks = parseWorkflowStates(SHIPPED_WORKFLOW);
  const serialized = Object.entries(blocks)
    .map(([s, body]) => `[workflow-state:${s}]\n${body}\n[/workflow-state:${s}]`)
    .join('\n\n');
  assert.deepEqual(parseWorkflowStates(serialized), blocks);
});

// ---------------------------------------------------------------------------
// (e) — block body caps
// ---------------------------------------------------------------------------

test('(e) each shipped block body is ≤800 bytes and ≤8 lines', () => {
  for (const [status, body] of Object.entries(parseWorkflowStates(SHIPPED_WORKFLOW))) {
    assert.ok(Buffer.byteLength(body, 'utf8') <= 800, `[workflow-state:${status}] body is ${Buffer.byteLength(body, 'utf8')} bytes (>800)`);
    assert.ok(body.split('\n').length <= 8, `[workflow-state:${status}] body exceeds 8 lines`);
  }
});

// ---------------------------------------------------------------------------
// (f) — editing a block body changes the injected breadcrumb (process-level)
// ---------------------------------------------------------------------------

test('(f) editing a block body changes the injected breadcrumb', () => {
  const wf = (marker) => `[workflow-state:in_progress]\nbreadcrumb ${marker}\n[/workflow-state:in_progress]\n`;
  const { dir, p, env } = sandbox({
    tasksMd: boardMd([{ id: 'T14', status: 'in_progress', next_step: 'step one' }]),
    workflowMd: wf('MARKER-A'),
    loop: loopJson(),
  });
  try {
    let res = runHook(env, PROMPT(), dir);
    assert.equal(res.status, 0);
    assert.match(injectedContext(res.stdout), /breadcrumb MARKER-A/);
    writeFileSync(p.workflowMd, wf('MARKER-B'), 'utf8');
    res = runHook(env, PROMPT(), dir);
    const ctx = injectedContext(res.stdout);
    assert.match(ctx, /breadcrumb MARKER-B/);
    assert.doesNotMatch(ctx, /MARKER-A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (g) — the done dead-zone pin
// ---------------------------------------------------------------------------

test('(g) the done block routes forward: record + pick-next + milestone gate', () => {
  const done = parseWorkflowStates(SHIPPED_WORKFLOW).done;
  assert.match(done, /pick the next task/i);
  assert.match(done, /milestone gate/i);
  assert.match(done, /PROGRESS/);
});

test('(g2) done dead-zone end-to-end: session pointing at a done row gets the done block, not silence', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([{ id: 'T14', status: 'done', next_step: 'record it' }]),
    loop: loopJson(),
    sessions: { 'sid-1': { session_id: 'sid-1', active_task: 'T14', last_seen_at: Math.floor(Date.now() / 1000) } },
  });
  try {
    const res = runHook(env, PROMPT(), dir);
    const ctx = injectedContext(res.stdout);
    assert.match(ctx, /Task T14 \(done\)/);
    assert.match(ctx, /pick the next task/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (h) — pseudo-status priority: winddown > gate_pending > task status
// ---------------------------------------------------------------------------

test('(h) resolution priority is winddown > gate_pending > active task > no_task', () => {
  const board = parseBoard(boardMd([{ id: 'T14', status: 'in_progress', next_step: 'x' }]));
  const both = loopJson({ winddown_posted: true, milestone_gate: 'pending-approval' });
  assert.equal(resolveStatus({ state: both, board }).status, 'winddown');
  assert.equal(resolveStatus({ state: loopJson({ gate_winddown_posted: true }), board }).status, 'winddown');
  assert.equal(resolveStatus({ state: loopJson({ milestone_gate: 'pending-approval' }), board }).status, 'gate_pending');
  assert.equal(resolveStatus({ state: loopJson(), board }).status, 'in_progress');
  assert.equal(resolveStatus({ state: loopJson(), board: parseBoard(boardMd([])) }).status, 'no_task');
});

test('(h2) pointer beats board fallback; two active rows without a pointer resolve to no_task', () => {
  const board = parseBoard(
    boardMd([
      { id: 'T9', status: 'in_progress', next_step: 'a' },
      { id: 'T14', status: 'verifying', next_step: 'b' },
    ]),
  );
  const viaPointer = resolveStatus({ state: loopJson(), pointer: { active_task: 'T14' }, board });
  assert.equal(viaPointer.status, 'verifying');
  assert.equal(viaPointer.row.id, 'T14');
  // Two candidates, no pointer: never guess (§3.2 rung 4).
  assert.equal(resolveStatus({ state: loopJson(), board }).status, 'no_task');
});

// ---------------------------------------------------------------------------
// (i) — latency pin: no child_process anywhere in the module graph it owns
// ---------------------------------------------------------------------------

test('(i) workflow-state.mjs (and its one local import, tasks.mjs) never import child_process', () => {
  const self = readFileSync(HOOK, 'utf8');
  const tasks = readFileSync(path.join(HOOKS_DIR, 'tasks.mjs'), 'utf8');
  // Match import/require SPECIFIERS (quoted), not prose comments about the pin.
  const spawns = /['"](?:node:)?child_process['"]/;
  assert.ok(!spawns.test(tasks), 'tasks.mjs must stay subprocess-free');
  // Only local import allowed is tasks.mjs (loop-state.mjs pulls in child_process).
  const localImports = [...self.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(localImports, ['./tasks.mjs']);
  assert.ok(!spawns.test(self), 'workflow-state.mjs must not import/spawn child_process');
});

// ---------------------------------------------------------------------------
// (j) — malformed stdin: exit 0, empty stdout, greppable stderr
// ---------------------------------------------------------------------------

test('(j) malformed stdin → exit 0, empty stdout, stderr prefixed workflow-state:', () => {
  const { dir, env } = sandbox({ tasksMd: boardMd([]), loop: loopJson() });
  try {
    const res = runHook(env, 'this is {{ not json', dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /^workflow-state:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §3.3 — injection shape (header always emitted; exact-resume pointer)
// ---------------------------------------------------------------------------

test('injection: <workflow-state> wrapper with §3.3 header, task line, and block body', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([{ id: 'T14', status: 'in_progress', next_step: 're-run T2 verify after EOF fix' }]),
    loop: loopJson(),
    sessions: { 'sid-1': { session_id: 'sid-1', active_task: 'T14', last_seen_at: Math.floor(Date.now() / 1000) } },
  });
  try {
    const res = runHook(env, PROMPT(), dir);
    assert.equal(res.status, 0);
    const ctx = injectedContext(res.stdout);
    assert.ok(ctx.startsWith('<workflow-state>\n'), 'opens with the wrapper tag');
    assert.ok(ctx.endsWith('</workflow-state>'), 'closes with the wrapper tag');
    assert.match(ctx, /Shift s-007 \(ofek\) · iter 12\/40 · 8410\/21600s · run 7 shifts\/214 it · gate: clear/);
    assert.match(ctx, /Task T14 \(in_progress\) — next: re-run T2 verify after EOF fix/);
    assert.match(ctx, /scope contract/); // shipped in_progress block body, verbatim
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no_task injection lists candidates from the board (§3.2 rung 4)', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([
      { id: 'T3', status: 'queued', next_step: 'a' },
      { id: 'T7', status: 'blocked', next_step: 'b' },
    ]),
    loop: loopJson(),
  });
  try {
    const ctx = injectedContext(runHook(env, PROMPT(), dir).stdout);
    assert.match(ctx, /Task: \(none active\) · candidates: T3 \(queued\), T7 \(blocked\)/);
    assert.match(ctx, /never guess another session's task/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §3.4 — degrade ladder, rung by rung
// ---------------------------------------------------------------------------

test('rung 1: not a loopwright project (no STATE.md) → silent exit 0, empty stdout', () => {
  const { dir, env } = sandbox({ stateMd: null, tasksMd: boardMd([]), loop: loopJson() });
  try {
    const res = runHook(env, PROMPT(), dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rung 2: WORKFLOW.md missing → header + the restore pointer (never silent)', () => {
  const { dir, env } = sandbox({ tasksMd: boardMd([{ id: 'T14', status: 'in_progress' }]), workflowMd: null, loop: loopJson() });
  try {
    const ctx = injectedContext(runHook(env, PROMPT(), dir).stdout);
    assert.match(ctx, /Shift s-007 \(ofek\)/);
    assert.match(ctx, /\(WORKFLOW\.md missing — restore from git or run \/loopwright:upgrade\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rung 3: status resolves but block missing → header + the add-a-block pointer', () => {
  const wf = '[workflow-state:queued]\nonly queued here\n[/workflow-state:queued]\n';
  const { dir, env } = sandbox({ tasksMd: boardMd([{ id: 'T14', status: 'in_progress' }]), workflowMd: wf, loop: loopJson() });
  try {
    const ctx = injectedContext(runHook(env, PROMPT(), dir).stdout);
    assert.match(ctx, /Shift s-007/);
    assert.ok(
      ctx.includes('No [workflow-state:in_progress] block in .claude/WORKFLOW.md — proceed per /loop; consider adding one.'),
      `rung-3 message missing from: ${ctx}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rung 4: no session file → board fallback; NEVER another session\'s task', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([
      { id: 'T9', status: 'queued', next_step: 'a' },
      { id: 'T14', status: 'verifying', next_step: 'b' },
    ]),
    loop: loopJson(),
    // A DIFFERENT session points at T9 — ours (sid-1) has no pointer file.
    sessions: { 'sid-other': { session_id: 'sid-other', active_task: 'T9', last_seen_at: 0 } },
  });
  try {
    const ctx = injectedContext(runHook(env, PROMPT('sid-1'), dir).stdout);
    assert.match(ctx, /Task T14 \(verifying\)/);
    assert.doesNotMatch(ctx, /Task T9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rung 5: loop.json corrupt → header shows shift: (unknown), pseudo skipped, task resolution continues', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([{ id: 'T14', status: 'verifying', next_step: 'b' }]),
    loop: '{ definitely not json',
  });
  try {
    const res = runHook(env, PROMPT(), dir);
    const ctx = injectedContext(res.stdout);
    assert.match(ctx, /shift: \(unknown\)/);
    assert.match(ctx, /Task T14 \(verifying\)/);
    assert.match(ctx, /never weaken a test/); // the shipped verifying block body
    assert.match(res.stderr, /^workflow-state:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rung 5b: loop.json missing entirely → still injects (header unknown, TASKS.md alone)', () => {
  const { dir, env } = sandbox({ tasksMd: boardMd([{ id: 'T1', status: 'queued' }]) });
  try {
    const ctx = injectedContext(runHook(env, PROMPT(), dir).stdout);
    assert.match(ctx, /shift: \(unknown\)/);
    assert.match(ctx, /candidates: T1 \(queued\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R20 — throttled last_seen_at (the hook's only write)
// ---------------------------------------------------------------------------

test('throttle: fresh pointer (<300 s) is NOT rewritten; stale pointer is', () => {
  const now = Math.floor(Date.now() / 1000);
  const { dir, p, env } = sandbox({
    tasksMd: boardMd([{ id: 'T14', status: 'in_progress' }]),
    loop: loopJson(),
    sessions: { 'sid-1': { session_id: 'sid-1', active_task: 'T14', last_seen_at: now - 10 } },
  });
  const ptrPath = path.join(p.runtimeDir, 'sessions', 'sid-1.json');
  try {
    const before = readFileSync(ptrPath, 'utf8');
    let res = runHook(env, PROMPT(), dir);
    assert.equal(res.status, 0);
    assert.equal(readFileSync(ptrPath, 'utf8'), before, 'fresh pointer must be untouched (throttle)');

    writeFileSync(ptrPath, JSON.stringify({ session_id: 'sid-1', active_task: 'T14', last_seen_at: now - 400 }), 'utf8');
    res = runHook(env, PROMPT(), dir);
    assert.equal(res.status, 0);
    const after = JSON.parse(readFileSync(ptrPath, 'utf8'));
    assert.ok(after.last_seen_at >= now - 5, 'stale pointer must be refreshed');
    assert.equal(after.active_task, 'T14', 'refresh preserves the pointer fields');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook never MINTS a session pointer file (session-boot owns creation)', () => {
  const { dir, p, env } = sandbox({ tasksMd: boardMd([]), loop: loopJson() });
  try {
    const res = runHook(env, PROMPT('sid-new'), dir);
    assert.equal(res.status, 0);
    assert.ok(!readdirSafe(path.join(p.runtimeDir, 'sessions')).includes('sid-new.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LOOPWRIGHT_HOOKS=0 — fail-open kill switch (§1.5)
// ---------------------------------------------------------------------------

test('LOOPWRIGHT_HOOKS=0 → exit 0, empty stdout, greppable stderr', () => {
  const { dir, env } = sandbox({ tasksMd: boardMd([{ id: 'T14', status: 'in_progress' }]), loop: loopJson() });
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: PROMPT(),
      encoding: 'utf8',
      env: { ...process.env, ...env, LOOPWRIGHT_HOOKS: '0' },
      cwd: dir,
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /workflow-state: disabled via LOOPWRIGHT_HOOKS=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure-helper edges
// ---------------------------------------------------------------------------

test('parseWorkflowStates: non-string → {}, unclosed/mismatched tags ignored', () => {
  assert.deepEqual(parseWorkflowStates(null), {});
  assert.deepEqual(parseWorkflowStates('[workflow-state:a]\nbody\n[/workflow-state:b]'), {});
  assert.deepEqual(parseWorkflowStates('[workflow-state:a]\nbody\n[/workflow-state:a]'), { a: 'body' });
});

test('buildHeader: budget_override beats the snapshot for the display denominators', () => {
  const h = buildHeader(loopJson({ budget_override: { 'shift.max_iterations': 60 } }));
  assert.match(h, /iter 12\/60/);
});

test('buildTaskLine: empty next-step cell is called out, not blank', () => {
  const line = buildTaskLine({ row: { id: 'T2', status: 'queued', next_step: '' } }, null);
  assert.match(line, /Task T2 \(queued\) — next: \(next-step cell empty\)/);
});

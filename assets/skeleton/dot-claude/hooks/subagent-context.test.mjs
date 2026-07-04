// v3 subagent-context.test.mjs — pins for the PreToolUse(Task) dispatch hook
// (spec §8/WP4): prompt PREPENDED never replaced, tool_input otherwise untouched,
// permissionDecision allow, manifest paths listed not inlined, seed rows skipped,
// missing manifest → task-only preamble, no-active-task → passthrough, dispatch
// ledger event appended, malformed stdin / non-Task → passthrough, size caps.
// The hook is driven as a real child process via LOOPWRIGHT_* env overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseManifest, buildPreamble, MAX_MANIFEST_ROWS, MAX_PREAMBLE_BYTES, INJECT_MARKER } from './subagent-context.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HOOKS_DIR, 'subagent-context.mjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE_MD = '# STATE\n\n**Now:** M2 — parser hardening\n**Next:** M3 — CLI surface\n\n## Milestones\n- [ ] M1\n';

function boardMd(rows) {
  return [
    '# Tasks',
    '',
    '| ID | milestone | title | status | next step | owner | updated |',
    '|----|-----------|-------|--------|-----------|-------|---------|',
    ...rows.map((r) => `| ${r.id} | ${r.milestone || 'M1'} | ${r.title || 'thing'} | ${r.status} | ${r.next_step || 'do it'} | — | 2026-07-04 |`),
    '',
  ].join('\n');
}

const LOOP_JSON = {
  schema: 3,
  run_id: 'r-20260704T0800Z',
  shift_id: 's-007',
  operator: 'ofek',
  iteration: 12,
  run_totals: { shifts: 7, iterations: 202, active_seconds: 90000 },
  milestone_gate: 'clear',
};

function sandbox({ tasksMd, stateMd = STATE_MD, loop = LOOP_JSON, sessions = {}, manifests = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp4-subagent-context-'));
  const p = {
    tasksMd: path.join(dir, 'TASKS.md'),
    stateMd: path.join(dir, 'STATE.md'),
    loopJson: path.join(dir, 'loop.json'),
    ledger: path.join(dir, 'ledger', 'events.jsonl'),
    runtimeDir: path.join(dir, '.runtime'),
    manifestsDir: path.join(dir, 'manifests'),
  };
  if (tasksMd !== undefined && tasksMd !== null) writeFileSync(p.tasksMd, tasksMd, 'utf8');
  if (stateMd !== undefined && stateMd !== null) writeFileSync(p.stateMd, stateMd, 'utf8');
  if (loop !== undefined && loop !== null) writeFileSync(p.loopJson, JSON.stringify(loop, null, 2), 'utf8');
  for (const [sid, ptr] of Object.entries(sessions)) {
    mkdirSync(path.join(p.runtimeDir, 'sessions'), { recursive: true });
    writeFileSync(path.join(p.runtimeDir, 'sessions', `${sid}.json`), JSON.stringify(ptr), 'utf8');
  }
  for (const [name, content] of Object.entries(manifests)) {
    mkdirSync(p.manifestsDir, { recursive: true });
    writeFileSync(path.join(p.manifestsDir, `${name}.jsonl`), content, 'utf8');
  }
  const env = {
    LOOPWRIGHT_TASKS_MD: p.tasksMd,
    LOOPWRIGHT_STATE_MD: p.stateMd,
    LOOPWRIGHT_LOOP_JSON: p.loopJson,
    LOOPWRIGHT_LEDGER: p.ledger,
    LOOPWRIGHT_RUNTIME_DIR: p.runtimeDir,
    LOOPWRIGHT_MANIFESTS_DIR: p.manifestsDir,
  };
  return { dir, p, env };
}

function runHook(env, stdin, dir, extraEnv = {}) {
  const childEnv = { ...process.env, ...env, ...extraEnv };
  if (!('LOOPWRIGHT_HOOKS' in extraEnv)) delete childEnv.LOOPWRIGHT_HOOKS;
  delete childEnv.LOOPWRIGHT_SESSION_ID;
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: childEnv, cwd: dir || tmpdir() });
}

function taskPayload(overrides = {}, inputOverrides = {}) {
  return JSON.stringify({
    session_id: 'sid-1',
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'reviewer',
      description: 'review the parser slice',
      prompt: 'ORIGINAL PROMPT BODY — review src/parser for the EOF fix.',
      ...inputOverrides,
    },
    ...overrides,
  });
}

function parseOut(stdout) {
  const parsed = JSON.parse(stdout);
  const h = parsed.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  return h;
}

function ledgerEvents(p) {
  if (!existsSync(p.ledger)) return [];
  return readFileSync(p.ledger, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const ACTIVE_BOARD = boardMd([{ id: 'T14', status: 'verifying', next_step: 're-run T2 verify after EOF fix' }]);

// ---------------------------------------------------------------------------
// The core contract: prepend, never replace; allow; untouched siblings
// ---------------------------------------------------------------------------

test('prepends the preamble — original prompt survives verbatim at the end', () => {
  const { dir, p, env } = sandbox({
    tasksMd: ACTIVE_BOARD,
    manifests: { reviewer: '{"file":"docs/spec.md","reason":"the contract under review"}\n' },
  });
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.equal(res.status, 0);
    const h = parseOut(res.stdout);
    assert.equal(h.permissionDecision, 'allow');
    const prompt = h.updatedInput.prompt;
    assert.ok(prompt.startsWith(INJECT_MARKER), 'preamble marker leads');
    assert.ok(prompt.endsWith('ORIGINAL PROMPT BODY — review src/parser for the EOF fix.'), 'original prompt verbatim at the end');
    assert.match(prompt, /Active task: T14 \(verifying\) — next: re-run T2 verify after EOF fix/);
    assert.match(prompt, /Shift s-007 · operator ofek/);
    assert.match(prompt, /\*\*Now:\*\* M2 — parser hardening/);
    assert.match(prompt, /\*\*Next:\*\* M3 — CLI surface/);
    assert.match(prompt, /Read these before starting:\n- docs\/spec\.md — the contract under review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool_input fields other than prompt pass through untouched', () => {
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const h = parseOut(runHook(env, taskPayload(), dir).stdout);
    assert.equal(h.updatedInput.subagent_type, 'reviewer');
    assert.equal(h.updatedInput.description, 'review the parser slice');
    assert.deepEqual(Object.keys(h.updatedInput).sort(), ['description', 'prompt', 'subagent_type']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Manifest semantics: path list not content, seeds skipped, missing tolerated
// ---------------------------------------------------------------------------

test('manifest paths are LISTED, file content is never inlined (R16)', () => {
  const { dir, p, env } = sandbox({
    tasksMd: ACTIVE_BOARD,
    manifests: { reviewer: '{"file":"docs/secret-spec.md","reason":"contract"}\n' },
  });
  // The referenced file exists and carries a sentinel that must NOT appear.
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'secret-spec.md'), 'SENTINEL-CONTENT-NEVER-INLINED', 'utf8');
  try {
    const h = parseOut(runHook(env, taskPayload(), dir).stdout);
    assert.match(h.updatedInput.prompt, /- docs\/secret-spec\.md — contract/);
    assert.doesNotMatch(h.updatedInput.prompt, /SENTINEL-CONTENT-NEVER-INLINED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rows without a file key are seeds — skipped (the shipped manifests are seed-only)', () => {
  const { dir, env } = sandbox({
    tasksMd: ACTIVE_BOARD,
    manifests: {
      reviewer:
        '{"_seed":"add spec/reference files this agent should always see"}\n' +
        '{"file":"docs/real.md","reason":"real row"}\n',
    },
  });
  try {
    const prompt = parseOut(runHook(env, taskPayload(), dir).stdout).updatedInput.prompt;
    assert.match(prompt, /- docs\/real\.md — real row/);
    assert.doesNotMatch(prompt, /_seed/);
    assert.doesNotMatch(prompt, /always see/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing manifest → task-pointer-only preamble (no read list), still modified', () => {
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const res = runHook(env, taskPayload({}, { subagent_type: 'no-such-agent' }), dir);
    const prompt = parseOut(res.stdout).updatedInput.prompt;
    assert.match(prompt, /Active task: T14/);
    assert.doesNotMatch(prompt, /Read these before starting:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed manifest lines are skipped with a stderr note, valid rows still land', () => {
  const { dir, env } = sandbox({
    tasksMd: ACTIVE_BOARD,
    manifests: { reviewer: 'not json at all\n{"file":"docs/ok.md","reason":"fine"}\n' },
  });
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.match(parseOut(res.stdout).updatedInput.prompt, /- docs\/ok\.md — fine/);
    assert.match(res.stderr, /subagent-context: manifest reviewer\.jsonl: skipped 1 unparseable line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Active-task resolution: pointer first, board fallback, never guess
// ---------------------------------------------------------------------------

test('session pointer wins over the board single-active fallback', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([
      { id: 'T9', status: 'in_progress', next_step: 'other work' },
      { id: 'T14', status: 'verifying', next_step: 'mine' },
    ]),
    sessions: { 'sid-1': { session_id: 'sid-1', active_task: 'T14', last_seen_at: 0 } },
  });
  try {
    const prompt = parseOut(runHook(env, taskPayload(), dir).stdout).updatedInput.prompt;
    assert.match(prompt, /Active task: T14 \(verifying\)/);
    assert.doesNotMatch(prompt, /Active task: T9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no pointer + exactly one active row → that row is the scope', () => {
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const prompt = parseOut(runHook(env, taskPayload(), dir).stdout).updatedInput.prompt;
    assert.match(prompt, /Active task: T14 \(verifying\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no active task (two active rows, no pointer) → exit 0 passthrough + stderr note', () => {
  const { dir, env } = sandbox({
    tasksMd: boardMd([
      { id: 'T9', status: 'in_progress' },
      { id: 'T14', status: 'verifying' },
    ]),
  });
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '', 'passthrough = empty stdout, original input untouched');
    assert.match(res.stderr, /subagent-context: no active task/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no TASKS.md at all → passthrough (deterministic minimalism)', () => {
  const { dir, env } = sandbox({});
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ledger dispatch event (§2.2)
// ---------------------------------------------------------------------------

test('appends dispatch{agent, task} with the hook envelope', () => {
  const { dir, p, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.equal(res.status, 0);
    const events = ledgerEvents(p);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.event, 'dispatch');
    assert.deepEqual(ev.data, { agent: 'reviewer', task: 'T14' });
    assert.equal(ev.actor, 'hook:subagent-context');
    assert.equal(ev.run, 'r-20260704T0800Z');
    assert.equal(ev.shift, 's-007');
    assert.equal(ev.session, 'sid-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger append failure does NOT block the dispatch (fail-open audit)', () => {
  const { dir, p, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  // Make the ledger path unwritable: a DIRECTORY where the file should be.
  mkdirSync(p.ledger, { recursive: true });
  try {
    const res = runHook(env, taskPayload(), dir);
    assert.equal(res.status, 0);
    assert.match(parseOut(res.stdout).updatedInput.prompt, /Active task: T14/);
    assert.match(res.stderr, /subagent-context: dispatch event not appended/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Passthrough discipline
// ---------------------------------------------------------------------------

test('malformed stdin → exit 0, empty stdout (original input untouched)', () => {
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const res = runHook(env, '{{{ nope', dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /^subagent-context:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-Task payload → no-op; Task without subagent_type → no-op', () => {
  const { dir, p, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    let res = runHook(env, JSON.stringify({ session_id: 'sid-1', tool_name: 'Bash', tool_input: { command: 'ls' } }), dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    res = runHook(env, JSON.stringify({ session_id: 'sid-1', tool_name: 'Task', tool_input: { prompt: 'x' } }), dir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(ledgerEvents(p).length, 0, 'no dispatch event for passthroughs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOPWRIGHT_HOOKS=0 → passthrough with greppable stderr', () => {
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD });
  try {
    const res = runHook(env, taskPayload(), dir, { LOOPWRIGHT_HOOKS: '0' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /subagent-context: disabled via LOOPWRIGHT_HOOKS=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Caps: ≤100 manifest rows, preamble ≤8 KB
// ---------------------------------------------------------------------------

test('manifest is capped at 100 rows (extras dropped with a warning)', () => {
  const rows = [];
  for (let i = 0; i < 150; i++) rows.push(JSON.stringify({ file: `docs/f${i}.md`, reason: `r${i}` }));
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD, manifests: { reviewer: rows.join('\n') + '\n' } });
  try {
    const res = runHook(env, taskPayload(), dir);
    const prompt = parseOut(res.stdout).updatedInput.prompt;
    assert.match(prompt, /- docs\/f99\.md/);
    assert.doesNotMatch(prompt, /- docs\/f100\.md/);
    assert.match(res.stderr, /capped at 100 rows \(50 dropped\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preamble is capped at 8 KB — overflow drops rows from the end, original prompt intact', () => {
  const big = 'x'.repeat(400);
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(JSON.stringify({ file: `docs/f${i}.md`, reason: big }));
  const { dir, env } = sandbox({ tasksMd: ACTIVE_BOARD, manifests: { reviewer: rows.join('\n') + '\n' } });
  try {
    const res = runHook(env, taskPayload(), dir);
    const prompt = parseOut(res.stdout).updatedInput.prompt;
    const original = 'ORIGINAL PROMPT BODY — review src/parser for the EOF fix.';
    assert.ok(prompt.endsWith(original));
    const preamble = prompt.slice(0, prompt.length - original.length - 2); // strip '\n\n' + original
    assert.ok(Buffer.byteLength(preamble, 'utf8') <= MAX_PREAMBLE_BYTES, `preamble ${Buffer.byteLength(preamble, 'utf8')} bytes > cap`);
    assert.match(res.stderr, /dropped \d+ manifest row\(s\) from the end/);
    assert.match(prompt, /- docs\/f0\.md/, 'earliest rows are kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure-helper pins
// ---------------------------------------------------------------------------

test('parseManifest: entries/seeds/bad/capped accounting', () => {
  const raw = ['{"_seed":"s"}', '{"file":"a.md","reason":"r"}', 'garbage', '{"file":"  "}', '{"file":"b.md"}'].join('\n');
  const out = parseManifest(raw);
  assert.deepEqual(out.entries, [
    { file: 'a.md', reason: 'r' },
    { file: 'b.md', reason: '' },
  ]);
  assert.equal(out.seeds, 2); // the seed row and the whitespace-file row
  assert.equal(out.bad, 1);
  assert.equal(out.capped, 0);
  assert.equal(MAX_MANIFEST_ROWS, 100);
});

test('buildPreamble: no shift line without loop.json state; empty next-step called out', () => {
  const { text } = buildPreamble({ row: { id: 'T2', status: 'queued', next_step: '' } });
  assert.match(text, /Active task: T2 \(queued\) — next: \(next-step cell empty\)/);
  assert.doesNotMatch(text, /Shift /);
  assert.doesNotMatch(text, /Read these before starting:/);
});

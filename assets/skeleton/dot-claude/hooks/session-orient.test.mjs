// SP4 session-orient.test.mjs — RED-first tests for the SessionStart(source=compact)
// re-orient hook: re-inject STATE's compaction anchor + open FINDINGS + budget status
// as additionalContext so the post-compaction turn resumes on-scope (F17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOrientContext } from './session-orient.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-orient.mjs');

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sp4-session-orient-'));
}

test('buildOrientContext includes the compaction anchor, open findings, and budget status', () => {
  const ctx = buildOrientContext({
    anchorBlock: '**Now:** M2 — build the thing',
    openFindingIds: ['F1', 'F4'],
    budgetSummary: 'iteration 5/40, wall-clock 1200s/21600s, milestone_gate=clear',
  });
  assert.match(ctx, /M2 — build the thing/);
  assert.match(ctx, /F1, F4/);
  assert.match(ctx, /5\/40/);
});

function runHook({ stateMd, findingsMd, loopJson, stdin }) {
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
      LOOPWRIGHT_STATE_MD: stateMdPath,
      LOOPWRIGHT_FINDINGS_MD: findingsMdPath,
      LOOPWRIGHT_LOOP_JSON: loopJsonPath,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

test('source=compact: emits additionalContext with the anchor + findings + budget', () => {
  const stateMd = '# STATE\n\n## Compaction anchor\n**Now:** M2 — build the thing\n**Next:** M3\n';
  const findingsMd = '| ID | sev | type | status | mitigation | verified | source |\n| F1 | high | injection | open | x | - | reviewer |\n';
  const loopJson = { iteration: 5, started_at: 0, budget: { max_iterations: 40, max_wall_clock_sec: 21600, milestone_iter_soft: 12 }, milestone_gate: 'clear' };
  const { status, stdout } = runHook({ stateMd, findingsMd, loopJson, stdin: JSON.stringify({ source: 'compact' }) });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /M2 — build the thing/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /F1/);
});

test('source != compact: self-checks and no-ops (exit 0, no context)', () => {
  const { status, stdout } = runHook({ stateMd: '# STATE\n', stdin: JSON.stringify({ source: 'startup' }) });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '');
});

test('missing STATE.md on source=compact: fail-safe, exit 0, no crash', () => {
  const { status } = runHook({ stdin: JSON.stringify({ source: 'compact' }) });
  assert.equal(status, 0);
});

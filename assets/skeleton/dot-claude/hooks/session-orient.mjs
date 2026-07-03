#!/usr/bin/env node
// SP4 session-orient.mjs — SessionStart hook (F17, compaction-recovery half).
//
// Matcher in settings.json is "compact" (a documented SessionStart `source`,
// VERIFIED-high in the design). Because matcher support for SessionStart sources isn't
// something we can independently re-verify beyond the docs read, this hook ALSO
// self-checks `payload.source === 'compact'` and no-ops for any other source — so it's
// safe even if the matcher doesn't filter as expected and the hook fires on every
// session start.
//
// Re-injects the STATE.md `## Compaction anchor` (written by precompact-anchor.mjs) +
// open blocker/high FINDINGS + a budget-status summary as `additionalContext`, so the
// post-compaction turn resumes on-scope instead of drifting.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readState, loadConfig, elapsedWallClockSec, nowSec } from './loop-state.mjs';
import { extractOpenBlockerHighIds } from './precompact-anchor.mjs';

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

export function buildOrientContext({ anchorBlock, openFindingIds, budgetSummary }) {
  const findingsText = openFindingIds && openFindingIds.length ? openFindingIds.join(', ') : 'none';
  return [
    'Resuming after context compaction — re-orient before continuing:',
    '',
    '## Compaction anchor (from STATE.md)',
    anchorBlock || '(no compaction anchor found — STATE.md may predate SP4, or this is the first compaction)',
    '',
    `## Open blocker/high findings: ${findingsText}`,
    '',
    `## Budget status: ${budgetSummary}`,
  ].join('\n');
}

function extractSection(mdText, heading) {
  const lines = mdText.split('\n');
  const headingLine = `## ${heading}`;
  const startIdx = lines.findIndex((l) => l.trim() === headingLine);
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Paths (env-overridable for tests)
// ---------------------------------------------------------------------------

function here() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function claudeDir() {
  return path.dirname(here());
}

function stateMdPath() {
  return process.env.TRELLIS_STATE_MD || path.join(claudeDir(), 'STATE.md');
}

function findingsMdPath() {
  return process.env.TRELLIS_FINDINGS_MD || path.join(claudeDir(), 'FINDINGS.md');
}

function loopJsonPath() {
  return process.env.TRELLIS_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function configPath() {
  return process.env.TRELLIS_LOOP_CONFIG || path.join(here(), 'loop-config.json');
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function noop() {
  process.exit(0);
}

function main() {
  let payload = {};
  try {
    const raw = readStdinSync();
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`session-orient: could not parse hook input, no-op: ${e.message}\n`);
    noop();
    return;
  }

  if (payload.source !== 'compact') {
    noop();
    return;
  }

  try {
    let stateMdText = '';
    try { stateMdText = readFileSync(stateMdPath(), 'utf8'); } catch { /* fail-safe below */ }

    let findingsMdText = '';
    try { findingsMdText = readFileSync(findingsMdPath(), 'utf8'); } catch { /* optional */ }

    const now = nowSec();
    const config = loadConfig(configPath());
    const state = readState(loopJsonPath(), config, now);
    const budget = state.budget && Number.isFinite(state.budget.max_iterations) ? state.budget : config;
    const wallClock = elapsedWallClockSec(state, now);
    const budgetSummary = `iteration ${state.iteration}/${budget.max_iterations}, ` +
      `wall-clock ${wallClock}s/${budget.max_wall_clock_sec}s, milestone_gate=${state.milestone_gate}`;

    const context = buildOrientContext({
      anchorBlock: extractSection(stateMdText, 'Compaction anchor'),
      openFindingIds: extractOpenBlockerHighIds(findingsMdText),
      budgetSummary,
    });

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`session-orient: internal error, no-op: ${e.stack || e.message}\n`);
    noop();
  }
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // See budget-stop.mjs's isMain comment: case-insensitive on Windows to avoid a
    // silent no-op from drive-letter/segment casing mismatches.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) main();

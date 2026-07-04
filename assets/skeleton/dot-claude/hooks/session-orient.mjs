#!/usr/bin/env node
// v3 session-orient.mjs — SessionStart hook (compaction-recovery half of F17).
//
// Matcher in settings.json is "compact" (a documented SessionStart `source`). Because
// matcher support for SessionStart sources isn't something the harness can re-verify
// beyond the docs, this hook ALSO self-checks `payload.source === 'compact'` and no-ops
// for any other source — safe even if the matcher over-fires on every session start.
//
// Re-injects, as `additionalContext`:
//   1. the HANDOFF.md pointer — v3's PRIMARY orient anchor (WORKFLOW.md step 5: "read
//      HANDOFF.md FIRST"). Parsed via loop-state's HANDOFF stamp grammar.
//   2. the STATE.md `## Compaction anchor` (written by precompact-anchor.mjs).
//   3. open blocker/high FINDINGS.
//   4. a shift + budget status summary.
// so the post-compaction turn resumes on-scope + on-budget instead of drifting.
//
// v3 changes from v2: readState is the 4-arg signature; the budget summary reports the
// v3-metered active_seconds (the enforced dimension, per budget-stop) alongside the
// informational wall-clock elapsed; and the HANDOFF pointer is surfaced first.
//
// Fail-safe: malformed stdin / missing files / any throw ⇒ exit 0 (no-op).
// LOOPWRIGHT_HOOKS=0 disables it (exit 0 + stderr).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readState,
  loadConfig,
  effectiveBudget,
  elapsedWallClockSec,
  parseHandoffStamp,
  nowSec,
} from './loop-state.mjs';
import { extractOpenBlockerHighIds } from './precompact-anchor.mjs';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Extract the body of a `## <heading>` section (up to the next `## ` heading or EOF),
 * trimmed. Empty string when absent. */
export function extractSection(mdText, heading) {
  if (!mdText) return '';
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

function extractLine(mdText, label) {
  if (!mdText) return '';
  const re = new RegExp(`^\\*\\*${label}:\\*\\*.*$`, 'm');
  const m = mdText.match(re);
  return m ? m[0] : '';
}

/** A one/two-line HANDOFF.md digest for the re-orient block: the stamp header (shift,
 * kind, open/closed, written-at) plus the in-flight `**Task:**` line if present. Empty
 * string when HANDOFF.md is absent/blank (e.g. the shipped placeholder). */
export function buildHandoffPointer(handoffText) {
  if (!handoffText || !handoffText.trim()) return '';
  const stamp = parseHandoffStamp(handoffText);
  let header;
  if (stamp && stamp.shift) {
    const openTxt = stamp.shift_open === null ? '' : stamp.shift_open ? ' · shift open' : ' · shift closed';
    const kindTxt = stamp.kind ? ` · kind ${stamp.kind}` : '';
    const writtenTxt = stamp.written ? ` · written ${stamp.written}` : '';
    header = `HANDOFF.md — shift ${stamp.shift}${kindTxt}${openTxt}${writtenTxt} (read it in full first)`;
  } else {
    header = 'HANDOFF.md present (unstamped — read it in full first)';
  }
  const task = extractLine(handoffText, 'Task');
  return task ? `${header}\n${task}` : header;
}

export function buildOrientContext({ handoffPointer, anchorBlock, openFindingIds, budgetSummary }) {
  const findingsText = openFindingIds && openFindingIds.length ? openFindingIds.join(', ') : 'none';
  return [
    'Resuming after context compaction — re-orient before continuing:',
    '',
    '## HANDOFF pointer (v3 primary orient anchor)',
    handoffPointer || '(no HANDOFF.md found — orient from STATE.md/TASKS.md instead)',
    '',
    '## Compaction anchor (from STATE.md)',
    anchorBlock || '(no compaction anchor found — STATE.md may predate the anchor, or this is the first compaction)',
    '',
    `## Open blocker/high findings: ${findingsText}`,
    '',
    `## Budget status: ${budgetSummary}`,
  ].join('\n');
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
  return process.env.LOOPWRIGHT_STATE_MD || path.join(claudeDir(), 'STATE.md');
}

function findingsMdPath() {
  return process.env.LOOPWRIGHT_FINDINGS_MD || path.join(claudeDir(), 'FINDINGS.md');
}

function handoffMdPath() {
  return process.env.LOOPWRIGHT_HANDOFF_MD || path.join(claudeDir(), 'HANDOFF.md');
}

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function configPath() {
  return process.env.LOOPWRIGHT_LOOP_CONFIG || path.join(here(), 'loop-config.json');
}

function ledgerPath() {
  return process.env.LOOPWRIGHT_LEDGER || path.join(claudeDir(), 'ledger', 'events.jsonl');
}

function readFileSoft(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
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
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('session-orient: disabled (LOOPWRIGHT_HOOKS=0) — no-op\n');
    noop();
    return;
  }

  let payload = {};
  try {
    const raw = readStdinSync();
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`session-orient: could not parse hook input, no-op: ${e.message}\n`);
    noop();
    return;
  }

  // Self-guard: only re-orient on a post-compaction start.
  if (!payload || payload.source !== 'compact') {
    noop();
    return;
  }

  try {
    const stateMdText = readFileSoft(stateMdPath());
    const findingsMdText = readFileSoft(findingsMdPath());
    const handoffText = readFileSoft(handoffMdPath());

    const now = nowSec();
    const config = loadConfig(configPath());
    const state = readState(loopJsonPath(), ledgerPath(), config, now);
    const eff = effectiveBudget(config, state);

    const active = state.active_seconds || 0;
    const wall = elapsedWallClockSec(state, now);
    const budgetSummary =
      `shift ${state.shift_id || '(none)'}, iteration ${state.iteration || 0}/${eff.shift.max_iterations}, ` +
      `active ${active}s/${eff.shift.max_wall_clock_sec}s (wall-clock ${wall}s elapsed), ` +
      `milestone_gate=${state.milestone_gate || 'clear'}`;

    const context = buildOrientContext({
      handoffPointer: buildHandoffPointer(handoffText),
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

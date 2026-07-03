#!/usr/bin/env node
// SP4 precompact-anchor.mjs — PreCompact hook (F17).
//
// Before context is squeezed, snapshot the current scope/intent into a stable
// `## Compaction anchor` heading in the git-tracked STATE.md — not into a hook-private
// file, so it survives compaction without depending on the audit-disputed PostCompact
// event. session-orient.mjs (SessionStart, source=compact) reads this block back out.
// See docs/superpowers/specs/2026-07-01-trellis-v2-sp4-liveness-design.md §3.2.
//
// PreCompact is a side-effect hook here, never a gate: any failure (missing STATE.md,
// unreadable FINDINGS.md, missing loop.json) logs to stderr and exits 0 — compaction
// must never be blocked by a journal-write hiccup.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readState, atomicWriteFileSync } from './loop-state.mjs';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Replace the body of `## <heading>` (up to the next `## ` heading or EOF) with
 * `body`, or append a new `## <heading>` section at the end if absent. Idempotent —
 * re-running never duplicates the section. */
export function upsertSection(mdText, heading, body) {
  const headingLine = `## ${heading}`;
  const lines = mdText.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === headingLine);
  const newSection = [headingLine, body].join('\n');

  if (startIdx === -1) {
    const sep = mdText.endsWith('\n') ? '' : '\n';
    return `${mdText}${sep}\n${newSection}\n`;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { endIdx = i; break; }
  }
  // Trim trailing blank lines from the old section body, but keep exactly one blank
  // separator before the next section (or none, at EOF).
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const replaced = [...before, ...newSection.split('\n')];
  if (after.length) replaced.push('');
  return [...replaced, ...after].join('\n');
}

export function extractOpenBlockerHighIds(findingsMdText) {
  if (!findingsMdText) return [];
  const ids = [];
  for (const line of findingsMdText.split('\n')) {
    const m = line.match(/^\|\s*(F\d+)\s*\|\s*(\w+)\s*\|[^|]*\|\s*(\w[\w-]*)\s*\|/);
    if (!m) continue;
    const [, id, sev, status] = m;
    const isBlockerHigh = /^(blocker|high)$/i.test(sev);
    const isResolved = /^(verified|closed|accepted)$/i.test(status);
    if (isBlockerHigh && !isResolved) ids.push(id);
  }
  return ids;
}

export function buildAnchorBlock({ nowLine, nextLine, openFindingIds, lastCommitSha, timestamp }) {
  const findingsText = openFindingIds && openFindingIds.length ? openFindingIds.join(', ') : 'none';
  const commitText = lastCommitSha || 'none yet';
  return [
    `_Written by precompact-anchor.mjs at ${timestamp} — recovery snapshot for after compaction._`,
    nowLine || '**Now:** (not set)',
    nextLine || '**Next:** (not set)',
    `**Open blocker/high findings:** ${findingsText}`,
    `**Last commit:** ${commitText}`,
  ].join('\n');
}

function extractLine(stateMdText, label) {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*.*$`, 'm');
  const m = stateMdText.match(re);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Paths (env-overridable for tests; default to siblings of this hook file)
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

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) { try { JSON.parse(raw); } catch { /* payload not required */ } }

    let stateMdText;
    try {
      stateMdText = readFileSync(stateMdPath(), 'utf8');
    } catch {
      process.stderr.write('precompact-anchor: no STATE.md to snapshot into, skipping.\n');
      process.exit(0);
      return;
    }

    let findingsMdText = '';
    try { findingsMdText = readFileSync(findingsMdPath(), 'utf8'); } catch { /* optional */ }

    const state = readState(loopJsonPath());

    const block = buildAnchorBlock({
      nowLine: extractLine(stateMdText, 'Now'),
      nextLine: extractLine(stateMdText, 'Next'),
      openFindingIds: extractOpenBlockerHighIds(findingsMdText),
      lastCommitSha: state.last_commit_sha,
      timestamp: new Date().toISOString(),
    });

    const updated = upsertSection(stateMdText, 'Compaction anchor', block);
    // Atomic temp+rename — STATE.md is the durable git-tracked truth the whole design
    // leans on; it deserves the same crash-safety as the disposable loop.json, doubly so
    // because PreCompact runs exactly when the process is under memory pressure.
    atomicWriteFileSync(stateMdPath(), updated);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`precompact-anchor: internal error, not blocking compaction: ${e.stack || e.message}\n`);
    process.exit(0);
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

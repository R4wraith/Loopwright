#!/usr/bin/env node
// v3 precompact-anchor.mjs — PreCompact hook (v2 F17 logic carried, plus the v3
// shift/budget snapshot + ledger duty).
//
// Before context is squeezed, snapshot the current scope/intent into a stable
// `## Compaction anchor` heading in the git-tracked STATE.md — not into a hook-private
// file, so it survives compaction without depending on a post-compaction event.
// session-orient.mjs (SessionStart, source=compact) reads this block back out and
// re-injects it as additionalContext.
//
// v3 changes:
//   - readState is the 4-arg v3 signature (loopPath, ledgerPath, config, now) so a
//     deleted loop.json rehydrates last_commit_sha from the ledger (§2.3) rather than
//     coming back null.
//   - The anchor now also captures the current shift + effective budget (iteration /
//     active-seconds ceilings + milestone gate) so the resumed turn re-orients on
//     bounded-autonomy position, not just scope.
//   - A `compaction_anchor_written` ledger event is appended for audit (a closed-set
//     event kind, §2.2; replay treats it as attribution-only). It is appended AFTER the
//     STATE.md write, deliberately unlike loop.json's event-before-write invariant:
//     STATE.md is the durable recovery truth (never rebuilt from the ledger), so a crash
//     must leave the anchor present even if the audit breadcrumb is missed.
//
// PreCompact is a side-effect hook here, never a gate: any failure (missing STATE.md,
// unreadable FINDINGS.md, missing loop.json, ledger hiccup) logs to stderr and exits 0 —
// compaction must never be blocked by a journal-write hiccup. LOOPWRIGHT_HOOKS=0 disables
// it (exit 0 + stderr).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readState,
  loadConfig,
  effectiveBudget,
  atomicWriteFileSync,
  extractOpenBlockerHighIds,
  nowSec,
} from './loop-state.mjs';
import { appendEvent } from './ledger.mjs';

// Re-export the canonical open-blocker/high extractor so session-orient.mjs (and this
// hook's tests) can import it FROM here, preserving the v2 import surface even though
// v3 moved the implementation into loop-state.mjs.
export { extractOpenBlockerHighIds };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Replace the body of `## <heading>` (up to the next `## ` heading or EOF) with
 * `body`, or append a new `## <heading>` section at the end if absent. Idempotent —
 * re-running never duplicates the section (v2 carried verbatim). */
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

/** Build the recovery snapshot body. All inputs are plain data so this stays pure and
 * testable; the caller derives the shift/budget lines from loop.json state. */
export function buildAnchorBlock({ nowLine, nextLine, openFindingIds, lastCommitSha, shiftLine, budgetLine, timestamp }) {
  const findingsText = openFindingIds && openFindingIds.length ? openFindingIds.join(', ') : 'none';
  const commitText = lastCommitSha || 'none yet';
  return [
    `_Written by precompact-anchor.mjs at ${timestamp} — recovery snapshot for after compaction._`,
    nowLine || '**Now:** (not set)',
    nextLine || '**Next:** (not set)',
    `**Open blocker/high findings:** ${findingsText}`,
    `**Last commit:** ${commitText}`,
    `**Shift:** ${shiftLine || '(none)'}`,
    `**Budget:** ${budgetLine || '(unknown)'}`,
  ].join('\n');
}

function extractLine(stateMdText, label) {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*.*$`, 'm');
  const m = stateMdText.match(re);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Paths (env-overridable for tests; default to the skeleton layout) — matches the
// budget-stop / journal-integrity / workflow-state convention (local functions, not
// resolvePaths, which is the CLI surface).
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

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function configPath() {
  return process.env.LOOPWRIGHT_LOOP_CONFIG || path.join(here(), 'loop-config.json');
}

function ledgerPath() {
  return process.env.LOOPWRIGHT_LEDGER || path.join(claudeDir(), 'ledger', 'events.jsonl');
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('precompact-anchor: disabled (LOOPWRIGHT_HOOKS=0) — no-op\n');
    process.exit(0);
    return;
  }

  // Payload is best-effort: the snapshot is driven by the journal files. We only lift
  // session_id for ledger attribution when present.
  let sid = process.env.LOOPWRIGHT_SESSION_ID || 'cli';
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) {
      const p = JSON.parse(raw);
      if (p && typeof p.session_id === 'string' && p.session_id) sid = p.session_id;
    }
  } catch {
    /* payload not required */
  }

  try {
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

    const now = nowSec();
    const config = loadConfig(configPath());
    const state = readState(loopJsonPath(), ledgerPath(), config, now);
    const eff = effectiveBudget(config, state);
    const openFindingIds = extractOpenBlockerHighIds(findingsMdText);

    const shiftLine = state.shift_id
      ? `${state.shift_id} (${state.operator || 'unknown'}) — iteration ${state.iteration || 0}/${eff.shift.max_iterations}`
      : '(no shift open)';
    const budgetLine =
      `${state.active_seconds || 0}s/${eff.shift.max_wall_clock_sec}s active · milestone_gate=${state.milestone_gate || 'clear'}`;

    const block = buildAnchorBlock({
      nowLine: extractLine(stateMdText, 'Now'),
      nextLine: extractLine(stateMdText, 'Next'),
      openFindingIds,
      lastCommitSha: state.last_commit_sha,
      shiftLine,
      budgetLine,
      timestamp: new Date().toISOString(),
    });

    const updated = upsertSection(stateMdText, 'Compaction anchor', block);
    // Atomic temp+rename — STATE.md is the durable git-tracked truth the whole design
    // leans on; it deserves crash-safety, doubly so because PreCompact runs exactly when
    // the process is under memory pressure.
    atomicWriteFileSync(stateMdPath(), updated);

    // Audit breadcrumb AFTER the durable write (see the header note on ordering).
    // Fail-soft: a ledger hiccup must never block compaction.
    try {
      const envelope = { run: state.run_id, shift: state.shift_id, session: sid, actor: 'hook:precompact-anchor' };
      appendEvent(ledgerPath(), envelope, 'compaction_anchor_written', {
        shift: state.shift_id,
        findings: openFindingIds.length,
      });
    } catch (e) {
      process.stderr.write(`precompact-anchor: ledger append failed (non-fatal): ${e.message}\n`);
    }

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

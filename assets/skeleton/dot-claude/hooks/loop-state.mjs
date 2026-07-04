#!/usr/bin/env node
// SP4 loop-state.mjs — shared helper for .claude/loop.json, the git-ignored machine-
// readable counter file behind the bounded-autonomy backstop (budget-stop.mjs,
// precompact-anchor.mjs, session-orient.mjs, journal-integrity.mjs all import this).
//
// State model (cross-SP contract): loop.json is git-ignored, machine-only counters
// (iteration, wall-clock start, last_commit_sha, heartbeat, milestone approval token).
// STATE.md stays the durable git-tracked markdown truth. On conflict, git (STATE.md)
// wins — loop.json is disposable telemetry a human can delete to reset the budget.
//
// Fail-safe, not fail-closed: a missing or corrupt loop.json is treated as a fresh run
// (never throws) — losing the counter file should degrade to "budget restarts," not
// wedge the loop. the bounded-autonomy design notes.

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Budget config — the single documented place for the conservative defaults
// (also mirrored, with commentary, in hooks/loop-config.json — O3: these are
// placeholders until a measured baseline grounds them from real shifts).
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  max_iterations: 40,
  max_wall_clock_sec: 21600, // 6h
  milestone_iter_soft: 12,
  // SP7/F7: gaps between Stops longer than this (default 10min) count as idle, not active
  // — see accumulateActiveSeconds below and budget-stop.mjs's active-time ceiling.
  idle_gap_cap_sec: 600,
});

/** Load hooks/loop-config.json, merged over DEFAULT_CONFIG. Missing file, unreadable
 * file, or unparseable JSON all fall back to DEFAULT_CONFIG (fail-safe — a broken
 * config must not crash the harness, it just loses the human's overrides). */
export function loadConfig(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const { max_iterations, max_wall_clock_sec, milestone_iter_soft, idle_gap_cap_sec } = parsed;
    return {
      max_iterations: Number.isFinite(max_iterations) ? max_iterations : DEFAULT_CONFIG.max_iterations,
      max_wall_clock_sec: Number.isFinite(max_wall_clock_sec) ? max_wall_clock_sec : DEFAULT_CONFIG.max_wall_clock_sec,
      milestone_iter_soft: Number.isFinite(milestone_iter_soft) ? milestone_iter_soft : DEFAULT_CONFIG.milestone_iter_soft,
      idle_gap_cap_sec: Number.isFinite(idle_gap_cap_sec) ? idle_gap_cap_sec : DEFAULT_CONFIG.idle_gap_cap_sec,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** A brand-new run's state, seeded at `now` (epoch seconds) with `config`'s budget. */
export function freshState(now, config = DEFAULT_CONFIG) {
  return {
    run_id: new Date(now * 1000).toISOString(),
    iteration: 0,
    started_at: now,
    heartbeat_at: now,
    last_commit_sha: null,
    milestone_gate: 'clear', // clear | pending-approval
    milestone_ticked_count: 0,
    approval_token: null,
    budget: { ...config },
    active_seconds: 0, // SP7/F7: accumulated ACTIVE seconds (idle gaps capped), not calendar wall-clock
    verified_tree_sha: null, // SP7/F6: git tree sha recorded at the last DoD/verify pass, unset by default
  };
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Read loop.json; on any failure (missing file, unreadable, corrupt JSON) return a
 * fresh state instead of throwing — losing the counter file is not fatal. */
export function readState(filePath, config = DEFAULT_CONFIG, now = nowSec()) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return freshState(now, config);
    // Fill in any fields an older/partial file might be missing rather than reject it.
    return { ...freshState(now, config), ...parsed };
  } catch {
    return freshState(now, config);
  }
}

/** Atomic write: write `content` to a sibling temp file, then rename over `filePath`.
 * Avoids a reader (or a crash mid-write, e.g. under the memory pressure a PreCompact
 * hook runs under) ever observing a half-written file. Shared by writeState (loop.json)
 * and by precompact-anchor.mjs for STATE.md — the durable git-tracked truth deserves the
 * same protection as the disposable counter file. */
export function atomicWriteFileSync(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

export function writeState(filePath, state) {
  atomicWriteFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Pure state transitions — none mutate their input.
// ---------------------------------------------------------------------------

export function incrementIteration(state, now = nowSec()) {
  return { ...state, iteration: state.iteration + 1, heartbeat_at: now };
}

export function updateHeartbeat(state, now = nowSec()) {
  return { ...state, heartbeat_at: now };
}

export function setLastCommitSha(state, sha) {
  return { ...state, last_commit_sha: sha };
}

/** Records a human approval token. Does NOT by itself clear the milestone gate — the
 * Stop hook consumes the token (clearApprovalAndGate) the next time it re-checks the
 * ticked-milestone count, so the review prompt is guaranteed to be re-evaluated against
 * the token rather than the token silently short-circuiting the pause. */
export function setApprovalToken(state, token) {
  return { ...state, approval_token: token };
}

/** Consumes the approval token: clears the gate back to 'clear', nulls the token, and
 * advances milestone_ticked_count to `tickedCount` so the same milestone doesn't
 * re-trigger the gate. */
export function clearApprovalAndGate(state, tickedCount) {
  return { ...state, milestone_gate: 'clear', approval_token: null, milestone_ticked_count: tickedCount };
}

export function elapsedWallClockSec(state, now = nowSec()) {
  return now - state.started_at;
}

/** SP7/F7 — accumulates ACTIVE seconds (not calendar wall-clock) into `active_seconds`.
 * Called once per Stop, BEFORE the caller advances `heartbeat_at`: the gap since the
 * previous heartbeat is added, capped at `idleGapCapSec` (default from DEFAULT_CONFIG) —
 * a gap longer than the cap (the loop sat idle, e.g. waiting on a human) counts as idle,
 * not active, so a long calendar gap can no longer silently inflate the budget the way
 * that prior run's 209%-of-6h-ceiling run did. Pure: does not mutate `state` and does NOT
 * itself touch `heartbeat_at` — that remains updateHeartbeat/incrementIteration's job, so
 * repeated calls without an intervening heartbeat bump would double-count (by design,
 * mirroring how those two functions divide labor already).
 *
 * Known limitation (accepted, not a bug): a genuinely-active single turn that runs LONGER
 * than `idleGapCapSec` (e.g. one very long tool call) is also capped here, same as a truly
 * idle gap — there's no way to distinguish "busy the whole time" from "idle the whole time"
 * from a heartbeat gap alone, so this undercounts real active time toward the wall-clock
 * ceiling in that case. Accepted because the **iteration ceiling (`max_iterations`) is the
 * hard runaway floor** regardless of how active-time accounting behaves — a loop can't run
 * away on iteration count alone even if every turn's active time were undercounted to zero.
 * `active_seconds` is a secondary signal layered on top, not the sole backstop. */
export function accumulateActiveSeconds(state, now = nowSec(), idleGapCapSec = DEFAULT_CONFIG.idle_gap_cap_sec) {
  const gap = Math.max(0, now - state.heartbeat_at);
  const cap = Number.isFinite(idleGapCapSec) ? idleGapCapSec : DEFAULT_CONFIG.idle_gap_cap_sec;
  const delta = Math.min(gap, cap);
  return { ...state, active_seconds: (state.active_seconds || 0) + delta };
}

/** SP7/F6 — records the git tree sha verified at the last DoD/verify pass (the loop's
 * `/loop` milestone-gate step calls this once the gate passes). journal-integrity.mjs
 * compares it against the committed tree to catch a stale/partial commit. */
export function setVerifiedTreeSha(state, sha) {
  return { ...state, verified_tree_sha: sha };
}

/** SP7/F2 — resolves the approval-token string for `loop-state.mjs --approve`, so the
 * audit trail can distinguish a genuine human-typed approval from the PM self-approving
 * under a previously-granted standing/autonomous authorization. Both shapes flow through
 * the exact same setApprovalToken/clearApprovalAndGate consume path in budget-stop.mjs —
 * this only changes what gets RECORDED, never who/what is allowed to clear the gate.
 *   - `self: true` → always a `self:<rationale-or-ISO-stamp>` token (rationale wins if given).
 *   - otherwise → the pre-SP7 behavior, unchanged: `explicitToken` if given, else
 *     `approved-<epoch-seconds>`. */
export function resolveApprovalToken({ self = false, rationale = '', explicitToken = '' } = {}, now = nowSec()) {
  if (self) {
    const why = rationale && String(rationale).trim() ? String(rationale).trim() : new Date(now * 1000).toISOString();
    return `self:${why}`;
  }
  return explicitToken && String(explicitToken).trim() ? String(explicitToken).trim() : `approved-${now}`;
}

// ---------------------------------------------------------------------------
// STATE.md ## Milestones checklist parsing (F25)
// ---------------------------------------------------------------------------

/** Count `- [x]` boxes inside the `## Milestones` section of STATE.md (stops at the
 * next `## ` heading or EOF). Fail-safe: no section / empty / missing content => 0. */
export function countTickedMilestones(stateMdText) {
  if (!stateMdText) return 0;
  const lines = String(stateMdText).split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+Milestones\s*$/.test(line.trim())) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(line.trim())) break; // next section ends it
    if (inSection && /^-\s*\[[xX]\]/.test(line.trim())) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// CLI (operator-facing: init / approve / status) — used by commands/loop.md's
// approval flow ("run `node .claude/hooks/loop-state.mjs --approve`") and by
// scaffolding. Not exercised by the hook events themselves.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function here() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultLoopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(here(), '..', 'loop.json');
}

function defaultConfigPath() {
  return process.env.LOOPWRIGHT_LOOP_CONFIG || path.join(here(), 'loop-config.json');
}

function defaultProjectDir() {
  return process.env.LOOPWRIGHT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function cli() {
  const args = process.argv.slice(2);
  const loopJsonPath = defaultLoopJsonPath();
  const config = loadConfig(defaultConfigPath());

  if (args.includes('--init')) {
    if (existsSync(loopJsonPath)) {
      process.stdout.write(`loop.json already exists at ${loopJsonPath} — not overwriting.\n`);
      process.exit(0);
    }
    writeState(loopJsonPath, freshState(nowSec(), config));
    process.stdout.write(`loop.json initialized at ${loopJsonPath}\n`);
    process.exit(0);
  }

  if (args.includes('--approve')) {
    const idx = args.indexOf('--approve');
    const selfIdx = args.indexOf('--self');
    const isSelf = selfIdx !== -1;
    const rationale = isSelf && args[selfIdx + 1] && !args[selfIdx + 1].startsWith('--') ? args[selfIdx + 1] : '';
    const explicitToken = !isSelf && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
    const token = resolveApprovalToken({ self: isSelf, rationale, explicitToken }, nowSec());
    const state = readState(loopJsonPath, config);
    writeState(loopJsonPath, setApprovalToken(state, token));
    process.stdout.write(`Approval token set (${token}). It will be consumed on the next Stop check.\n`);
    process.exit(0);
  }

  // SP7/F6 — record the git tree sha verified at the current DoD/verify pass. Optional
  // explicit sha arg for tests/tooling; defaults to `git write-tree` (the tree object for
  // whatever is currently STAGED) in the project dir, NOT `HEAD^{tree}`. This is called
  // per-verified-slice now (loop.md step 4/7), right after verify passes and BEFORE the
  // slice is committed — at that point HEAD is still the *previous* commit, so `HEAD^{tree}`
  // would capture the wrong (pre-slice) tree and the guard would mismatch on every single
  // commit. `git write-tree` instead captures exactly the tree `git commit` would produce
  // from the current index, so callers must `git add -A` (stage the slice) immediately
  // before running this. Backward compatible with the old milestone-gate callsite: with a
  // clean index (nothing staged since the last commit), `git write-tree` == `HEAD^{tree}`.
  if (args.includes('--set-verified-tree')) {
    const idx = args.indexOf('--set-verified-tree');
    let sha = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
    if (!sha) {
      try {
        sha = execFileSync('git', ['write-tree'], { cwd: defaultProjectDir(), encoding: 'utf8' }).trim();
      } catch (e) {
        process.stderr.write(`loop-state: could not resolve write-tree: ${e.message}\n`);
        process.exit(1);
        return;
      }
    }
    const state = readState(loopJsonPath, config);
    writeState(loopJsonPath, setVerifiedTreeSha(state, sha));
    process.stdout.write(`verified_tree_sha set (${sha}).\n`);
    process.exit(0);
  }

  if (args.includes('--status')) {
    const state = readState(loopJsonPath, config);
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    process.exit(0);
  }

  process.stdout.write('Usage: node loop-state.mjs [--init | --approve [token] | --approve --self [rationale] | --set-verified-tree [sha] | --status]\n');
  process.exit(0);
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

if (isMain) cli();

#!/usr/bin/env node
// SP4 budget-stop.mjs — the Stop hook, the linchpin of the bounded-autonomy backstop.
//
// Two responsibilities, one file read (per the design's §3.6): (1) the iteration +
// wall-clock budget ceiling (F16); (2) forcing the milestone-gate pause even in
// headless/auto mode (F25). See the design notes
// 2026-07-01-loopwright-v2-sp4-liveness-design.md §3.1, §3.5.
//
// Error-handling convention (O4, deliberately DIFFERENT from SP1.5's guard.mjs):
// guard.mjs fails CLOSED (deny) because it's a PreToolUse safety gate — an unevaluated
// command is a live risk. This hook fails OPEN (allow the stop) on any internal error —
// a bug here must not wedge an autonomous loop that can no longer stop. Every fail-open
// path logs to stderr so the failure is greppable, but Stop is never held hostage by a
// hook bug. This is a conscious deviation from SP1.5's fail-closed default, scoped to
// this one Stop hook.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  loadConfig,
  readState,
  writeState,
  incrementIteration,
  updateHeartbeat,
  clearApprovalAndGate,
  accumulateActiveSeconds,
  countTickedMilestones,
  nowSec,
} from './loop-state.mjs';

function here() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function claudeDir() {
  return path.dirname(here());
}

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function configPath() {
  return process.env.LOOPWRIGHT_LOOP_CONFIG || path.join(here(), 'loop-config.json');
}

function stateMdPath() {
  return process.env.LOOPWRIGHT_STATE_MD || path.join(claudeDir(), 'STATE.md');
}

function isValidBudget(b) {
  return b && Number.isFinite(b.max_iterations) && Number.isFinite(b.max_wall_clock_sec);
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0); // Stop-hook block is exit-0 JSON, not exit 2 (design §3.1).
}

function allow() {
  process.exit(0);
}

function main() {
  // Parse the hook payload. The budget/milestone decision is still driven entirely by
  // loop.json + STATE.md, not by anything Claude reports about itself — EXCEPT for one
  // field Claude Code itself controls and guarantees: `stop_hook_active`, true when this
  // Stop hook is being re-invoked after it already blocked once this turn. That's the
  // signal we need to fire the budget-exhaustion wind-down exactly once (see O4 below).
  // A malformed payload must not wedge Stop.
  let payload = {};
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`budget-stop: could not parse hook input, allowing stop (fail-open, see O4): ${e.message}\n`);
    allow();
    return;
  }
  const stopHookActive = !!(payload && payload.stop_hook_active === true);

  try {
    const now = nowSec();
    const ljPath = loopJsonPath();
    const config = loadConfig(configPath());
    let state = readState(ljPath, config, now);
    const budget = isValidBudget(state.budget) ? state.budget : config;
    const idleGapCapSec = Number.isFinite(budget.idle_gap_cap_sec)
      ? budget.idle_gap_cap_sec
      : (Number.isFinite(config.idle_gap_cap_sec) ? config.idle_gap_cap_sec : DEFAULT_CONFIG.idle_gap_cap_sec);

    // SP7/F7: accumulate ACTIVE seconds since the last heartbeat (idle gaps beyond
    // idleGapCapSec don't count) BEFORE any branch below advances heartbeat_at — this is
    // the one-accumulation-per-Stop point the whole active-time budget rests on.
    state = accumulateActiveSeconds(state, now, idleGapCapSec);

    let stateMdText = '';
    try {
      stateMdText = readFileSync(stateMdPath(), 'utf8');
    } catch {
      // No STATE.md yet (very early run) — nothing to check for milestones.
    }
    const tickedCount = countTickedMilestones(stateMdText);

    // --- F25: milestone-gate pause, mechanical even in headless/auto mode ---
    const milestoneAdvanced = tickedCount > state.milestone_ticked_count;
    const gateAlreadyPending = state.milestone_gate === 'pending-approval';
    if (milestoneAdvanced || gateAlreadyPending) {
      // Scoped intentionally: only honor/consume `approval_token` when the gate is
      // ALREADY `pending-approval` for THIS milestone — i.e. we already blocked and
      // are re-checking after the human responded. A token set earlier (e.g. left over
      // from approving a previous milestone, or set speculatively before the next box
      // was ticked) must never pre-clear a future milestone's gate; that box always
      // gets at least one real block-and-review cycle.
      if (gateAlreadyPending && state.approval_token) {
        // Human (or operator, via `node loop-state.mjs --approve`) cleared it — consume
        // the token, advance the watermark, fall through to the normal budget check.
        // SP7/F2: log which kind of approval this was — `self:`-prefixed (the PM
        // self-approving under a previously-granted standing/autonomous authorization,
        // via `--approve --self`) vs. a genuine human-typed token — so the audit trail
        // (stderr, greppable) distinguishes human-approved from auto-proceeded. This is
        // purely a logging distinction: both shapes clear the gate identically, nothing
        // here grants any new self-clearing capability the gate didn't already have.
        const approvalKind = String(state.approval_token).startsWith('self:')
          ? 'self-approved (standing authorization)'
          : 'human-approved';
        process.stderr.write(`budget-stop: milestone gate cleared — ${approvalKind}: ${state.approval_token}\n`);
        state = clearApprovalAndGate(updateHeartbeat(state, now), tickedCount);
      } else {
        state = updateHeartbeat({ ...state, milestone_gate: 'pending-approval' }, now);
        writeState(ljPath, state);
        block(
          'Milestone complete — post the milestone review (what shipped / key design choices / ' +
          'next-milestone plan) and WAIT for human go-ahead. Do not start the next milestone. ' +
          'Approve with: node .claude/hooks/loop-state.mjs --approve',
        );
        return;
      }
    }

    // --- F16/F7: iteration + ACTIVE-time wall-clock budget ceiling ---
    // SP7/F7: compares accumulated `active_seconds` (idle gaps capped, see above), not
    // calendar `now - started_at` — a long idle gap (waiting on a human, a milestone
    // pause) no longer silently burns the ceiling the way it did before (a prior real run
    // hit 209% of its 6h ceiling with no effect because ~13h of that was idle).
    const iterationAfter = state.iteration + 1;
    const wallClock = state.active_seconds || 0;
    const iterationsExhausted = iterationAfter >= budget.max_iterations;
    const wallClockExhausted = wallClock >= budget.max_wall_clock_sec;

    if (iterationsExhausted || wallClockExhausted) {
      // O4: exhausted is a PERMANENT condition once hit (iteration only grows), so
      // blocking on every subsequent Stop would wedge the loop forever — the exact
      // runaway failure SP4 exists to prevent. The fix: fire the wind-down block
      // EXACTLY ONCE, then allow termination.
      //
      // `stop_hook_active` (from Claude Code's own Stop-hook payload) is true when this
      // Stop is the re-invocation after we already blocked once — that means the
      // wind-down turn already happened, so let it terminate now. Belt-and-suspenders:
      // also persist `winddown_posted` in loop.json so a second exhausted Stop still
      // allows even if `stop_hook_active` were ever absent/unreliable.
      const windDownAlreadyPosted = state.winddown_posted === true;
      if (windDownAlreadyPosted || stopHookActive) {
        state = updateHeartbeat({ ...state, winddown_posted: true }, now);
        writeState(ljPath, state);
        allow();
        return;
      }

      state = incrementIteration({ ...state, winddown_posted: true }, now);
      writeState(ljPath, state);
      const used = iterationsExhausted
        ? `${iterationAfter}/${budget.max_iterations} iterations`
        : `${wallClock}s/${budget.max_wall_clock_sec}s wall-clock`;
      block(
        `budget exhausted: ${used} — post a status summary (what shipped, what's open, recommended ` +
        `next budget) and STOP. Do not continue without a fresh budget.`,
      );
      return;
    }

    // Under ceiling: allow normally. SP4 is a ceiling, not an engine — nothing here
    // forces continuation.
    state = incrementIteration(state, now);
    writeState(ljPath, state);
    allow();
  } catch (e) {
    process.stderr.write(`budget-stop: internal error, allowing stop (fail-open, see O4): ${e.stack || e.message}\n`);
    allow();
  }
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // Case-insensitive compare on Windows: drive-letter/segment casing between argv[1]
    // (as passed via $CLAUDE_PROJECT_DIR-anchored shell commands) and Node's resolution
    // of import.meta.url is not guaranteed to match on a case-insensitive filesystem. A
    // strict === here would silently no-op the hook (main() never runs) rather than fail
    // loudly — exactly the kind of quiet failure SP4 exists to prevent.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) main();

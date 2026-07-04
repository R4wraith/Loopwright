#!/usr/bin/env node
// v3 budget-stop.mjs — the Stop hook, the linchpin of the bounded-autonomy backstop.
// Rewritten to the §5.4 normative order (v2 accounting math carried verbatim):
//
//   0  parse stdin (malformed → fail-open allow + stderr)
//   1  lease check — a FRESH FOREIGN lease means SECONDARY mode (§4.2): evaluate
//      gate/budget and block with the same reasons ([secondary session] prefix) or
//      allow, but perform ZERO writes to loop.json/ledger and never increment the
//      iteration counter. No last-writer-wins on counters/gate/watermarks (R9).
//   2  accumulate active seconds vs the old heartbeat (primary only from here on —
//      the ONE accumulation point the whole active-time budget rests on, §5.3)
//   3  shift already ended → allow (the mechanical exit after --end-shift)
//   4  BUDGET before GATE — the R8 fix, superseding v2's gate-first order: a pending
//      milestone gate can no longer wedge a headless night once the budget is spent
//      (new pin: gate pending + budget exhausted ⇒ the budget wind-down wins).
//      Two levels: per-shift ceilings, then cumulative run ceilings
//      (run_totals + current shift vs run.*, 0 = unlimited).
//   5  MILESTONE GATE: consume a valid unexpired token / expire a stale one / arm and
//      block — with gate_block_max convergence (§4.4): after N consecutive gate
//      blocks with no approval the reason switches to the wind-down instruction and
//      the following Stop is allowed. An unattended gated shift converges to a clean
//      HANDOFF + shift end in ≤ ~5 turns instead of looping forever.
//   6  under ceilings: incrementIteration, append the per-Stop `iteration` ledger
//      event {n, active_seconds} (R5 — mid-shift budget amnesia is dead: a lost
//      loop.json rehydrates the open shift's counters from these events), renew the
//      lease, atomic writeState, allow.
//
// Budget resolution (§5.2, fixes v2's frozen-snapshot gap): loop-config.json is read
// FRESH at every Stop, overlaid by loop.json's explicit budget_override (set only by
// --start-shift budget flags or --extend-budget). The shift-start snapshot in
// state.budget is audit-only and never consulted here.
//
// Ledger appends land BEFORE the loop.json write (§2.2 event-before-write invariant).
//
// Error-handling convention (O4, carried from v2 and deliberately DIFFERENT from
// guard.mjs): guard fails CLOSED because it is a PreToolUse safety gate; this hook
// fails OPEN (allow the stop) on any internal error — a bug here must not wedge an
// autonomous loop that can no longer stop. Every fail-open path logs a greppable
// stderr line. LOOPWRIGHT_HOOKS=0 disables this hook (exit 0 + stderr); guard.mjs
// and secret-scan.mjs deliberately ignore that switch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  loadConfig,
  effectiveBudget,
  readState,
  writeState,
  incrementIteration,
  updateHeartbeat,
  clearApprovalAndGate,
  accumulateActiveSeconds,
  countTickedMilestones,
  readApprovalToken,
  isTokenExpired,
  nowSec,
} from './loop-state.mjs';
import { appendEvent } from './ledger.mjs';

// ---------------------------------------------------------------------------
// Paths (env-overridable for tests; default to the skeleton layout)
// ---------------------------------------------------------------------------

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

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0); // Stop-hook block is exit-0 JSON, not exit 2 (protocol carried from v2).
}

function allow() {
  process.exit(0);
}

function envelope(state, sid) {
  return { run: state.run_id, shift: state.shift_id, session: sid, actor: 'hook:budget-stop' };
}

/** §4.2: budget-stop stamps the lease on every Stop it processes as primary. When
 * the payload carried no session id we keep whatever lease_session is there (never
 * invent an identity) and still stamp the renewal time. */
function renewLease(state, sid, now) {
  const lease = sid && sid !== 'cli' ? sid : state.lease_session;
  return { ...state, lease_session: lease ?? null, lease_renewed_at: now };
}

// ---------------------------------------------------------------------------
// Budget evaluation — shift ceilings first, then the cumulative run ceilings.
// ---------------------------------------------------------------------------

/** Which run ceiling (if any) is exhausted? `totals` already includes the current
 * open shift's counters. max_shifts uses `>` here (not `>=`): run_totals.shifts is
 * counted at shift START, so being IN shift N === max_shifts is legal — the ceiling
 * exists to stop shift max+1 from ever starting (--start-shift refuses with `>=`
 * against the pre-open count; same fence, both sides). */
function runExhaustedDesc(runCfg, totals) {
  if (runCfg.max_shifts > 0 && totals.shifts > runCfg.max_shifts) {
    return `${totals.shifts}/${runCfg.max_shifts} shifts`;
  }
  if (runCfg.max_iterations > 0 && totals.iterations >= runCfg.max_iterations) {
    return `${totals.iterations}/${runCfg.max_iterations} iterations`;
  }
  if (runCfg.max_active_seconds > 0 && totals.active_seconds >= runCfg.max_active_seconds) {
    return `${totals.active_seconds}s/${runCfg.max_active_seconds}s active`;
  }
  return null;
}

/** null when under every ceiling, else {scope, used, endReason}. Compares the
 * PROSPECTIVE iteration (state.iteration + 1) like v2, and accumulated
 * active_seconds — never calendar time (the 209%-of-6h regression stays dead). */
function evaluateBudget(state, eff) {
  const iterationAfter = (state.iteration || 0) + 1;
  const wallClock = state.active_seconds || 0;
  if (iterationAfter >= eff.shift.max_iterations) {
    return { scope: 'shift', used: `${iterationAfter}/${eff.shift.max_iterations} iterations`, endReason: 'budget_iterations' };
  }
  if (wallClock >= eff.shift.max_wall_clock_sec) {
    return { scope: 'shift', used: `${wallClock}s/${eff.shift.max_wall_clock_sec}s active`, endReason: 'budget_time' };
  }
  const rt = state.run_totals || {};
  const totals = {
    shifts: rt.shifts || 0,
    iterations: (rt.iterations || 0) + iterationAfter,
    active_seconds: (rt.active_seconds || 0) + wallClock,
  };
  const runDesc = runExhaustedDesc(eff.run, totals);
  if (runDesc) return { scope: 'run', used: runDesc, endReason: 'run_budget' };
  return null;
}

// ---------------------------------------------------------------------------
// Block reasons (formats pinned by tests)
// ---------------------------------------------------------------------------

function budgetBlockReason(verdict) {
  if (verdict.scope === 'run') {
    return (
      `budget exhausted: ${verdict.used} (run ceiling) — run the end-of-shift routine: author HANDOFF.md, ` +
      'then `node .claude/hooks/loop-state.mjs --record-handoff --kind authored` + `--end-shift --reason run_budget`, and STOP. ' +
      'A human must extend the run budget (`node .claude/hooks/loop-state.mjs --extend-budget run.<key>=<value>`) ' +
      'or record completion (`--complete-run`) before any new shift starts.'
    );
  }
  return (
    `budget exhausted: ${verdict.used} — run the end-of-shift routine: author HANDOFF.md (template inside it), ` +
    `then \`node .claude/hooks/loop-state.mjs --record-handoff --kind authored\` + \`--end-shift --reason ${verdict.endReason}\`, and STOP. ` +
    'Re-arm = a new shift.'
  );
}

// Includes the §4.4 headless clause so an unattended gated shift knows the clean exit.
const GATE_REVIEW_REASON =
  'Milestone complete — post the milestone review (what shipped / key design choices / next-milestone plan) ' +
  'and WAIT for human go-ahead. Do not start the next milestone. ' +
  'Approve with: node .claude/hooks/loop-state.mjs --approve [--operator <name>]. ' +
  'If no human is available (headless shift): post the milestone review into STATE.md `## Milestone digests`, ' +
  'author HANDOFF.md with End reason `milestone_gate`, run `node .claude/hooks/loop-state.mjs --record-handoff --kind authored` ' +
  '+ `--end-shift --reason milestone_gate`, and STOP.';

function gateWinddownReason(gateBlocks) {
  return (
    `milestone gate still pending after ${gateBlocks} gate block(s) with no approval — wind down NOW: ` +
    'post the milestone review into STATE.md `## Milestone digests`, author HANDOFF.md with End reason `milestone_gate`, ' +
    'run `node .claude/hooks/loop-state.mjs --record-handoff --kind authored` + `--end-shift --reason milestone_gate`, and STOP. ' +
    'The next Stop will be allowed either way.'
  );
}

// ---------------------------------------------------------------------------
// Secondary mode (§4.2 / §5.4 step 1): another session holds a fresh lease on the
// shift. Evaluate and block with the same reasons, but perform ZERO writes — the
// primary owns every counter, the gate, and the watermarks. Worktrees remain the
// documented parallel path.
// ---------------------------------------------------------------------------

function secondaryMode(state, eff, now, stopHookActive) {
  const age = now - (state.lease_renewed_at || 0);
  process.stderr.write(
    `budget-stop: another session holds shift ${state.shift_id || '(none)'} (lease age ${age}s) — ` +
      'counters not metered here; use a worktree for parallel work\n',
  );
  if (stopHookActive) {
    allow(); // one-shot: this secondary already blocked once this turn — never wedge it
    return;
  }
  if (state.shift_ended === true) {
    allow();
    return;
  }
  // Evaluate against the PERSISTED counters (no accumulate — the heartbeat cadence
  // belongs to the primary; guessing at its idle gap here could false-trip).
  const verdict = evaluateBudget(state, eff);
  if (verdict) {
    block(`[secondary session] ${budgetBlockReason(verdict)}`);
    return;
  }
  let stateMdText = '';
  try {
    stateMdText = readFileSync(stateMdPath(), 'utf8');
  } catch {
    /* no STATE.md — nothing to gate on */
  }
  const tickedCount = countTickedMilestones(stateMdText);
  if (state.milestone_gate === 'pending-approval' || tickedCount > (state.milestone_ticked_count || 0)) {
    block(`[secondary session] ${GATE_REVIEW_REASON}`);
    return;
  }
  allow();
}

// ---------------------------------------------------------------------------
// Main — §5.4, step by step.
// ---------------------------------------------------------------------------

function main() {
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('budget-stop: disabled (LOOPWRIGHT_HOOKS=0) — allowing stop\n');
    allow();
    return;
  }

  // 0. Parse the hook payload. The decision is driven entirely by loop.json +
  // loop-config.json + STATE.md — EXCEPT `stop_hook_active` (Claude Code's own
  // "this Stop is the re-invocation after a block" flag, the wind-down one-shot
  // signal) and `session_id` (the lease identity). Malformed payload → fail-open.
  let payload = {};
  try {
    const raw = readStdinSync();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`budget-stop: could not parse hook input, allowing stop (fail-open, O4): ${e.message}\n`);
    allow();
    return;
  }
  const stopHookActive = !!(payload && payload.stop_hook_active === true);
  const sid =
    (payload && typeof payload.session_id === 'string' && payload.session_id) ||
    process.env.LOOPWRIGHT_SESSION_ID ||
    'cli';

  try {
    const now = nowSec();
    const ljPath = loopJsonPath();
    const ledger = ledgerPath();
    const config = loadConfig(configPath()); // read FRESH every Stop (§5.2 — config edits apply at the next Stop)
    let state = readState(ljPath, ledger, config, now); // missing/corrupt → rehydrateFromLedger → fresh
    const eff = effectiveBudget(config, state); // config overlaid by loop.json budget_override

    // 1. Lease check: held by someone else AND fresh ⇒ secondary (never returns).
    const heldElsewhere = !!state.lease_session && state.lease_session !== sid;
    const leaseFresh = now - (state.lease_renewed_at || 0) < eff.session.lease_stale_sec;
    if (heldElsewhere && leaseFresh) {
      secondaryMode(state, eff, now, stopHookActive);
      return;
    }

    // 2. Accumulate ACTIVE seconds (idle gaps capped) BEFORE any branch advances
    // heartbeat_at — v2 math carried verbatim (§5.3). Primary only from here on.
    state = accumulateActiveSeconds(state, now, eff.shift.idle_gap_cap_sec);

    // 3. Shift already ended (shift_ended appended, nothing reopened) → allow.
    // This is the mechanical exit after --end-shift; nothing is written so the
    // closed shift's totals stay exactly as the shift_ended event recorded them.
    if (state.shift_ended === true) {
      allow();
      return;
    }

    // 4. BUDGET (shift, then run) — before the gate (R8).
    const verdict = evaluateBudget(state, eff);
    if (verdict) {
      // Wind-down fires EXACTLY ONCE (v2 O4 carried): `stop_hook_active` is the
      // in-turn signal, `winddown_posted` the persisted belt-and-suspenders.
      if (state.winddown_posted === true || stopHookActive) {
        state = renewLease(updateHeartbeat({ ...state, winddown_posted: true }, now), sid, now);
        writeState(ljPath, state);
        allow();
        return;
      }
      const n = (state.iteration || 0) + 1;
      state = renewLease(incrementIteration({ ...state, winddown_posted: true }, now), sid, now);
      // Events BEFORE the state write (§2.2 invariant).
      appendEvent(ledger, envelope(state, sid), 'winddown_posted', { scope: verdict.scope, reason: verdict.used });
      appendEvent(ledger, envelope(state, sid), 'iteration', { n, active_seconds: state.active_seconds || 0 });
      writeState(ljPath, state);
      block(budgetBlockReason(verdict));
      return;
    }

    // 5. MILESTONE GATE — mechanical even in headless/auto mode (F25 carried).
    let stateMdText = '';
    try {
      stateMdText = readFileSync(stateMdPath(), 'utf8');
    } catch {
      /* no STATE.md yet (very early run) — nothing to check for milestones */
    }
    const tickedCount = countTickedMilestones(stateMdText);
    const milestoneAdvanced = tickedCount > (state.milestone_ticked_count || 0);
    const gatePending = state.milestone_gate === 'pending-approval';

    if (milestoneAdvanced || gatePending) {
      const tok = readApprovalToken(state.approval_token);
      if (gatePending && tok && !isTokenExpired(tok, now)) {
        // Consume — only while the gate is ALREADY pending (v2 pinned invariant:
        // a token set early never pre-clears a future milestone's gate; that box
        // always gets at least one real block-and-review cycle).
        const kindText = tok.class === 'self' ? 'self-approved (standing authorization)' : 'human-approved';
        process.stderr.write(`budget-stop: milestone gate cleared — ${kindText} by ${tok.operator}: ${tok.value}\n`);
        appendEvent(ledger, envelope(state, sid), 'approval_consumed', {
          kind: tok.class,
          operator: tok.operator,
          milestone_count: tickedCount,
        });
        state = clearApprovalAndGate(updateHeartbeat(state, now), tickedCount);
        // fall through to step 6 — the budget already passed in step 4.
      } else {
        // Expired tokens are never consumed (§4.4/O1): audit the expiry, clear the
        // token, and let the gate re-block — the approval must be re-granted.
        if (tok && isTokenExpired(tok, now)) {
          process.stderr.write(
            `budget-stop: approval token from ${tok.operator} expired at ${tok.expires_at} — not consumed; the gate re-blocks\n`,
          );
          appendEvent(ledger, envelope(state, sid), 'approval_expired', { operator: tok.operator, granted_at: tok.granted_at });
          state = { ...state, approval_token: null };
        }
        // gate_block_max convergence (§4.4): a non-compliant model still reaches an
        // allowed Stop in bounded turns, with the wind-down posted exactly once.
        if ((state.gate_blocks || 0) >= eff.milestone.gate_block_max) {
          if (state.gate_winddown_posted === true || stopHookActive) {
            state = renewLease(updateHeartbeat({ ...state, gate_winddown_posted: true }, now), sid, now);
            writeState(ljPath, state);
            allow();
            return;
          }
          state = renewLease(updateHeartbeat({ ...state, gate_winddown_posted: true }, now), sid, now);
          appendEvent(ledger, envelope(state, sid), 'winddown_posted', {
            scope: 'gate',
            reason: `gate pending after ${state.gate_blocks || 0} block(s), no approval`,
          });
          writeState(ljPath, state);
          block(gateWinddownReason(state.gate_blocks || 0));
          return;
        }
        // Arm (event on FIRST arm only) and block with the review + headless clause.
        if (!gatePending) {
          appendEvent(ledger, envelope(state, sid), 'milestone_gate_pending', { count: tickedCount });
        }
        state = renewLease(
          updateHeartbeat({ ...state, milestone_gate: 'pending-approval', gate_blocks: (state.gate_blocks || 0) + 1 }, now),
          sid,
          now,
        );
        writeState(ljPath, state);
        block(GATE_REVIEW_REASON);
        return;
      }
    }

    // 6. Under every ceiling: count the iteration, journal it, renew the lease,
    // persist, allow. The `iteration` event is what makes loop.json disposable
    // mid-shift (R5) — never skip it on an allowed Stop.
    const n = (state.iteration || 0) + 1;
    state = renewLease(incrementIteration(state, now), sid, now);
    appendEvent(ledger, envelope(state, sid), 'iteration', { n, active_seconds: state.active_seconds || 0 });
    writeState(ljPath, state);
    allow();
  } catch (e) {
    process.stderr.write(`budget-stop: internal error, allowing stop (fail-open, O4): ${e.stack || e.message}\n`);
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
    // loudly — exactly the kind of quiet failure this backstop exists to prevent.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) main();

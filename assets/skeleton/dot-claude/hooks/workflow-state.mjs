#!/usr/bin/env node
// v3 workflow-state.mjs — UserPromptSubmit keystone (spec §3): the per-turn
// workflow-state contract. EVERY turn it re-derives "where are we" from files
// (session pointer → TASKS.md → WORKFLOW.md → loop.json best-effort), resolves
// the active status by the strict §3.2 priority, and injects the §3.3 header +
// the matching [workflow-state:<status>] block VERBATIM. Because it re-fires
// every turn from files, the contract survives compaction by construction.
//
// Grammar source of truth is .claude/WORKFLOW.md — there is NO fallback dict in
// code: a deleted/renamed block degrades VISIBLY (§3.4 ladder), never silently
// (Trellis rule kept). The only write this hook ever performs is the throttled
// session-pointer `last_seen_at` refresh (≥300 s — R20 keeps the steady path
// O(reads)).
//
// Latency pin (§1.5): ≤4 small reads (session ptr, loop.json, TASKS.md,
// WORKFLOW.md), ZERO subprocess spawns — this module (and its one local import,
// tasks.mjs) must never import node:child_process; the invariant test greps for
// it. That is also why loop.json is parsed directly here instead of via
// loop-state.readState (which imports child_process for git fallbacks and would
// replay the ledger on a missing file — too heavy for every turn).
//
// Fail mode: fail-open. Malformed stdin, unreadable files, or any throw ⇒
// exit 0; inside a harness project the degrade is never silent (header still
// injected per §3.4 rungs 2–5); outside one (no .claude/STATE.md) it is a
// silent no-op. Greppable stderr prefix: `workflow-state:`.

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseBoard, activeRow } from './tasks.mjs';

// ---------------------------------------------------------------------------
// Grammar (§3.1) — the parse regex is PINNED by the spec and by tests.
// ---------------------------------------------------------------------------

export const WORKFLOW_BLOCK_RE = /\[workflow-state:([a-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/;

/** Pseudo-statuses computed from loop.json (§3.2) — they outrank task statuses
 * and each must have a block in the shipped WORKFLOW.md (invariant test a). */
export const PSEUDO_STATUSES = Object.freeze(['winddown', 'gate_pending', 'no_task']);

/** last_seen_at refresh throttle (§3.4 R20): skip the write when fresher than this. */
export const LAST_SEEN_THROTTLE_SEC = 300;

/** parseWorkflowStates(md) → { status: body } (statuses lowercased; body verbatim,
 * first occurrence wins). Never throws; non-string ⇒ {}. */
export function parseWorkflowStates(md) {
  const blocks = {};
  if (typeof md !== 'string') return blocks;
  const re = new RegExp(WORKFLOW_BLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(md)) !== null) {
    const status = m[1].toLowerCase();
    if (!(status in blocks)) blocks[status] = m[2];
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Resolution (§3.2) — strict priority, pinned:
//   1 winddown  (winddown_posted ∨ gate_winddown_posted)
//   2 gate_pending  (milestone_gate === 'pending-approval')
//   3 active-task status  (session pointer active_task → board row; fallback:
//     exactly one row in {in_progress,verifying,committing})
//   4 no_task
// Pseudo-statuses require a readable loop.json (state); rung 5 skips them.
// ---------------------------------------------------------------------------

function findRow(board, id) {
  if (!board || board.error || !id) return null;
  return board.rows.find((r) => r.id === id) || board.archiveRows.find((r) => r.id === id) || null;
}

function boardActive(board) {
  if (!board || board.error) return null;
  return activeRow(board.rows);
}

/** resolveStatus({state, pointer, board}) → {status, row}. `state` is the parsed
 * loop.json (or null when unreadable — pseudo-statuses skipped, §3.4 rung 5);
 * `pointer` is THIS session's pointer file (or null — never another session's
 * task, §3.4 rung 4); `board` is a tasks.mjs parseBoard result (or null). */
export function resolveStatus({ state = null, pointer = null, board = null } = {}) {
  if (state) {
    if (state.winddown_posted === true || state.gate_winddown_posted === true) {
      return { status: 'winddown', row: boardActive(board) };
    }
    if (state.milestone_gate === 'pending-approval') {
      return { status: 'gate_pending', row: boardActive(board) };
    }
  }
  if (pointer && pointer.active_task) {
    const row = findRow(board, pointer.active_task);
    if (row && row.status) return { status: String(row.status).toLowerCase(), row };
  }
  const act = boardActive(board);
  if (act) return { status: String(act.status).toLowerCase(), row: act };
  return { status: 'no_task', row: null };
}

// ---------------------------------------------------------------------------
// Injection (§3.3) — the header line is ALWAYS emitted when the project
// resolves; it alone carries the exact-resume pointer.
// ---------------------------------------------------------------------------

// Display-only shift budget from loop.json alone (snapshot + shift.* override) —
// enforcement reads loop-config.json fresh in budget-stop; reading it here too
// would break the ≤4-reads pin for a purely informational denominator.
function effectiveShiftBudget(state) {
  const snap = state.budget && typeof state.budget === 'object' ? state.budget : {};
  const b = {
    max_iterations: Number.isFinite(snap.max_iterations) ? snap.max_iterations : 40,
    max_wall_clock_sec: Number.isFinite(snap.max_wall_clock_sec) ? snap.max_wall_clock_sec : 21600,
  };
  const ov = state.budget_override;
  if (ov && typeof ov === 'object') {
    if (Number.isFinite(ov['shift.max_iterations'])) b.max_iterations = ov['shift.max_iterations'];
    if (Number.isFinite(ov['shift.max_wall_clock_sec'])) b.max_wall_clock_sec = ov['shift.max_wall_clock_sec'];
  }
  return b;
}

/** The §3.3 header line. state === null ⇒ the §3.4 rung-5 form (loop.json
 * unreadable): `shift: (unknown)` and pseudo-statuses are already skipped. */
export function buildHeader(state) {
  if (!state) return 'shift: (unknown) · gate: (unknown)';
  const gate = state.milestone_gate || 'clear';
  const rt = state.run_totals && typeof state.run_totals === 'object' ? state.run_totals : {};
  const runShifts = Number(rt.shifts) || 0;
  const openLive = !!state.shift_id && state.shift_ended !== true;
  const runIters = (Number(rt.iterations) || 0) + (openLive ? Number(state.iteration) || 0 : 0);
  if (!state.shift_id) return `Shift (none open) · run ${runShifts} shifts/${runIters} it · gate: ${gate}`;
  const b = effectiveShiftBudget(state);
  return (
    `Shift ${state.shift_id} (${state.operator || 'unknown'})` +
    ` · iter ${Number(state.iteration) || 0}/${b.max_iterations}` +
    ` · ${Number(state.active_seconds) || 0}/${b.max_wall_clock_sec}s` +
    ` · run ${runShifts} shifts/${runIters} it · gate: ${gate}`
  );
}

const CANDIDATE_STATUSES = ['queued', 'planning', 'blocked'];

/** Task line: resolved row ⇒ `Task T14 (in_progress) — next: <cell>`; no row ⇒
 * `(none active)` + the no_task candidate list (§3.2 rung 4: candidates listed). */
export function buildTaskLine(resolved, board) {
  if (resolved && resolved.row) {
    const r = resolved.row;
    return `Task ${r.id} (${String(r.status).toLowerCase()}) — next: ${r.next_step || '(next-step cell empty)'}`;
  }
  const rows = board && !board.error ? board.rows : [];
  const cands = rows.filter((r) => CANDIDATE_STATUSES.includes(String(r.status).toLowerCase()));
  if (cands.length === 0) return 'Task: (none active)';
  const shown = cands.slice(0, 6).map((r) => `${r.id} (${String(r.status).toLowerCase()})`).join(', ');
  const more = cands.length > 6 ? ` +${cands.length - 6} more` : '';
  return `Task: (none active) · candidates: ${shown}${more}`;
}

// ---------------------------------------------------------------------------
// Paths — env-overridable (the test seam, v2 convention).
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

function tasksMdPath() {
  return process.env.LOOPWRIGHT_TASKS_MD || path.join(claudeDir(), 'TASKS.md');
}

function workflowMdPath() {
  return process.env.LOOPWRIGHT_WORKFLOW_MD || path.join(claudeDir(), 'WORKFLOW.md');
}

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function runtimeDir() {
  return process.env.LOOPWRIGHT_RUNTIME_DIR || path.join(claudeDir(), '.runtime');
}

function readFileSoft(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Session ids come from the host payload — refuse anything path-hostile rather
// than joining it into a filesystem path (defense in depth; ids are UUID-ish).
function safeSessionId(payload) {
  const sid = (payload && payload.session_id) || process.env.LOOPWRIGHT_SESSION_ID || '';
  return typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sid) ? sid : null;
}

// Local atomic write (temp+rename, v2 discipline). Deliberately NOT imported
// from loop-state.mjs — see the no-child_process latency pin in the header.
function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Hook main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('workflow-state: disabled via LOOPWRIGHT_HOOKS=0\n');
    process.exit(0);
    return;
  }

  let payload = {};
  try {
    const raw = readStdinSync();
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
    if (!payload || typeof payload !== 'object') payload = {};
  } catch (e) {
    // §3.5(j): malformed stdin ⇒ exit 0, empty stdout, greppable stderr.
    process.stderr.write(`workflow-state: could not parse hook input, no-op: ${e.message}\n`);
    process.exit(0);
    return;
  }

  try {
    // §3.4 rung 1 — not a loopwright project: silent exit, empty stdout.
    if (!existsSync(stateMdPath())) {
      process.exit(0);
      return;
    }

    // ≤4 small reads, in one place so the pin stays visible:
    const loopRaw = readFileSoft(loopJsonPath()); // 1
    const tasksRaw = readFileSoft(tasksMdPath()); // 2
    const workflowRaw = readFileSoft(workflowMdPath()); // 3
    const sid = safeSessionId(payload);
    const pointerPath = sid ? path.join(runtimeDir(), 'sessions', `${sid}.json`) : null;
    const pointerRaw = pointerPath ? readFileSoft(pointerPath) : null; // 4

    let state = null; // null ⇒ §3.4 rung 5 (missing OR corrupt loop.json)
    if (loopRaw !== null) {
      try {
        const p = JSON.parse(loopRaw);
        if (p && typeof p === 'object') state = p;
      } catch {
        process.stderr.write('workflow-state: loop.json unreadable — shift shown as (unknown), pseudo-statuses skipped\n');
      }
    }

    const board = tasksRaw === null ? null : parseBoard(tasksRaw);
    if (board && board.error) {
      process.stderr.write(`workflow-state: TASKS.md degraded parse (${board.error})\n`);
    }

    let pointer = null; // §3.4 rung 4: missing file / no session_id ⇒ rungs 3–4
    if (pointerRaw !== null) {
      try {
        const p = JSON.parse(pointerRaw);
        if (p && typeof p === 'object') pointer = p;
      } catch {
        /* corrupt pointer — resolution continues without it */
      }
    }

    const resolved = resolveStatus({ state, pointer, board });
    const header = buildHeader(state);
    const taskLine = buildTaskLine(resolved, board);

    let body;
    if (workflowRaw === null) {
      // §3.4 rung 2 — never silent inside a harness project.
      body = '(WORKFLOW.md missing — restore from git or run /loopwright:upgrade)';
    } else {
      const blocks = parseWorkflowStates(workflowRaw);
      body =
        blocks[resolved.status] !== undefined
          ? blocks[resolved.status]
          : // §3.4 rung 3 — status resolved, block missing.
            `No [workflow-state:${resolved.status}] block in .claude/WORKFLOW.md — proceed per /loop; consider adding one.`;
    }

    const context = ['<workflow-state>', header, taskLine, body, '</workflow-state>'].join('\n');
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      }) + '\n',
    );

    // The ONE write: throttled last_seen_at refresh (≥300 s, R20). Only refreshes
    // a pointer session-boot already created — this hook never mints session files.
    if (pointer && pointerPath) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const lastSeen = Number(pointer.last_seen_at) || 0;
        if (now - lastSeen >= LAST_SEEN_THROTTLE_SEC) {
          atomicWrite(pointerPath, JSON.stringify({ ...pointer, last_seen_at: now }, null, 2) + '\n');
        }
      } catch (e) {
        process.stderr.write(`workflow-state: last_seen_at refresh skipped: ${e.message}\n`);
      }
    }

    process.exit(0);
  } catch (e) {
    // §3.4 rung 6 — any throw: exit 0, empty stdout, greppable stderr.
    process.stderr.write(`workflow-state: internal error, no-op: ${e.stack || e.message}\n`);
    process.exit(0);
  }
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // Case-insensitive compare on Windows: drive-letter/segment casing between
    // argv[1] and Node's resolution of import.meta.url is not guaranteed to
    // match on a case-insensitive filesystem; strict === would silently no-op.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) main();

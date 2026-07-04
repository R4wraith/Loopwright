// v3 ledger.mjs — the append-only run ledger, the substrate everything replays from
// (spec §2). LIBRARY ONLY: no CLI main — loop-state.mjs is the one operator surface
// (R17); hooks and the CLI import this module.
//
// Contract (§2.1): `.claude/ledger/events.jsonl` — one JSON object per line, ≤4 KB,
// one complete line per single appendFileSync call (torn lines are possible only on
// power loss / fs corruption, and the reader tolerates them ANYWHERE, not just the
// tail). The file is git-tracked with `merge=union` (.gitattributes), so the reader
// also dedupes exact-duplicate lines — union merges can duplicate, replay must be
// idempotent.
//
// Precedence contract (§1.2): markdown wins for INTENT, this ledger wins for HISTORY
// and COUNTERS, loop.json wins over nothing (it is a disposable cache rebuilt by
// replay → loop-state.rehydrateFromLedger).
//
// Node stdlib only. Writers throw on protocol violations (unknown event kind,
// oversized line) — callers decide their own fail-open/fail-closed posture; the
// READER never throws on bad content, it skips with a greppable stderr line.

import { readFileSync, appendFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Event vocabulary — the closed set (§2.2, schema 3). Writers refuse anything
// else; readers skip-with-warning so a NEWER schema's events degrade instead of
// crashing an older reader.
// ---------------------------------------------------------------------------

export const EVENTS = Object.freeze([
  'run_started',
  'run_completed',
  'shift_started',
  'shift_ended',
  'session_started',
  'session_ended',
  'session_takeover',
  'iteration',
  'task_created',
  'task_status',
  'dispatch',
  'slice_verified',
  'slice_committed',
  'milestone_gate_pending',
  'approval_granted',
  'approval_consumed',
  'approval_expired',
  'winddown_posted',
  'budget_extended',
  'handoff_written',
  'compaction_anchor_written',
  'routine_run',
  'ledger_rotated',
  'migrated',
]);

const EVENT_SET = new Set(EVENTS);

/** Hard per-line ceiling (§2.1). Includes the trailing newline. */
export const MAX_LINE_BYTES = 4096;

/** ISO-8601 UTC to the second (the envelope `ts` shape: 2026-07-04T18:22:31Z). */
export function isoNow(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// appendEvent — the ONE write path (§2.1): build envelope, validate, single
// appendFileSync of one complete line. Creates ledger/ + the file if absent.
// ---------------------------------------------------------------------------

/**
 * @param {string} ledgerPath  path to events.jsonl
 * @param {object} envelopeFields  {run, shift, session, actor, ts?} — shift may be
 *   null pre-shift; session is the hook/CLI session id or "cli"; actor is
 *   "hook:<name>" | "cli:<verb>" | "upgrade".
 * @param {string} event  must be in EVENTS (unknown → throw: writers are strict)
 * @param {object} data   event payload per §2.2
 * @returns the appended envelope object
 */
export function appendEvent(ledgerPath, envelopeFields, event, data = {}) {
  if (!EVENT_SET.has(event)) {
    throw new Error(`ledger: unknown event kind "${event}" — writer refused (closed vocabulary, schema 3)`);
  }
  const f = envelopeFields || {};
  const envelope = {
    ts: f.ts || isoNow(),
    run: f.run ?? null,
    shift: f.shift ?? null,
    session: f.session || 'cli',
    actor: f.actor || 'cli',
    event,
    data: data && typeof data === 'object' ? data : {},
  };
  const line = JSON.stringify(envelope);
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) {
    throw new Error(`ledger: refusing to append "${event}" — line exceeds ${MAX_LINE_BYTES} bytes (§2.1 cap); trim data`);
  }
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // One complete line per single appendFileSync call — the crash-atomicity floor (S1).
  appendFileSync(ledgerPath, line + '\n', { flag: 'a' });
  return envelope;
}

// ---------------------------------------------------------------------------
// readLedger — the tolerant reader (§2.1 reader contract): skip unparseable
// lines ANYWHERE (not just the tail) with ONE stderr summary; skip unknown
// event kinds with a warning; dedupe on exact line identity (union merges);
// never crash. Missing file ⇒ [].
// ---------------------------------------------------------------------------

export function readLedger(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return []; // no ledger yet — not an error
  }
  const events = [];
  const seen = new Set();
  let unparseable = 0;
  const unknownKinds = new Set();
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine; // tolerate CRLF drift
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparseable++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
      unparseable++;
      continue;
    }
    if (!EVENT_SET.has(parsed.event)) {
      unknownKinds.add(parsed.event);
      continue;
    }
    if (seen.has(line)) continue; // union-merge duplicate — replay must be idempotent
    seen.add(line);
    events.push(parsed);
  }
  if (unparseable > 0) {
    process.stderr.write(`ledger: skipped ${unparseable} unparseable line(s)\n`);
  }
  if (unknownKinds.size > 0) {
    process.stderr.write(`ledger: skipped ${unknownKinds.size} unknown event kind(s): ${[...unknownKinds].join(', ')}\n`);
  }
  return events;
}

/** Count raw unparseable lines without filtering — used by --doctor/--status. */
export function countUnparseableLines(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    try {
      const p = JSON.parse(line);
      if (!p || typeof p !== 'object' || typeof p.event !== 'string') n++;
    } catch {
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// replay — pure derivation of current position from events (§2.3). This is the
// function that makes loop.json disposable: everything enumerated in §2.3 comes
// back from here. Order-sensitive by design (file order IS the order).
// ---------------------------------------------------------------------------

function emptyRunTotals() {
  return { shifts: 0, iterations: 0, active_seconds: 0 };
}

export function replay(events) {
  const state = {
    run_id: null,
    run_completed: false,
    milestone_ticked_count: 0, // §2.3.2 — last approval_consumed.milestone_count (else carried)
    gate: 'clear', // §2.3.3 — 'pending-approval' iff last gate arm has no later consume
    approval_token: null, // §2.3.4 — object incl. expiry, from last unconsumed/unexpired grant
    last_commit_sha: null, // §2.3.5 — last slice_committed.sha
    verified_tree_sha: null, // §2.3.6 — last slice_verified with NO later slice_committed
    run_totals: emptyRunTotals(), // §2.3.7 — closed shifts only (+ carried); open shift is separate
    open_shift: null, // §2.3.8
    shift_history: [], // rows per §2.2 ledger_rotated.carried.shift_history
    task_latest: {}, // task → last {to, from, next_step, ts, title, milestone}
    last_handoff: null, // {shift, kind, ts} — /status renders thin/backfilled flag from this
  };

  const closeOpenShift = (ev, reason, totals) => {
    const os = state.open_shift;
    const row = {
      shift: (os && os.id) || (ev && ev.shift) || null,
      seq: os ? os.seq : null,
      operator: os ? os.operator : null,
      mode: os ? os.mode : null,
      started: os ? os.started : null,
      ended: ev ? ev.ts : null,
      iterations: Number.isFinite(totals && totals.iterations) ? totals.iterations : (os ? os.iteration : 0),
      active_seconds: Number.isFinite(totals && totals.active_seconds) ? totals.active_seconds : (os ? os.active_seconds : 0),
      reason,
      last_commit: os ? os.last_commit : null,
    };
    state.shift_history.push(row);
    state.run_totals.shifts += 1;
    state.run_totals.iterations += row.iterations || 0;
    state.run_totals.active_seconds += row.active_seconds || 0;
    state.open_shift = null;
  };

  for (const ev of events) {
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
    switch (ev.event) {
      case 'ledger_rotated': {
        const c = data.carried && typeof data.carried === 'object' ? data.carried : {};
        if (c.run_id) state.run_id = c.run_id;
        if (Number.isFinite(c.milestone_ticked_count)) state.milestone_ticked_count = c.milestone_ticked_count;
        if (c.last_commit_sha !== undefined) state.last_commit_sha = c.last_commit_sha;
        if (c.run_totals && typeof c.run_totals === 'object') {
          state.run_totals = {
            shifts: Number(c.run_totals.shifts) || 0,
            iterations: Number(c.run_totals.iterations) || 0,
            active_seconds: Number(c.run_totals.active_seconds) || 0,
          };
        }
        if (Array.isArray(c.shift_history)) state.shift_history = c.shift_history.map((r) => ({ ...r }));
        break;
      }
      case 'run_started':
        if (ev.run) state.run_id = ev.run;
        break;
      case 'run_completed':
        state.run_completed = true;
        break;
      case 'shift_started': {
        // Protocol says a shift_ended always precedes the next shift_started; a lost
        // (torn) shift_ended line must not wedge replay — close defensively.
        if (state.open_shift) closeOpenShift(ev, 'unknown', null);
        state.open_shift = {
          id: ev.shift || null,
          seq: Number.isFinite(data.seq) ? data.seq : null,
          operator: data.operator || null,
          mode: data.mode || 'interactive',
          implicit: data.implicit === true,
          started: ev.ts || null,
          iteration: 0,
          active_seconds: 0,
          winddown_posted: false,
          gate_winddown_posted: false,
          commits: 0,
          commit_shas: [],
          last_commit: null,
        };
        break;
      }
      case 'shift_ended':
        closeOpenShift(ev, data.reason || 'manual', data);
        break;
      case 'iteration': {
        const os = state.open_shift;
        if (os && ev.shift === os.id) {
          if (Number.isFinite(data.n) && data.n > os.iteration) os.iteration = data.n;
          if (Number.isFinite(data.active_seconds)) os.active_seconds = data.active_seconds;
        }
        break;
      }
      case 'slice_committed': {
        if (data.sha) state.last_commit_sha = data.sha;
        state.verified_tree_sha = null; // §2.3.6: a later commit invalidates the verified stamp
        const os = state.open_shift;
        if (os) {
          os.commits += 1;
          if (data.sha) {
            os.commit_shas.push(data.sha);
            os.last_commit = data.sha;
          }
        }
        break;
      }
      case 'slice_verified':
        state.verified_tree_sha = data.tree_sha || null;
        break;
      case 'milestone_gate_pending':
        state.gate = 'pending-approval';
        break;
      case 'approval_granted':
        state.approval_token = {
          value: data.token ?? null,
          class: data.kind === 'self' ? 'self' : 'human',
          operator: data.operator || 'unknown',
          granted_at: data.granted_at || ev.ts || null,
          expires_at: data.expires_at ?? null,
        };
        break;
      case 'approval_consumed':
        state.gate = 'clear';
        state.approval_token = null;
        if (Number.isFinite(data.milestone_count)) state.milestone_ticked_count = data.milestone_count;
        break;
      case 'approval_expired':
        state.approval_token = null;
        break;
      case 'winddown_posted': {
        const os = state.open_shift;
        if (os && ev.shift === os.id) {
          if (data.scope === 'gate') os.gate_winddown_posted = true;
          else os.winddown_posted = true; // scope shift | run — both persist the flag
        }
        break;
      }
      case 'task_created': {
        if (data.task) {
          state.task_latest[data.task] = {
            to: 'queued',
            from: null,
            next_step: data.next_step ?? null,
            ts: ev.ts || null,
            title: data.title ?? null,
            milestone: data.milestone ?? null,
          };
        }
        break;
      }
      case 'task_status': {
        if (data.task) {
          const prev = state.task_latest[data.task] || {};
          state.task_latest[data.task] = {
            ...prev,
            to: data.to ?? null,
            from: data.from ?? null,
            next_step: data.next_step ?? prev.next_step ?? null,
            ts: ev.ts || null,
          };
        }
        break;
      }
      case 'handoff_written':
        state.last_handoff = { shift: data.shift ?? ev.shift ?? null, kind: data.kind || null, ts: ev.ts || null };
        break;
      default:
        // session_started/ended, session_takeover, dispatch, budget_extended,
        // compaction_anchor_written, routine_run, migrated — attribution/audit
        // events with no derived-position effect here.
        break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// rotate — shift-end-only rotation (§2.2): when the file exceeds rotateLines,
// move it to ledger/archive/events-<UTCstamp>.jsonl and seed the fresh file
// with ONE ledger_rotated genesis event whose `carried` snapshot makes replay
// of the fresh file alone (and --shifts history) archive-free.
// ---------------------------------------------------------------------------

function compactStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/**
 * @param {string} ledgerPath
 * @param {object} carried  {run_id, run_totals, milestone_ticked_count,
 *   last_commit_sha, shift_history} — usually built from replay() at shift end.
 * @param {number} rotateLines  threshold (default 5000; config ledger.rotate_lines)
 * @param {object} envelopeFields  optional {run, shift, session, actor} for the genesis
 * @returns {null | {archived: string, genesis: object}}  null = below threshold / no file
 */
export function rotate(ledgerPath, carried, rotateLines = 5000, envelopeFields = {}) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return null;
  }
  const threshold = Number.isFinite(rotateLines) && rotateLines > 0 ? rotateLines : 5000;
  let lineCount = 0;
  for (const line of raw.split('\n')) if (line.trim() !== '') lineCount++;
  if (lineCount <= threshold) return null;

  const archiveDir = path.join(path.dirname(ledgerPath), 'archive');
  mkdirSync(archiveDir, { recursive: true });
  let archivePath = path.join(archiveDir, `events-${compactStamp()}.jsonl`);
  for (let i = 1; existsSync(archivePath); i++) {
    archivePath = path.join(archiveDir, `events-${compactStamp()}-${i}.jsonl`);
  }
  renameSync(ledgerPath, archivePath);

  const c = carried && typeof carried === 'object' ? carried : {};
  let history = Array.isArray(c.shift_history) ? c.shift_history.slice(-50) : [];
  const fields = {
    run: envelopeFields.run ?? c.run_id ?? null,
    shift: envelopeFields.shift ?? null,
    session: envelopeFields.session || 'cli',
    actor: envelopeFields.actor || 'cli:end-shift',
  };
  let genesis;
  for (;;) {
    try {
      genesis = appendEvent(ledgerPath, fields, 'ledger_rotated', {
        carried: {
          run_id: c.run_id ?? null,
          run_totals: c.run_totals && typeof c.run_totals === 'object' ? c.run_totals : emptyRunTotals(),
          milestone_ticked_count: Number.isFinite(c.milestone_ticked_count) ? c.milestone_ticked_count : 0,
          last_commit_sha: c.last_commit_sha ?? null,
          shift_history: history,
        },
      });
      break;
    } catch (e) {
      // ≤4 KB line cap: shed the OLDEST history rows until the genesis fits.
      if (history.length === 0) throw e;
      history = history.slice(Math.ceil(history.length / 2));
    }
  }
  return { archived: archivePath, genesis };
}

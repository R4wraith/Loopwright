#!/usr/bin/env node
// v3 loop-state.mjs — shared state library + THE one operator CLI (R17). Every hook
// that touches loop.json imports this; every human/model mutation of run state goes
// through a verb here.
//
// State model (§1.2): `.claude/loop.json` is a DISPOSABLE CACHE of counters + the
// shift lease. Missing or corrupt ⇒ readState overlays rehydrateFromLedger (§2.3) —
// deleting it no longer forgives un-journaled commits, re-arms budgets, or
// re-triggers approved milestones (the v2 delete-loop.json wedge is gone).
// `.claude/ledger/events.jsonl` is truth for history; TASKS/STATE/HANDOFF markdown
// is truth for intent.
//
// Invariant (§2.2, pinned): every mutating CLI verb appends its ledger event BEFORE
// the state/board write. A crash between the two is completable FORWARD by
// `--doctor --repair`; nothing is ever rolled back (R4/R25).
//
// Fail-safe, not fail-closed (v2 posture carried): a missing or corrupt loop.json
// degrades to rehydrate-then-fresh, never a throw. guard.mjs is the only
// fail-closed hook in the harness.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { appendEvent, readLedger, replay, rotate, countUnparseableLines } from './ledger.mjs';
import {
  STATUSES,
  ACTIVE_STATUSES,
  canTransition,
  TRANSITIONS,
  parseBoard,
  serializeBoard,
  upsertRow,
  nextTaskId,
  activeRow,
  emptyBoard,
} from './tasks.mjs';

// ---------------------------------------------------------------------------
// Budget config — v3 nested shape (§5.1). Mirrored, with commentary, in
// hooks/loop-config.json; loadConfig falls back to these values per key.
// 0 = unlimited on every run.* ceiling.
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  shift: Object.freeze({
    max_iterations: 40,
    max_wall_clock_sec: 21600, // 6h of ACTIVE time (idle gaps capped) — see accumulateActiveSeconds
    idle_gap_cap_sec: 600,
  }),
  run: Object.freeze({
    max_shifts: 0,
    max_iterations: 0,
    max_active_seconds: 0,
  }),
  milestone: Object.freeze({
    gate_block_max: 3,
    approval_ttl_hours: 72,
    milestone_iter_soft: 12,
  }),
  session: Object.freeze({
    lease_stale_sec: 900,
    stale_after_sec: 259200, // 3 days — session-pointer TTL sweep
  }),
  ledger: Object.freeze({
    rotate_lines: 5000,
  }),
  routines: Object.freeze({}), // menu for /routine only — NO hook reads this (§4.5)
});

const CONFIG_SECTIONS = ['shift', 'run', 'milestone', 'session', 'ledger'];

// v2 flat-shape acceptance (upgrade tolerance, pinned): flat keys map into the
// nested sections. Nested keys win when both are present.
const V2_FLAT_MAP = Object.freeze({
  max_iterations: ['shift', 'max_iterations'],
  max_wall_clock_sec: ['shift', 'max_wall_clock_sec'],
  idle_gap_cap_sec: ['shift', 'idle_gap_cap_sec'],
  milestone_iter_soft: ['milestone', 'milestone_iter_soft'],
});

function copyConfig(cfg) {
  const out = {};
  for (const sec of CONFIG_SECTIONS) out[sec] = { ...cfg[sec] };
  out.routines = { ...(cfg.routines || {}) };
  return out;
}

/** Load hooks/loop-config.json, per-key merged over DEFAULT_CONFIG. Missing,
 * unreadable, or unparseable ⇒ DEFAULT_CONFIG copy (fail-safe — a broken config
 * loses the human's overrides, never crashes the harness). Read FRESH at every
 * Stop (§5.2: edit config mid-run → applies at the next Stop). */
export function loadConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return copyConfig(DEFAULT_CONFIG);
  }
  if (!parsed || typeof parsed !== 'object') return copyConfig(DEFAULT_CONFIG);
  const cfg = copyConfig(DEFAULT_CONFIG);
  for (const [flat, [sec, key]] of Object.entries(V2_FLAT_MAP)) {
    if (Number.isFinite(parsed[flat])) cfg[sec][key] = parsed[flat];
  }
  for (const sec of CONFIG_SECTIONS) {
    if (parsed[sec] && typeof parsed[sec] === 'object') {
      for (const key of Object.keys(cfg[sec])) {
        if (Number.isFinite(parsed[sec][key])) cfg[sec][key] = parsed[sec][key];
      }
    }
  }
  if (parsed.routines && typeof parsed.routines === 'object') cfg.routines = parsed.routines;
  return cfg;
}

/** Effective budget at any moment (§5.2): fresh config overlaid by the explicit
 * per-shift override in loop.json (`budget_override`, flat "scope.key" entries set
 * only by --start-shift budget flags or --extend-budget). The shift-start snapshot
 * in state.budget is audit-only and never consulted for enforcement. */
export function effectiveBudget(config, state) {
  const eff = copyConfig(config || DEFAULT_CONFIG);
  const ov = state && state.budget_override;
  if (ov && typeof ov === 'object') {
    for (const [k, v] of Object.entries(ov)) {
      const dot = String(k).indexOf('.');
      if (dot <= 0) continue;
      const sec = k.slice(0, dot);
      const key = k.slice(dot + 1);
      if (CONFIG_SECTIONS.includes(sec) && key in eff[sec] && Number.isFinite(v)) eff[sec][key] = v;
    }
  }
  return eff;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function isoFromSec(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** run_id = r-<UTCstamp> to the minute (§1.1), e.g. r-20260704T0800Z. */
export function mintRunId(now = nowSec()) {
  const d = new Date(now * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `r-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

/** shift_id = s-NNN, zero-padded (§4.1.1). */
export function shiftIdFromSeq(seq) {
  return `s-${String(seq).padStart(3, '0')}`;
}

/** Operator resolution (§4.1.1): --operator flag → LOOPWRIGHT_OPERATOR env →
 * `git config user.name` (fail-soft) → "unknown". `auto` is reserved for headless
 * and only ever set explicitly (recipes/runner) — never inferred. */
export function resolveOperator({ flag = '', projectDir = '' } = {}) {
  if (flag && String(flag).trim()) return String(flag).trim();
  const env = process.env.LOOPWRIGHT_OPERATOR;
  if (env && env.trim()) return env.trim();
  try {
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd: projectDir || defaultProjectDir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    /* fail-soft */
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// State shape — flat, schema 3 (§8/WP1, pinned).
// ---------------------------------------------------------------------------

/** A brand-new pre-shift state, seeded at `now` (epoch seconds). shift_id is null
 * until --init/--start-shift/session-boot opens one (R22 keeps that window tiny). */
export function freshState(now = nowSec(), config = DEFAULT_CONFIG) {
  const shift = (config && config.shift) || DEFAULT_CONFIG.shift;
  return {
    schema: 3,
    run_id: mintRunId(now),
    shift_id: null,
    shift_seq: 0,
    operator: null,
    mode: 'interactive',
    iteration: 0,
    started_at: now,
    heartbeat_at: now,
    active_seconds: 0,
    lease_session: null, // §4.2 — never rehydrated; a fresh boot claims it
    lease_renewed_at: 0,
    winddown_posted: false,
    gate_blocks: 0,
    gate_winddown_posted: false,
    shift_ended: false,
    budget: { ...shift }, // audit snapshot of the effective shift budget at start
    budget_override: null,
    run_totals: { shifts: 0, iterations: 0, active_seconds: 0 },
    milestone_gate: 'clear', // clear | pending-approval
    milestone_ticked_count: 0,
    approval_token: null, // token OBJECT (§4.4); legacy v2 strings tolerated on read
    last_commit_sha: null,
    verified_tree_sha: null,
    journal_dirty: false,
  };
}

/** In-memory migration of a v2 flat loop.json (no `schema` field) — §7.2c: the v2
 * run becomes shift s-001 of a freshly-minted v3 run; position (iteration, budget
 * spend, watermarks, approval token) is preserved, never reset. */
export function migrateV2State(v2, config = DEFAULT_CONFIG, now = nowSec()) {
  const fresh = freshState(now, config);
  const v2budget = v2.budget && typeof v2.budget === 'object' ? v2.budget : {};
  return {
    ...fresh,
    run_id: mintRunId(now),
    shift_id: shiftIdFromSeq(1),
    shift_seq: 1,
    operator: 'unknown',
    mode: 'interactive',
    iteration: Number.isFinite(v2.iteration) ? v2.iteration : 0,
    started_at: Number.isFinite(v2.started_at) ? v2.started_at : now,
    heartbeat_at: Number.isFinite(v2.heartbeat_at) ? v2.heartbeat_at : now,
    active_seconds: Number.isFinite(v2.active_seconds) ? v2.active_seconds : 0,
    winddown_posted: v2.winddown_posted === true,
    budget: {
      max_iterations: Number.isFinite(v2budget.max_iterations) ? v2budget.max_iterations : fresh.budget.max_iterations,
      max_wall_clock_sec: Number.isFinite(v2budget.max_wall_clock_sec) ? v2budget.max_wall_clock_sec : fresh.budget.max_wall_clock_sec,
      idle_gap_cap_sec: Number.isFinite(v2budget.idle_gap_cap_sec) ? v2budget.idle_gap_cap_sec : fresh.budget.idle_gap_cap_sec,
    },
    run_totals: {
      shifts: 1,
      iterations: Number.isFinite(v2.iteration) ? v2.iteration : 0,
      active_seconds: Number.isFinite(v2.active_seconds) ? v2.active_seconds : 0,
    },
    milestone_gate: v2.milestone_gate === 'pending-approval' ? 'pending-approval' : 'clear',
    milestone_ticked_count: Number.isFinite(v2.milestone_ticked_count) ? v2.milestone_ticked_count : 0,
    approval_token: v2.approval_token ?? null, // legacy string kept; readApprovalToken normalizes
    last_commit_sha: v2.last_commit_sha ?? null,
    verified_tree_sha: v2.verified_tree_sha ?? null,
  };
}

/** rehydrateFromLedger (§2.3, the full enumerated list — pinned by tests): overlay
 * ledger replay onto a fresh state. Restores: run_id (1), milestone watermark (2),
 * gate (3), unconsumed approval token incl. expiry (4), last_commit_sha (5),
 * verified_tree_sha with its later-commit invalidation (6), run_totals (7), the
 * open shift + its counters from that shift's iteration events (8). The lease (9)
 * is NEVER rehydrated — a fresh boot claims it per §4.2. */
export function rehydrateFromLedger(fresh, events, now = nowSec()) {
  const rep = replay(events);
  const st = { ...fresh };
  if (rep.run_id) st.run_id = rep.run_id;
  st.milestone_ticked_count = rep.milestone_ticked_count;
  st.milestone_gate = rep.gate;
  st.approval_token = rep.approval_token;
  st.last_commit_sha = rep.last_commit_sha;
  st.verified_tree_sha = rep.verified_tree_sha;
  st.run_totals = { ...rep.run_totals };
  if (rep.open_shift) {
    const os = rep.open_shift;
    st.shift_id = os.id;
    st.shift_seq = Number.isFinite(os.seq) ? os.seq : st.run_totals.shifts + 1;
    st.operator = os.operator ?? st.operator;
    st.mode = os.mode || 'interactive';
    st.iteration = os.iteration || 0;
    st.active_seconds = os.active_seconds || 0;
    st.winddown_posted = os.winddown_posted === true;
    st.gate_winddown_posted = os.gate_winddown_posted === true;
    st.shift_ended = false;
    // loop.json semantics count a shift at its START (§4.1.2); replay's run_totals
    // count only CLOSED shifts (§2.3.7) — reconcile by counting the open one here.
    st.run_totals.shifts += 1;
    const startedSec = os.started ? Math.floor(Date.parse(os.started) / 1000) : NaN;
    if (Number.isFinite(startedSec)) st.started_at = startedSec;
  } else if (events.length > 0) {
    st.shift_id = null;
    st.shift_seq = st.run_totals.shifts;
    st.shift_ended = st.run_totals.shifts > 0; // last shift closed cleanly — Stop allows until a new one starts
  }
  st.lease_session = null;
  st.lease_renewed_at = 0;
  st.heartbeat_at = now; // never backdate — the next accumulate must not inherit a phantom gap
  return st;
}

/** Read loop.json. Order (§8/WP1): parse OK ⇒ spread onto fresh (v2 flat files are
 * migrated in-memory first); missing/corrupt AND a readable ledger with events ⇒
 * rehydrateFromLedger; else fresh. Never throws. */
export function readState(loopPath, ledgerPath = null, config = DEFAULT_CONFIG, now = nowSec()) {
  let parsed = null;
  try {
    const raw = readFileSync(loopPath, 'utf8');
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') parsed = p;
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (!Number.isFinite(parsed.schema)) parsed = migrateV2State(parsed, config, now);
    return { ...freshState(now, config), ...parsed };
  }
  const fresh = freshState(now, config);
  if (ledgerPath) {
    try {
      const events = readLedger(ledgerPath);
      if (events.length > 0) return rehydrateFromLedger(fresh, events, now);
    } catch (e) {
      process.stderr.write(`loop-state: rehydrate failed, using fresh state: ${e.message}\n`);
    }
  }
  return fresh;
}

/** Atomic write: sibling `<file>.tmp-<pid>-<ts>` + rename (carried verbatim from
 * v2). No reader — or crash mid-write — can ever observe a half file (S2). */
export function atomicWriteFileSync(filePath, content) {
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

export function writeState(filePath, state) {
  atomicWriteFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Pure state transitions — none mutate their input (v2 carried).
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

/** Records an approval token. Does NOT by itself clear the milestone gate — the
 * Stop hook consumes it (clearApprovalAndGate) only while the gate is pending, so
 * a token can never pre-clear a future milestone (v2 pinned invariant, carried). */
export function setApprovalToken(state, token) {
  return { ...state, approval_token: token };
}

/** Consume the approval token: gate back to clear, token nulled, watermark
 * advanced to `tickedCount` so the same milestone doesn't re-trigger. */
export function clearApprovalAndGate(state, tickedCount) {
  return { ...state, milestone_gate: 'clear', approval_token: null, milestone_ticked_count: tickedCount, gate_blocks: 0, gate_winddown_posted: false };
}

export function elapsedWallClockSec(state, now = nowSec()) {
  return now - state.started_at;
}

/** v2 math carried VERBATIM (§5.3 — the one accumulation point): adds
 * min(max(0, now − heartbeat_at), idleGapCapSec) to active_seconds. Called once
 * per Stop BEFORE the caller advances heartbeat_at; a gap longer than the cap
 * (idle — waiting on a human) costs at most the cap, so idle time can no longer
 * silently burn the ceiling (the 209%-of-6h real-run bug). Known, accepted
 * limitation: one genuinely-busy turn longer than the cap is also capped — the
 * iteration ceiling is the hard runaway floor regardless. */
export function accumulateActiveSeconds(state, now = nowSec(), idleGapCapSec = DEFAULT_CONFIG.shift.idle_gap_cap_sec) {
  const gap = Math.max(0, now - state.heartbeat_at);
  const cap = Number.isFinite(idleGapCapSec) ? idleGapCapSec : DEFAULT_CONFIG.shift.idle_gap_cap_sec;
  const delta = Math.min(gap, cap);
  return { ...state, active_seconds: (state.active_seconds || 0) + delta };
}

/** Records the git tree sha verified at the last DoD/verify pass (staged tree —
 * `git write-tree` — NOT HEAD^{tree}; see --set-verified-tree below).
 * journal-integrity compares it against the committed tree (stale-partial-commit
 * guard, S3). */
export function setVerifiedTreeSha(state, sha) {
  return { ...state, verified_tree_sha: sha };
}

// ---------------------------------------------------------------------------
// Approval tokens — objects with operator + expiry (§4.4, O1).
// ---------------------------------------------------------------------------

/** v2 token-VALUE minting carried: self ⇒ `self:<rationale-or-ISO>`; else the
 * explicit token or `approved-<epoch>`. */
export function resolveApprovalToken({ self = false, rationale = '', explicitToken = '' } = {}, now = nowSec()) {
  if (self) {
    const why = rationale && String(rationale).trim() ? String(rationale).trim() : new Date(now * 1000).toISOString();
    return `self:${why}`;
  }
  return explicitToken && String(explicitToken).trim() ? String(explicitToken).trim() : `approved-${now}`;
}

/** Build the v3 token OBJECT: {value, class, operator, granted_at, expires_at}.
 * TTL from milestone.approval_ttl_hours (default 72 h); ttlHours ≤ 0 ⇒ no expiry. */
export function makeApprovalToken({ self = false, rationale = '', explicitToken = '', operator = 'unknown', ttlHours = DEFAULT_CONFIG.milestone.approval_ttl_hours } = {}, now = nowSec()) {
  const value = resolveApprovalToken({ self, rationale, explicitToken }, now);
  return {
    value,
    class: self ? 'self' : 'human',
    operator: operator && String(operator).trim() ? String(operator).trim() : 'unknown',
    granted_at: isoFromSec(now),
    expires_at: Number.isFinite(ttlHours) && ttlHours > 0 ? isoFromSec(now + Math.round(ttlHours * 3600)) : null,
  };
}

/** Normalize any stored token. Legacy v2 STRING tokens read as
 * {class:"human", operator:"unknown", no expiry} (§4.4, pinned upgrade compat). */
export function readApprovalToken(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { value: raw, class: 'human', operator: 'unknown', granted_at: null, expires_at: null };
  }
  if (typeof raw === 'object') {
    return {
      value: raw.value ?? null,
      class: raw.class === 'self' ? 'self' : 'human',
      operator: raw.operator || 'unknown',
      granted_at: raw.granted_at ?? null,
      expires_at: raw.expires_at ?? null,
    };
  }
  return null;
}

/** Expired ⇔ the token carries an expires_at and `now` is at/past it. Tokens
 * without expiry (legacy strings) never expire. */
export function isTokenExpired(raw, now = nowSec()) {
  const tok = readApprovalToken(raw);
  if (!tok || !tok.expires_at) return false;
  const t = Date.parse(tok.expires_at);
  return Number.isFinite(t) && now * 1000 >= t;
}

// ---------------------------------------------------------------------------
// STATE.md ## Milestones checklist parsing (v2 carried verbatim).
// ---------------------------------------------------------------------------

/** Count `- [x]` boxes inside the `## Milestones` section (stops at the next `## `
 * heading or EOF). Fail-safe: no section / empty / missing ⇒ 0. */
export function countTickedMilestones(stateMdText) {
  if (!stateMdText) return 0;
  const lines = String(stateMdText).split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+Milestones\s*$/.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line.trim())) break;
    if (inSection && /^-\s*\[[xX]\]/.test(line.trim())) count++;
  }
  return count;
}

/** FINDINGS.md open blocker/high extractor (same positional regex as
 * precompact-anchor.mjs — FINDINGS' 7-column schema is frozen). Local copy so this
 * CLI stays importable without pulling a hook file. */
export function extractOpenBlockerHighIds(findingsMdText) {
  if (!findingsMdText) return [];
  const ids = [];
  for (const line of String(findingsMdText).split('\n')) {
    const m = line.match(/^\|\s*(F\d+)\s*\|\s*(\w+)\s*\|[^|]*\|\s*(\w[\w-]*)\s*\|/);
    if (!m) continue;
    const [, id, sev, status] = m;
    if (/^(blocker|high)$/i.test(sev) && !/^(verified|closed|accepted)$/i.test(status)) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// HANDOFF.md stamp grammar (§4.3, pinned) + the anti-clobber guard + the
// mechanical skeleton. session-end.mjs (WP3) imports these three.
// ---------------------------------------------------------------------------

export const HANDOFF_KINDS = Object.freeze(['authored', 'auto-checkpoint', 'crash-backfill']);

/** Parse the header + stamp line. Returns
 * {shift, written, operator, kind, shift_open} or null when neither is present
 * (e.g. the shipped empty-by-design placeholder). */
export function parseHandoffStamp(text) {
  if (!text) return null;
  const lines = String(text).split('\n');
  let shift = null;
  const m1 = lines[0] && lines[0].match(/^#\s*HANDOFF\s*—\s*shift\s+(s-\d+)\s*$/);
  if (m1) shift = m1[1];
  for (const line of lines.slice(0, 6)) {
    const m = line.match(
      /^_Written:\s*(\S+)\s*·\s*operator:\s*(.*?)\s*·\s*kind:\s*(authored|auto-checkpoint|crash-backfill)\s*·\s*shift-open:\s*(yes|no)_\s*$/,
    );
    if (m) return { shift, written: m[1], operator: m[2], kind: m[3], shift_open: m[4] === 'yes' };
  }
  return shift ? { shift, written: null, operator: null, kind: null, shift_open: null } : null;
}

/** The anti-clobber guard (§4.3, pinned): a MECHANICAL writer may overwrite only
 * when (stamped shift ≠ its shift) OR (same shift AND stamped kind ≠ authored).
 * Authored always wins for its own shift. Unstamped/absent files are writable. */
export function canOverwriteHandoff(existingText, shiftId) {
  const stamp = parseHandoffStamp(existingText);
  if (!stamp || !stamp.kind) return true;
  return stamp.shift !== shiftId || stamp.kind !== 'authored';
}

function runCeilingsText(runCfg) {
  const parts = [];
  if (runCfg.max_shifts > 0) parts.push(`${runCfg.max_shifts} shifts`);
  if (runCfg.max_iterations > 0) parts.push(`${runCfg.max_iterations} iterations`);
  if (runCfg.max_active_seconds > 0) parts.push(`${runCfg.max_active_seconds}s active`);
  return parts.length ? `max ${parts.join(' · ')}` : 'unlimited';
}

/** The mechanical HANDOFF skeleton (§4.3 shape, exact stamp grammar). Used by the
 * crash-backfill path here and by session-end.mjs's auto-checkpoint (WP3). All
 * inputs are plain data so it stays pure and testable. */
export function buildHandoffSkeleton({
  shiftId,
  runId,
  operator,
  kind, // 'auto-checkpoint' | 'crash-backfill'
  shiftOpen, // boolean
  startedIso,
  endedIso,
  endReason, // e.g. 'crash' | 'auto_stale' | '(none — shift open)'
  shipped = [], // commit shas recorded this shift (ledger slice_committed)
  active = null, // active TASKS.md row or null
  uncommitted = 'clean', // 'clean' or git status --porcelain text
  findings = [], // open blocker/high F# ids
  shiftBudgetLine, // '38/40 iterations · 21410/21600 s active'
  runBudgetLine, // '7 shifts · 214 iterations · 96300 s active (run ceilings: unlimited)'
  nowIso,
}) {
  const shippedLines = shipped.length
    ? shipped.map((sha) => `- ${sha} (recorded in ledger — see git log for the subject)`)
    : ['- (no commits recorded this shift)'];
  const taskLine = active
    ? `**Task:** ${active.id} (${active.status}) — next: ${active.next_step || '(next-step cell empty)'}`
    : '**Task:** (none active)';
  const uncommittedBlock = !uncommitted || uncommitted === 'clean'
    ? '**Uncommitted:** clean'
    : ['**Uncommitted:**', ...uncommitted.split('\n').slice(0, 20).map((l) => `- ${l.trim()}`)].join('\n');
  const findingsLines = findings.length ? findings.map((f) => `- ${f} — open (see FINDINGS.md)`) : ['- (none)'];
  return [
    `# HANDOFF — shift ${shiftId}`,
    `_Written: ${nowIso} · operator: ${operator} · kind: ${kind} · shift-open: ${shiftOpen ? 'yes' : 'no'}_`,
    `**Run:** ${runId} · **Shift:** ${shiftId} (${startedIso} → ${endedIso}) · **End reason:** ${endReason}`,
    '',
    '## What shipped',
    ...shippedLines,
    '## In flight — exact next step',
    taskLine,
    uncommittedBlock,
    '## Open findings (blocker/high)',
    ...findingsLines,
    '## Budget',
    `- Shift: ${shiftBudgetLine}`,
    `- Run: ${runBudgetLine}`,
    '## Warnings / gotchas',
    `- Mechanical ${kind} handoff — verify against \`git log\` and FINDINGS.md before trusting it.`,
    '## Next-shift orders',
    '1. Read the In-flight task and resume from its next-step cell. 2. Run `node .claude/hooks/loop-state.mjs --doctor` before new work.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Path resolution — env overrides first (the test seam), then the skeleton
// layout (.claude/hooks/loop-state.mjs ⇒ .claude/).
// ---------------------------------------------------------------------------

function here() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function claudeDir() {
  return path.dirname(here());
}

function defaultProjectDir() {
  return process.env.LOOPWRIGHT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function resolvePaths() {
  const cd = claudeDir();
  return {
    claudeDir: cd,
    loopJson: process.env.LOOPWRIGHT_LOOP_JSON || path.join(cd, 'loop.json'),
    config: process.env.LOOPWRIGHT_LOOP_CONFIG || path.join(here(), 'loop-config.json'),
    stateMd: process.env.LOOPWRIGHT_STATE_MD || path.join(cd, 'STATE.md'),
    tasksMd: process.env.LOOPWRIGHT_TASKS_MD || path.join(cd, 'TASKS.md'),
    handoffMd: process.env.LOOPWRIGHT_HANDOFF_MD || path.join(cd, 'HANDOFF.md'),
    findingsMd: process.env.LOOPWRIGHT_FINDINGS_MD || path.join(cd, 'FINDINGS.md'),
    ledger: process.env.LOOPWRIGHT_LEDGER || path.join(cd, 'ledger', 'events.jsonl'),
    runtimeDir: process.env.LOOPWRIGHT_RUNTIME_DIR || path.join(cd, '.runtime'),
    projectDir: defaultProjectDir(),
  };
}

function sessionId() {
  return process.env.LOOPWRIGHT_SESSION_ID || 'cli';
}

function envelope(state, verb) {
  return { run: state.run_id, shift: state.shift_id, session: sessionId(), actor: `cli:${verb}` };
}

// The scan root for orphan-temp work: the directory loop.json lives in — in a real
// harness that IS .claude/; under env overrides (tests) it's the sandbox dir.
function scanRoot(paths) {
  return path.dirname(paths.loopJson);
}

// ---------------------------------------------------------------------------
// CLI internals
// ---------------------------------------------------------------------------

function readFileSoft(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function dateStr(now = nowSec()) {
  return isoFromSec(now).slice(0, 10);
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : '';
}

function numFlag(args, name) {
  const v = getFlag(args, name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Which run ceiling (if any) is exhausted for `totals`? Returns a description or null. */
function runExhausted(runCfg, totals) {
  if (runCfg.max_shifts > 0 && totals.shifts >= runCfg.max_shifts) return `${totals.shifts}/${runCfg.max_shifts} shifts`;
  if (runCfg.max_iterations > 0 && totals.iterations >= runCfg.max_iterations) return `${totals.iterations}/${runCfg.max_iterations} iterations`;
  if (runCfg.max_active_seconds > 0 && totals.active_seconds >= runCfg.max_active_seconds) return `${totals.active_seconds}s/${runCfg.max_active_seconds}s active`;
  return null;
}

/** Ensure the ledger has a genesis run_started (defensive: migrated harnesses
 * or a hand-deleted ledger must not leave events unattributable to a run). */
function ensureRunStarted(state, paths, verb) {
  const events = readLedger(paths.ledger);
  if (events.some((e) => e.event === 'run_started' || e.event === 'ledger_rotated')) return events;
  let goalHash = null;
  const goal = readFileSoft(path.join(paths.claudeDir, 'GOAL.md'));
  if (goal !== null) goalHash = createHash('sha256').update(goal).digest('hex').slice(0, 16);
  appendEvent(paths.ledger, { run: state.run_id, shift: null, session: sessionId(), actor: `cli:${verb}` }, 'run_started', { goal_hash: goalHash });
  return readLedger(paths.ledger);
}

/** Open a new shift: shift_started event FIRST, then the returned state carries the
 * reset per-shift fields. Watermarks/approvals are never touched (§4.1.2). */
function openShift(state, config, paths, now, { operator, mode, implicit, budgetOverride, verb }) {
  const seq = (state.run_totals && Number.isFinite(state.run_totals.shifts) ? state.run_totals.shifts : 0) + 1;
  const shiftId = shiftIdFromSeq(seq);
  // shift.* overrides are per-shift and reset here; run.* extensions granted via
  // --extend-budget persist across shift starts (or the refusal→extend→restart
  // flow of §4.1.4 could never converge).
  const carriedOverride = {};
  for (const [k, v] of Object.entries(state.budget_override || {})) {
    if (!k.startsWith('shift.')) carriedOverride[k] = v;
  }
  const mergedOverride = { ...carriedOverride, ...(budgetOverride || {}) };
  const finalOverride = Object.keys(mergedOverride).length ? mergedOverride : null;
  const effShift = effectiveBudget(config, { budget_override: finalOverride }).shift;
  appendEvent(
    paths.ledger,
    { run: state.run_id, shift: shiftId, session: sessionId(), actor: `cli:${verb}` },
    'shift_started',
    { seq, operator, mode, budget: effShift, implicit: implicit === true },
  );
  return {
    ...state,
    shift_id: shiftId,
    shift_seq: seq,
    operator,
    mode,
    iteration: 0,
    started_at: now,
    heartbeat_at: now,
    active_seconds: 0,
    winddown_posted: false,
    gate_blocks: 0,
    gate_winddown_posted: false,
    shift_ended: false,
    budget: { ...effShift },
    budget_override: finalOverride,
    run_totals: { ...state.run_totals, shifts: seq },
  };
}

/** Rotation check — shift end is the only safe single-session moment (§2.2). */
function maybeRotate(state, config, paths) {
  try {
    const eff = effectiveBudget(config, state);
    const events = readLedger(paths.ledger);
    const rep = replay(events);
    const carried = {
      run_id: rep.run_id || state.run_id,
      run_totals: rep.run_totals,
      milestone_ticked_count: rep.milestone_ticked_count,
      last_commit_sha: rep.last_commit_sha,
      shift_history: rep.shift_history.slice(-50),
    };
    const res = rotate(paths.ledger, carried, eff.ledger.rotate_lines, {
      run: state.run_id,
      shift: null,
      session: sessionId(),
      actor: 'cli:end-shift',
    });
    if (res) process.stdout.write(`ledger rotated → ${res.archived}\n`);
  } catch (e) {
    process.stderr.write(`loop-state: ledger rotation skipped: ${e.message}\n`);
  }
}

/** Write the crash-backfill HANDOFF skeleton — event BEFORE write, stamp-guarded
 * (§4.1.5, §4.3). Fail-soft: a handoff problem must not abort the shift close. */
function writeBackfillHandoff(state, config, paths, now, { kind, endReason, shiftOpen, verb }) {
  try {
    const existing = readFileSoft(paths.handoffMd);
    if (existing !== null && !canOverwriteHandoff(existing, state.shift_id)) {
      process.stderr.write(`loop-state: HANDOFF.md for ${state.shift_id} is authored — ${kind} write skipped (stamp guard)\n`);
      return false;
    }
    const rep = replay(readLedger(paths.ledger));
    const shipped = rep.open_shift && rep.open_shift.id === state.shift_id ? rep.open_shift.commit_shas : [];
    const board = parseBoard(readFileSoft(paths.tasksMd) || '');
    const active = board.error ? null : activeRow(board.rows);
    const findings = extractOpenBlockerHighIds(readFileSoft(paths.findingsMd) || '');
    let uncommitted = 'clean';
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: paths.projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) uncommitted = out;
    } catch {
      uncommitted = '(git status unavailable)';
    }
    const eff = effectiveBudget(config, state);
    const text = buildHandoffSkeleton({
      shiftId: state.shift_id,
      runId: state.run_id,
      operator: state.operator || 'unknown',
      kind,
      shiftOpen,
      startedIso: isoFromSec(state.started_at),
      endedIso: isoFromSec(now),
      endReason,
      shipped,
      active,
      uncommitted,
      findings,
      shiftBudgetLine: `${state.iteration}/${eff.shift.max_iterations} iterations · ${state.active_seconds}/${eff.shift.max_wall_clock_sec} s active`,
      runBudgetLine: `${state.run_totals.shifts} shifts · ${state.run_totals.iterations + state.iteration} iterations · ${state.run_totals.active_seconds + state.active_seconds} s active (run ceilings: ${runCeilingsText(eff.run)})`,
      nowIso: isoFromSec(now),
    });
    appendEvent(paths.ledger, envelope(state, verb), 'handoff_written', { shift: state.shift_id, kind });
    atomicWriteFileSync(paths.handoffMd, text);
    return true;
  } catch (e) {
    process.stderr.write(`loop-state: ${kind} handoff skipped: ${e.message}\n`);
    return false;
  }
}

const END_REASONS = ['budget_iterations', 'budget_time', 'run_budget', 'milestone_gate', 'manual', 'crash', 'auto_stale'];

/** Close the current shift: shift_ended event first, totals folded into
 * run_totals, lease cleared, then rotation check. Returns the closed state
 * (caller writes loop.json). */
function closeShift(state, config, paths, now, reason, { verb, crashBackfill = false, accumulate = false }) {
  let st = state;
  if (accumulate) {
    const eff = effectiveBudget(config, st);
    st = updateHeartbeat(accumulateActiveSeconds(st, now, eff.shift.idle_gap_cap_sec), now);
  }
  const rep = replay(readLedger(paths.ledger));
  const commits = rep.open_shift && rep.open_shift.id === st.shift_id ? rep.open_shift.commits : 0;
  if (crashBackfill) {
    writeBackfillHandoff(st, config, paths, now, { kind: 'crash-backfill', endReason: reason, shiftOpen: false, verb });
  }
  appendEvent(paths.ledger, envelope(st, verb), 'shift_ended', {
    reason,
    iterations: st.iteration || 0,
    active_seconds: st.active_seconds || 0,
    commits,
  });
  const closed = {
    ...st,
    shift_ended: true,
    lease_session: null,
    lease_renewed_at: 0,
    run_totals: {
      ...st.run_totals,
      iterations: (st.run_totals.iterations || 0) + (st.iteration || 0),
      active_seconds: (st.run_totals.active_seconds || 0) + (st.active_seconds || 0),
    },
  };
  maybeRotate(closed, config, paths);
  return closed;
}

/** Session-pointer active_task update — best-effort, never guessed (§8/WP1):
 * without LOOPWRIGHT_SESSION_ID the board + ledger stay authoritative and the
 * pointer is skipped with a greppable note. */
function updateSessionPointer(paths, taskId, to, now) {
  const sid = process.env.LOOPWRIGHT_SESSION_ID;
  if (!sid) {
    process.stderr.write('loop-state: session pointer not updated (LOOPWRIGHT_SESSION_ID unset) — board and ledger remain authoritative\n');
    return;
  }
  try {
    const p = path.join(paths.runtimeDir, 'sessions', `${sid}.json`);
    let ptr = {};
    const raw = readFileSoft(p);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') ptr = parsed;
      } catch {
        /* rewrite corrupt pointer */
      }
    }
    ptr.session_id = ptr.session_id || sid;
    if (['planning', ...ACTIVE_STATUSES].includes(to)) ptr.active_task = taskId;
    else if (ptr.active_task === taskId) ptr.active_task = null;
    ptr.last_seen_at = now;
    atomicWriteFileSync(p, JSON.stringify(ptr, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`loop-state: session pointer not updated: ${e.message}\n`);
  }
}

function listOrphanTmp(root) {
  const orphans = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        walk(p);
      } else if (/\.tmp-\d+-\d+$/.test(ent.name)) {
        orphans.push(p);
      }
    }
  };
  walk(root);
  return orphans;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function cmdInit(args, paths, config, now) {
  if (existsSync(paths.loopJson)) {
    process.stdout.write(`loop.json already exists at ${paths.loopJson} — not overwriting.\n`);
    process.exit(0);
  }
  const operator = resolveOperator({ flag: getFlag(args, '--operator'), projectDir: paths.projectDir });
  let state = freshState(now, config);
  let goalHash = null;
  const goal = readFileSoft(path.join(paths.claudeDir, 'GOAL.md'));
  if (goal !== null) goalHash = createHash('sha256').update(goal).digest('hex').slice(0, 16);
  appendEvent(paths.ledger, { run: state.run_id, shift: null, session: sessionId(), actor: 'cli:init' }, 'run_started', { goal_hash: goalHash });
  state = openShift(state, config, paths, now, { operator, mode: 'interactive', implicit: false, budgetOverride: null, verb: 'init' });
  writeState(paths.loopJson, state);
  process.stdout.write(`run ${state.run_id} started · shift ${state.shift_id} opened (operator ${operator}) · loop.json initialized at ${paths.loopJson}\n`);
  process.exit(0);
}

function cmdStartShift(args, paths, config, now) {
  let state = readState(paths.loopJson, paths.ledger, config, now);
  ensureRunStarted(state, paths, 'start-shift');
  const operator = resolveOperator({ flag: getFlag(args, '--operator'), projectDir: paths.projectDir });
  const mode = getFlag(args, '--mode') || 'interactive';
  const budgetIters = numFlag(args, '--budget-iters');
  const budgetSec = numFlag(args, '--budget-sec');
  const override = {};
  if (budgetIters !== undefined) override['shift.max_iterations'] = budgetIters;
  if (budgetSec !== undefined) override['shift.max_wall_clock_sec'] = budgetSec;
  const budgetOverride = Object.keys(override).length ? override : null;

  // Run-headroom refusal (§4.1.4) — prospective totals include the open shift's counters.
  const eff = effectiveBudget(config, state);
  const openLive = state.shift_id && !state.shift_ended;
  const totals = {
    shifts: state.run_totals.shifts || 0,
    iterations: (state.run_totals.iterations || 0) + (openLive ? state.iteration || 0 : 0),
    active_seconds: (state.run_totals.active_seconds || 0) + (openLive ? state.active_seconds || 0 : 0),
  };
  const exhausted = runExhausted(eff.run, totals);
  if (exhausted) {
    process.stderr.write(
      `loop-state: run budget exhausted (${exhausted}) — refusing to start a new shift. ` +
        'A human must extend it: node .claude/hooks/loop-state.mjs --extend-budget run.<key>=<value> (or --complete-run)\n',
    );
    process.exit(1);
  }

  // Open shift found at explicit shift start (§4.1.5): close it first.
  if (openLive) {
    const staleSec = eff.session.lease_stale_sec;
    const leaseHeld = !!state.lease_session;
    const leaseAge = now - (state.lease_renewed_at || 0);
    if (leaseHeld && leaseAge < staleSec) {
      process.stderr.write(
        `loop-state: shift ${state.shift_id} is live — session ${state.lease_session} holds the lease (age ${leaseAge}s < ${staleSec}s). ` +
          'Not closing a running shift; /handoff in that session, or wait for the lease to go stale.\n',
      );
      process.exit(1);
    }
    const reason = leaseHeld ? 'crash' : 'auto_stale';
    state = closeShift(state, config, paths, now, reason, { verb: 'start-shift', crashBackfill: true });
    process.stdout.write(`open shift ${state.shift_id} closed (${reason}): ${state.iteration} iterations, ${state.active_seconds}s active\n`);
  }

  state = openShift(state, config, paths, now, { operator, mode, implicit: false, budgetOverride, verb: 'start-shift' });
  writeState(paths.loopJson, state);
  const ovText = budgetOverride ? ` · budget override ${JSON.stringify(budgetOverride)}` : '';
  process.stdout.write(`shift ${state.shift_id} started (operator ${operator}, mode ${mode})${ovText}\n`);
  process.exit(0);
}

function cmdEndShift(args, paths, config, now) {
  let state = readState(paths.loopJson, paths.ledger, config, now);
  if (!state.shift_id || state.shift_ended) {
    process.stderr.write('loop-state: no open shift to end\n');
    process.exit(1);
  }
  const reason = getFlag(args, '--reason') || 'manual';
  if (!END_REASONS.includes(reason)) {
    process.stderr.write(`loop-state: unknown end reason "${reason}" (expected: ${END_REASONS.join(' | ')})\n`);
    process.exit(1);
  }
  state = closeShift(state, config, paths, now, reason, { verb: 'end-shift', crashBackfill: false, accumulate: true });
  writeState(paths.loopJson, state);
  process.stdout.write(
    `shift ${state.shift_id} ended (${reason}): ${state.iteration} iterations, ${state.active_seconds}s active. ` +
      'Re-arm = a new shift (--start-shift or the next session-boot).\n',
  );
  process.exit(0);
}

function cmdExtendBudget(args, paths, config, now) {
  const idx = args.indexOf('--extend-budget');
  const spec = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
  const m = /^(shift|run)\.([a-z_]+)=(-?\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (!m) {
    process.stderr.write('loop-state: usage: --extend-budget <shift|run>.<key>=<number>  (e.g. shift.max_iterations=60)\n');
    process.exit(1);
  }
  const [, scope, key, valueRaw] = m;
  const value = Number(valueRaw);
  if (!(key in DEFAULT_CONFIG[scope])) {
    process.stderr.write(`loop-state: unknown budget key ${scope}.${key} (known: ${Object.keys(DEFAULT_CONFIG[scope]).join(', ')})\n`);
    process.exit(1);
  }
  let state = readState(paths.loopJson, paths.ledger, config, now);
  const operator = resolveOperator({ flag: getFlag(args, '--operator'), projectDir: paths.projectDir });
  const from = effectiveBudget(config, state)[scope][key];
  appendEvent(paths.ledger, envelope(state, 'extend-budget'), 'budget_extended', { scope, key, from, to: value, operator });
  state = { ...state, budget_override: { ...(state.budget_override || {}), [`${scope}.${key}`]: value } };
  writeState(paths.loopJson, state);
  process.stdout.write(`budget extended: ${scope}.${key} ${from} → ${value} (operator ${operator}) — applies at the next Stop\n`);
  process.exit(0);
}

function cmdApprove(args, paths, config, now) {
  const idx = args.indexOf('--approve');
  const selfIdx = args.indexOf('--self');
  const isSelf = selfIdx !== -1;
  const rationale = isSelf && args[selfIdx + 1] && !args[selfIdx + 1].startsWith('--') ? args[selfIdx + 1] : '';
  const explicitToken = !isSelf && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
  let state = readState(paths.loopJson, paths.ledger, config, now);
  const operator = resolveOperator({ flag: getFlag(args, '--operator'), projectDir: paths.projectDir });
  const ttl = effectiveBudget(config, state).milestone.approval_ttl_hours;
  const token = makeApprovalToken({ self: isSelf, rationale, explicitToken, operator, ttlHours: ttl }, now);
  appendEvent(paths.ledger, envelope(state, 'approve'), 'approval_granted', {
    kind: token.class,
    operator: token.operator,
    token: token.value,
    granted_at: token.granted_at,
    expires_at: token.expires_at,
  });
  writeState(paths.loopJson, setApprovalToken(state, token));
  process.stdout.write(
    `Approval token set (${token.value} · ${token.class} · operator ${token.operator} · expires ${token.expires_at || 'never'}). ` +
      'It will be consumed on the next Stop check while the gate is pending — it never pre-clears a future gate.\n',
  );
  process.exit(0);
}

// SP7/F6 semantics carried from v2 verbatim: default sha is `git write-tree` (the
// STAGED tree — callers `git add -A` first), NOT HEAD^{tree}: at verify time HEAD
// is still the previous commit, so HEAD^{tree} would mismatch on every slice.
function cmdSetVerifiedTree(args, paths, config, now) {
  const idx = args.indexOf('--set-verified-tree');
  let sha = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
  if (!sha) {
    try {
      sha = execFileSync('git', ['write-tree'], { cwd: paths.projectDir, encoding: 'utf8' }).trim();
    } catch (e) {
      process.stderr.write(`loop-state: could not resolve write-tree: ${e.message}\n`);
      process.exit(1);
      return;
    }
  }
  const task = getFlag(args, '--task') || null;
  const tier = getFlag(args, '--tier') || null;
  let state = readState(paths.loopJson, paths.ledger, config, now);
  appendEvent(paths.ledger, envelope(state, 'set-verified-tree'), 'slice_verified', { task, tier, tree_sha: sha });
  writeState(paths.loopJson, setVerifiedTreeSha(state, sha));
  process.stdout.write(`verified_tree_sha set (${sha}).\n`);
  process.exit(0);
}

function cmdTask(args, paths, config, now) {
  const taskArg = getFlag(args, '--task');
  const state = readState(paths.loopJson, paths.ledger, config, now);

  if (taskArg === 'new') {
    const title = getFlag(args, '--title');
    if (!title) {
      process.stderr.write('loop-state: usage: --task new --title "…" [--milestone M#] [--next "…"]\n');
      process.exit(1);
    }
    const milestone = getFlag(args, '--milestone') || '—';
    const next = getFlag(args, '--next') || 'plan the slice';
    const raw = readFileSoft(paths.tasksMd);
    let board = raw === null ? emptyBoard() : parseBoard(raw);
    if (board.error && raw !== null) {
      process.stderr.write(`loop-state: TASKS.md did not parse cleanly (${board.error}) — refusing to rewrite it; fix the table first\n`);
      process.exit(1);
    }
    const id = nextTaskId(board);
    appendEvent(paths.ledger, envelope(state, 'task'), 'task_created', { task: id, title, milestone });
    board = upsertRow(board, { id, milestone, title, status: 'queued', next_step: next, owner: '—', updated: dateStr(now) });
    atomicWriteFileSync(paths.tasksMd, serializeBoard(board));
    process.stdout.write(`${id} created (queued): ${title}\n`);
    process.exit(0);
  }

  const id = taskArg;
  const to = getFlag(args, '--to');
  const next = getFlag(args, '--next');
  if (!id || !to) {
    process.stderr.write('loop-state: usage: --task <T#> --to <status> [--next "…"] | --task new --title "…" --milestone M#\n');
    process.exit(1);
  }
  if (!STATUSES.includes(to)) {
    process.stderr.write(`loop-state: unknown status "${to}" (statuses: ${STATUSES.join(' ')})\n`);
    process.exit(1);
  }
  const raw = readFileSoft(paths.tasksMd);
  const board = raw === null ? null : parseBoard(raw);
  if (!board || board.error) {
    process.stderr.write(`loop-state: TASKS.md ${board ? `did not parse cleanly (${board.error})` : 'not found'} — refusing to rewrite it\n`);
    process.exit(1);
  }
  const row = board.rows.find((r) => r.id === id);
  if (!row) {
    process.stderr.write(`loop-state: no live board row ${id} (archived rows are terminal)\n`);
    process.exit(1);
  }
  if (!canTransition(row.status, to)) {
    process.stderr.write(`loop-state: illegal transition ${id}: ${row.status} → ${to} (legal from ${row.status}: ${(TRANSITIONS[row.status] || []).join(', ') || '(none — terminal)'})\n`);
    process.exit(1);
  }
  // Event BEFORE board write (§2.2 invariant) — a crash between the two is
  // completed forward by --doctor --repair.
  appendEvent(paths.ledger, envelope(state, 'task'), 'task_status', {
    task: id,
    from: row.status,
    to,
    next_step: next !== undefined && next !== '' ? next : row.next_step,
  });
  const updatedRow = { ...row, status: to, updated: dateStr(now) };
  if (next !== undefined && next !== '') updatedRow.next_step = next;
  atomicWriteFileSync(paths.tasksMd, serializeBoard(upsertRow(board, updatedRow)));
  updateSessionPointer(paths, id, to, now);
  process.stdout.write(`${id}: ${row.status} → ${to}${next ? ` · next: ${next}` : ''}\n`);
  process.exit(0);
}

function cmdRecordHandoff(args, paths, config, now) {
  const kind = getFlag(args, '--kind') || 'authored';
  if (!['authored', 'auto-checkpoint'].includes(kind)) {
    process.stderr.write('loop-state: --record-handoff --kind must be authored or auto-checkpoint (crash-backfill is written only by --start-shift)\n');
    process.exit(1);
  }
  const state = readState(paths.loopJson, paths.ledger, config, now);
  if (kind === 'authored') {
    if (!existsSync(paths.handoffMd)) {
      process.stderr.write(`loop-state: ${paths.handoffMd} not found — author the handoff first (template inside .claude/HANDOFF.md)\n`);
      process.exit(1);
    }
    appendEvent(paths.ledger, envelope(state, 'record-handoff'), 'handoff_written', { shift: state.shift_id, kind: 'authored' });
    process.stdout.write(`handoff recorded (authored, shift ${state.shift_id}). Now run --end-shift --reason <r> to close the shift.\n`);
    process.exit(0);
  }
  // auto-checkpoint (/pause): mechanical skeleton, stamp-guarded, shift STAYS open.
  const wrote = writeBackfillHandoff(state, config, paths, now, {
    kind: 'auto-checkpoint',
    endReason: '(none — shift open)',
    shiftOpen: true,
    verb: 'record-handoff',
  });
  process.stdout.write(wrote ? `handoff checkpoint written (auto-checkpoint, shift ${state.shift_id} still open)\n` : 'handoff checkpoint skipped (stamp guard)\n');
  process.exit(0);
}

function doctorReport(paths, config, now, repair) {
  const lines = [];
  let issues = 0;
  const state = readState(paths.loopJson, paths.ledger, config, now);
  const eff = effectiveBudget(config, state);

  // 1. Orphan atomic-write temp files (S2 debris).
  const orphans = listOrphanTmp(scanRoot(paths));
  for (const p of orphans) {
    let ageSec = 0;
    try {
      ageSec = Math.floor((Date.now() - statSync(p).mtimeMs) / 1000);
    } catch {
      /* raced */
    }
    const old = ageSec > 3600;
    if (repair && old) {
      try {
        unlinkSync(p);
        lines.push(`doctor: removed orphan temp ${p} (age ${ageSec}s)`);
        continue;
      } catch {
        /* fall through to report */
      }
    }
    issues++;
    lines.push(`doctor: orphan temp file ${p} (age ${ageSec}s${old ? '' : ' — younger than 1h, left alone'})`);
  }

  // 2. Ledger health (torn tail / mid-file garbage).
  const unparseable = countUnparseableLines(paths.ledger);
  if (unparseable > 0) {
    issues++;
    lines.push(`doctor: ledger has ${unparseable} unparseable line(s) — reader skips them; at worst one iteration tick is lost (S1)`);
  }

  // 3. Board vs ledger (forward-only repair — R4/R25).
  const events = readLedger(paths.ledger);
  const rep = replay(events);
  const rawBoard = readFileSoft(paths.tasksMd);
  let board = rawBoard === null ? null : parseBoard(rawBoard);
  if (board && board.error) {
    issues++;
    lines.push(`doctor: TASKS.md did not parse cleanly (${board.error}) — rows unreadable are invisible to this check`);
  }
  if (board && !board.error) {
    let boardChanged = false;
    for (const [taskId, latest] of Object.entries(rep.task_latest)) {
      const live = board.rows.find((r) => r.id === taskId);
      const archived = board.archiveRows.find((r) => r.id === taskId);
      const row = live || archived;
      if (!row) {
        issues++;
        if (repair) {
          board = upsertRow(board, {
            id: taskId,
            milestone: latest.milestone || '—',
            title: latest.title || '(recovered from ledger)',
            status: latest.to || 'queued',
            next_step: latest.next_step || '',
            owner: '—',
            updated: dateStr(now),
          });
          boardChanged = true;
          lines.push(`doctor: repaired — ${taskId} evented in ledger but missing from board; row completed forward (${latest.to})`);
        } else {
          lines.push(`doctor: ${taskId} has ledger events but no board row (run --doctor --repair to complete it forward)`);
        }
        continue;
      }
      if (row.status === latest.to) continue;
      if (live && row.status === latest.from) {
        // Event landed, board write didn't (crash between the two) — forward-completable.
        issues++;
        if (repair) {
          const updatedRow = { ...row, status: latest.to, updated: dateStr(now) };
          if (latest.next_step) updatedRow.next_step = latest.next_step;
          board = upsertRow(board, updatedRow);
          boardChanged = true;
          lines.push(`doctor: repaired — ${taskId} completed forward ${latest.from} → ${latest.to} (evented but unwritten)`);
        } else {
          lines.push(`doctor: ${taskId} board says ${row.status} but ledger says ${latest.to} (evented-but-unwritten — --repair completes it forward)`);
        }
      } else {
        // Hand edit: markdown wins for intent — report, never revert (R25).
        issues++;
        lines.push(`doctor: ${taskId} board says ${row.status} but last ledger event says ${latest.to} — hand edit? reported only, never reverted`);
      }
    }
    if (repair && boardChanged) atomicWriteFileSync(paths.tasksMd, serializeBoard(board));
  }

  // 4. HEAD vs ledger's last slice_committed (S4 boot reconciliation, doctor view).
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: paths.projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (rep.last_commit_sha && head && rep.last_commit_sha !== head) {
      issues++;
      lines.push(`doctor: HEAD ${head.slice(0, 12)} ≠ ledger last slice_committed ${String(rep.last_commit_sha).slice(0, 12)} — commit(s) may have landed without ledger/journal records; reconcile TASKS/PROGRESS before new work`);
    }
  } catch {
    lines.push('doctor: git HEAD unavailable (not a repo yet?) — HEAD-vs-ledger check skipped');
  }

  // 5. Stale session pointers.
  try {
    const sessionsDir = path.join(paths.runtimeDir, 'sessions');
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(sessionsDir, name);
      let lastSeen = 0;
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        lastSeen = Number(parsed && parsed.last_seen_at) || 0;
      } catch {
        /* unreadable counts as stale */
      }
      if (now - lastSeen > eff.session.stale_after_sec) {
        if (repair) {
          try {
            unlinkSync(p);
            lines.push(`doctor: swept stale session file ${name}`);
            continue;
          } catch {
            /* report instead */
          }
        }
        lines.push(`doctor: stale session file ${name} (last_seen ${lastSeen || 'unknown'})`);
      }
    }
  } catch {
    /* no sessions dir yet — fine */
  }

  // 6. Lease state (informational).
  if (state.lease_session) {
    const age = now - (state.lease_renewed_at || 0);
    const stale = age >= eff.session.lease_stale_sec;
    lines.push(`doctor: lease held by session ${state.lease_session} (age ${age}s — ${stale ? 'STALE, next boot may take over' : 'fresh'})`);
  } else {
    lines.push('doctor: lease free');
  }

  // 7. Manifest drift (informational — write-manifest.mjs --verify is the full check).
  const manifestRaw = readFileSoft(path.join(paths.claudeDir, 'harness-manifest.json'));
  if (manifestRaw !== null) {
    try {
      const manifest = JSON.parse(manifestRaw);
      let drift = 0;
      for (const [rel, info] of Object.entries(manifest.files || {})) {
        if (!info || info.kind !== 'verbatim') continue;
        const content = readFileSoft(path.join(paths.claudeDir, rel));
        if (content === null) continue;
        if (createHash('sha256').update(content).digest('hex') !== info.sha256) drift++;
      }
      if (drift > 0) lines.push(`doctor: ${drift} mechanism file(s) differ from the recorded manifest hashes (info — see write-manifest.mjs --verify)`);
    } catch {
      lines.push('doctor: harness-manifest.json unreadable (info)');
    }
  }

  return { lines, issues };
}

function cmdDoctor(args, paths, config, now) {
  const repair = args.includes('--repair');
  const { lines, issues } = doctorReport(paths, config, now, repair);
  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write(issues === 0 ? 'doctor: ok\n' : `doctor: ${issues} issue(s) found${repair ? ' (repairs applied where forward-safe)' : ''}\n`);
  process.exit(0);
}

function cmdStatus(args, paths, config, now) {
  const state = readState(paths.loopJson, paths.ledger, config, now);
  const eff = effectiveBudget(config, state);
  const openLive = !!state.shift_id && !state.shift_ended;
  const totals = {
    shifts: state.run_totals.shifts || 0,
    iterations: (state.run_totals.iterations || 0) + (openLive ? state.iteration || 0 : 0),
    active_seconds: (state.run_totals.active_seconds || 0) + (openLive ? state.active_seconds || 0 : 0),
  };
  const exhausted = runExhausted(eff.run, totals);
  const rawBoard = readFileSoft(paths.tasksMd);
  const board = rawBoard === null ? null : parseBoard(rawBoard);
  const openTasks = board && !board.error ? board.rows.filter((r) => !['done', 'dropped'].includes(r.status)) : [];
  const active = board && !board.error ? activeRow(board.rows) : null;
  const handoffStamp = parseHandoffStamp(readFileSoft(paths.handoffMd) || '');
  const token = readApprovalToken(state.approval_token);
  const orphans = listOrphanTmp(scanRoot(paths));
  const unparseable = countUnparseableLines(paths.ledger);

  const json = {
    run: {
      id: state.run_id,
      totals,
      ceilings: { ...eff.run },
      headroom: !exhausted,
      exhausted: exhausted || null,
    },
    shift: {
      id: state.shift_id,
      seq: state.shift_seq,
      operator: state.operator,
      mode: state.mode,
      open: openLive,
      iteration: state.iteration,
      active_seconds: state.active_seconds,
      budget: { ...eff.shift },
      winddown_posted: state.winddown_posted === true,
      gate_winddown_posted: state.gate_winddown_posted === true,
    },
    gate: state.milestone_gate,
    approval_token: token
      ? { class: token.class, operator: token.operator, granted_at: token.granted_at, expires_at: token.expires_at, expired: isTokenExpired(token, now) }
      : null,
    tasks: {
      open: openTasks.length,
      active: active ? { id: active.id, status: active.status, next_step: active.next_step } : null,
      board_error: board ? board.error : 'TASKS.md not found',
    },
    handoff: handoffStamp && handoffStamp.kind
      ? { shift: handoffStamp.shift, kind: handoffStamp.kind, written: handoffStamp.written, thin: handoffStamp.kind !== 'authored' }
      : null,
    doctor: { orphan_tmp: orphans.length, ledger_unparseable: unparseable },
  };

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    process.exit(0);
  }

  const tokenText = token
    ? `${token.class} by ${token.operator}, expires ${token.expires_at || 'never'}${isTokenExpired(token, now) ? ' (EXPIRED)' : ''}`
    : 'none';
  process.stdout.write(
    [
      `run ${state.run_id} · ${totals.shifts} shifts · ${totals.iterations} iterations · ${totals.active_seconds}s active · ceilings: ${runCeilingsText(eff.run)} · headroom: ${exhausted ? `NO (${exhausted})` : 'yes'}`,
      openLive
        ? `shift ${state.shift_id} (${state.operator || 'unknown'}, ${state.mode}) · open · iter ${state.iteration}/${eff.shift.max_iterations} · ${state.active_seconds}/${eff.shift.max_wall_clock_sec}s active`
        : `shift: none open${state.shift_id ? ` (last: ${state.shift_id})` : ''} — session-boot or --start-shift opens one`,
      `gate: ${state.milestone_gate} · token: ${tokenText}`,
      `tasks: ${openTasks.length} open · active: ${active ? `${active.id} (${active.status}) — next: ${active.next_step}` : '(none)'}`,
      `handoff: ${json.handoff ? `${json.handoff.shift} · ${json.handoff.kind}${json.handoff.thin ? ' (thin — not authored)' : ''} · ${json.handoff.written}` : '(none yet)'}`,
      `doctor: ${orphans.length} orphan tmp · ${unparseable} unparseable ledger line(s)`,
    ].join('\n') + '\n',
  );
  process.exit(0);
}

function cmdShifts(paths, config, now) {
  const state = readState(paths.loopJson, paths.ledger, config, now);
  const rep = replay(readLedger(paths.ledger));
  const rows = [...rep.shift_history];
  if (rep.open_shift) {
    rows.push({
      shift: rep.open_shift.id,
      seq: rep.open_shift.seq,
      operator: rep.open_shift.operator,
      mode: rep.open_shift.mode,
      started: rep.open_shift.started,
      ended: null,
      iterations: rep.open_shift.iteration,
      active_seconds: rep.open_shift.active_seconds,
      reason: 'open',
      last_commit: rep.open_shift.last_commit,
    });
  }
  if (rows.length === 0) {
    process.stdout.write('no shifts recorded yet — run --init or --start-shift.\n');
    process.exit(0);
  }
  process.stdout.write('shift · operator · mode · started → ended · iterations · active_s · reason · last_commit\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.shift || '?'} · ${r.operator || '?'} · ${r.mode || '?'} · ${r.started || '?'} → ${r.ended || '—'} · ${r.iterations ?? 0} it · ${r.active_seconds ?? 0}s · ${r.reason || '?'} · ${r.last_commit ? String(r.last_commit).slice(0, 12) : '—'}\n`,
    );
  }
  const openLive = !!state.shift_id && !state.shift_ended;
  process.stdout.write(`run ${state.run_id}: ${rows.length} shift(s)${openLive ? ` · ${state.shift_id} open` : ''}\n`);
  process.exit(0);
}

function cmdLogRoutine(args, paths, config, now) {
  const idx = args.indexOf('--log-routine');
  const name = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
  if (!name) {
    process.stderr.write('loop-state: usage: --log-routine <name>\n');
    process.exit(1);
  }
  const state = readState(paths.loopJson, paths.ledger, config, now);
  appendEvent(paths.ledger, envelope(state, 'log-routine'), 'routine_run', { name });
  process.stdout.write(`routine "${name}" logged\n`);
  process.exit(0);
}

function cmdCompleteRun(paths, config, now) {
  const state = readState(paths.loopJson, paths.ledger, config, now);
  appendEvent(paths.ledger, envelope(state, 'complete-run'), 'run_completed', {});
  process.stdout.write(`run ${state.run_id} recorded complete — GOAL.md success criteria are the real terminus; congratulations.\n`);
  process.exit(0);
}

const USAGE = `Usage: node loop-state.mjs <verb>
  --init [--operator X]                          start the run (run_started + shift s-001)
  --start-shift [--operator X] [--mode M] [--budget-iters N] [--budget-sec S]
  --end-shift [--reason ${END_REASONS.join('|')}]
  --extend-budget <shift|run>.<key>=<value> [--operator X]
  --approve [token] [--self [rationale]] [--operator X]
  --set-verified-tree [sha] [--task T#] [--tier T0..T3]
  --task new --title "…" [--milestone M#] [--next "…"]
  --task <T#> --to <${STATUSES.join('|')}> [--next "…"]
  --record-handoff [--kind authored|auto-checkpoint]
  --status [--json]
  --shifts
  --doctor [--repair]
  --log-routine <name>
  --complete-run
`;

function cli() {
  const args = process.argv.slice(2);
  const paths = resolvePaths();
  const config = loadConfig(paths.config);
  const now = nowSec();

  if (args.includes('--init')) return cmdInit(args, paths, config, now);
  if (args.includes('--start-shift')) return cmdStartShift(args, paths, config, now);
  if (args.includes('--end-shift')) return cmdEndShift(args, paths, config, now);
  if (args.includes('--extend-budget')) return cmdExtendBudget(args, paths, config, now);
  if (args.includes('--approve')) return cmdApprove(args, paths, config, now);
  if (args.includes('--set-verified-tree')) return cmdSetVerifiedTree(args, paths, config, now);
  if (args.includes('--task')) return cmdTask(args, paths, config, now);
  if (args.includes('--record-handoff')) return cmdRecordHandoff(args, paths, config, now);
  if (args.includes('--doctor')) return cmdDoctor(args, paths, config, now);
  if (args.includes('--status')) return cmdStatus(args, paths, config, now);
  if (args.includes('--shifts')) return cmdShifts(paths, config, now);
  if (args.includes('--log-routine')) return cmdLogRoutine(args, paths, config, now);
  if (args.includes('--complete-run')) return cmdCompleteRun(paths, config, now);

  process.stdout.write(USAGE);
  process.exit(0);
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // Case-insensitive compare on Windows: drive-letter/segment casing between
    // argv[1] (as passed via $CLAUDE_PROJECT_DIR-anchored shell commands) and
    // Node's resolution of import.meta.url is not guaranteed to match on a
    // case-insensitive filesystem; strict === would silently no-op the CLI.
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch {
    return false;
  }
})();

if (isMain) cli();

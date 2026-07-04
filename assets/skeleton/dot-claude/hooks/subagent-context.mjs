#!/usr/bin/env node
// v3 subagent-context.mjs — PreToolUse(Task) hook (spec §8/WP4, R16): every
// subagent dispatch gets the active-task identity PREPENDED to its prompt via
// hookSpecificOutput.updatedInput — never replacing it — plus the curated context
// manifest for that agent type as a READ LIST (paths + reasons; the subagent
// holds Read and fetches files itself — R16 rejected content-inlining).
//
// Preamble shape:
//   <!-- loopwright-injected -->
//   Active task: T14 (verifying) — next: <next-step cell>
//   Shift s-007 · operator ofek                      (when loop.json resolves)
//   **Now:** … / **Next:** …                          (from STATE.md, when present)
//   Read these before starting:
//   - <path> — <reason>                               (manifests/<subagent_type>.jsonl)
//
// Determinism rules (pinned): no active task (no session pointer AND no single
// active board row) ⇒ exit 0 passthrough with a stderr note — the hook never
// guesses scope. Missing manifest ⇒ task-pointer-only preamble. Rows without a
// `file` key are seeds — skipped. Caps: ≤100 manifest rows, preamble ≤8 KB
// (overflow drops rows from the end, with a warning).
//
// Ledger: appends `dispatch{agent, task}` (§2.2) — the audit line that pairs a
// Task dispatch with the task it served. Best-effort: a ledger problem never
// blocks a dispatch.
//
// Fail mode: fail-open. Any parse failure or throw ⇒ exit 0 with EMPTY stdout,
// which leaves the original tool input untouched. Greppable stderr prefix:
// `subagent-context:`. Fires per dispatch only — latency is off the per-turn path.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { appendEvent } from './ledger.mjs';
import { parseBoard, activeRow } from './tasks.mjs';

export const MAX_MANIFEST_ROWS = 100;
export const MAX_PREAMBLE_BYTES = 8192;
export const INJECT_MARKER = '<!-- loopwright-injected -->';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse a manifests/<agent>.jsonl file: one JSON object per line. Rows with a
 * non-empty string `file` become entries {file, reason}; rows without one are
 * seeds (skipped); unparseable lines are counted, never fatal. */
export function parseManifest(raw, cap = MAX_MANIFEST_ROWS) {
  const out = { entries: [], seeds: 0, bad: 0, capped: 0 };
  if (typeof raw !== 'string') return out;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.bad++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.file !== 'string' || parsed.file.trim() === '') {
      out.seeds++;
      continue;
    }
    if (out.entries.length >= cap) {
      out.capped++;
      continue;
    }
    out.entries.push({
      file: parsed.file.trim(),
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
    });
  }
  return out;
}

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Build the preamble. Returns {text, droppedEntries} — droppedEntries > 0 when
 * the 8 KB cap forced manifest rows off the end. */
export function buildPreamble({ row, state = null, nowLine = null, nextLine = null, entries = [] }) {
  const head = [INJECT_MARKER, `Active task: ${row.id} (${String(row.status).toLowerCase()}) — next: ${oneLine(row.next_step) || '(next-step cell empty)'}`];
  if (state && state.shift_id) head.push(`Shift ${state.shift_id} · operator ${state.operator || 'unknown'}`);
  if (nowLine) head.push(oneLine(nowLine));
  if (nextLine) head.push(oneLine(nextLine));

  const assemble = (list) => {
    const lines = [...head];
    if (list.length > 0) {
      lines.push('Read these before starting:');
      for (const e of list) lines.push(`- ${e.file}${e.reason ? ` — ${e.reason}` : ''}`);
    }
    return lines.join('\n');
  };

  let list = [...entries];
  let text = assemble(list);
  let dropped = 0;
  while (Buffer.byteLength(text, 'utf8') > MAX_PREAMBLE_BYTES && list.length > 0) {
    list = list.slice(0, -1);
    dropped++;
    text = assemble(list);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PREAMBLE_BYTES) {
    // Pathological head lines (giant cells) — hard-truncate as the last resort.
    text = text.slice(0, MAX_PREAMBLE_BYTES - 2) + ' …';
  }
  return { text, droppedEntries: dropped };
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

function tasksMdPath() {
  return process.env.LOOPWRIGHT_TASKS_MD || path.join(claudeDir(), 'TASKS.md');
}

function stateMdPath() {
  return process.env.LOOPWRIGHT_STATE_MD || path.join(claudeDir(), 'STATE.md');
}

function loopJsonPath() {
  return process.env.LOOPWRIGHT_LOOP_JSON || path.join(claudeDir(), 'loop.json');
}

function ledgerPath() {
  return process.env.LOOPWRIGHT_LEDGER || path.join(claudeDir(), 'ledger', 'events.jsonl');
}

function runtimeDir() {
  return process.env.LOOPWRIGHT_RUNTIME_DIR || path.join(claudeDir(), '.runtime');
}

function manifestsDir() {
  return process.env.LOOPWRIGHT_MANIFESTS_DIR || path.join(claudeDir(), 'manifests');
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

// subagent_type and session_id come from the payload — validate before joining
// into any filesystem path (no traversal via a hostile agent name).
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function passthrough() {
  process.exit(0);
}

function main() {
  if (process.env.LOOPWRIGHT_HOOKS === '0') {
    process.stderr.write('subagent-context: disabled via LOOPWRIGHT_HOOKS=0\n');
    passthrough();
    return;
  }

  let payload = {};
  try {
    const raw = readStdinSync();
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
    if (!payload || typeof payload !== 'object') payload = {};
  } catch (e) {
    process.stderr.write(`subagent-context: could not parse hook input, passthrough: ${e.message}\n`);
    passthrough();
    return;
  }

  try {
    // Non-Task or missing subagent_type ⇒ passthrough (pinned).
    if (payload.tool_name !== 'Task') {
      passthrough();
      return;
    }
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : null;
    const subagentType = toolInput && typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : '';
    if (!toolInput || !subagentType) {
      passthrough();
      return;
    }

    // Resolve the active task: session pointer first, board fallback — never guess.
    const board = (() => {
      const raw = readFileSoft(tasksMdPath());
      return raw === null ? null : parseBoard(raw);
    })();
    const rows = board && !board.error ? board.rows : [];
    const archiveRows = board && !board.error ? board.archiveRows : [];

    let row = null;
    const sid = typeof payload.session_id === 'string' && SAFE_NAME.test(payload.session_id)
      ? payload.session_id
      : (process.env.LOOPWRIGHT_SESSION_ID && SAFE_NAME.test(process.env.LOOPWRIGHT_SESSION_ID) ? process.env.LOOPWRIGHT_SESSION_ID : null);
    if (sid) {
      const ptrRaw = readFileSoft(path.join(runtimeDir(), 'sessions', `${sid}.json`));
      if (ptrRaw !== null) {
        try {
          const ptr = JSON.parse(ptrRaw);
          const id = ptr && typeof ptr === 'object' ? ptr.active_task : null;
          if (id) row = rows.find((r) => r.id === id) || archiveRows.find((r) => r.id === id) || null;
        } catch {
          /* corrupt pointer — board fallback below */
        }
      }
    }
    if (!row) row = activeRow(rows);
    if (!row) {
      process.stderr.write(
        'subagent-context: no active task — dispatch passthrough (claim one first: node .claude/hooks/loop-state.mjs --task T# --to in_progress)\n',
      );
      passthrough();
      return;
    }

    // Best-effort context: loop.json (shift line) + STATE.md (Now/Next lines).
    let state = null;
    const loopRaw = readFileSoft(loopJsonPath());
    if (loopRaw !== null) {
      try {
        const p = JSON.parse(loopRaw);
        if (p && typeof p === 'object') state = p;
      } catch {
        /* best-effort */
      }
    }
    let nowLine = null;
    let nextLine = null;
    const stateMd = readFileSoft(stateMdPath());
    if (stateMd !== null) {
      for (const line of stateMd.split('\n')) {
        if (nowLine === null && line.trim().startsWith('**Now:**')) nowLine = line.trim();
        else if (nextLine === null && line.trim().startsWith('**Next:**')) nextLine = line.trim();
        if (nowLine !== null && nextLine !== null) break;
      }
    }

    // Curated manifest — path list, never inlined content (R16).
    let entries = [];
    if (SAFE_NAME.test(subagentType)) {
      const manifestRaw = readFileSoft(path.join(manifestsDir(), `${subagentType}.jsonl`));
      if (manifestRaw !== null) {
        const parsed = parseManifest(manifestRaw);
        entries = parsed.entries;
        if (parsed.bad > 0) process.stderr.write(`subagent-context: manifest ${subagentType}.jsonl: skipped ${parsed.bad} unparseable line(s)\n`);
        if (parsed.capped > 0) process.stderr.write(`subagent-context: manifest ${subagentType}.jsonl: capped at ${MAX_MANIFEST_ROWS} rows (${parsed.capped} dropped)\n`);
      }
    } else {
      process.stderr.write(`subagent-context: unsafe subagent_type name — manifest lookup skipped\n`);
    }

    const { text: preamble, droppedEntries } = buildPreamble({ row, state, nowLine, nextLine, entries });
    if (droppedEntries > 0) {
      process.stderr.write(`subagent-context: preamble over ${MAX_PREAMBLE_BYTES} bytes — dropped ${droppedEntries} manifest row(s) from the end\n`);
    }

    // Audit event BEFORE the output write (§2.2 ordering) — but best-effort:
    // a ledger problem must never block a dispatch (fail-open).
    try {
      appendEvent(
        ledgerPath(),
        {
          run: state ? state.run_id ?? null : null,
          shift: state ? state.shift_id ?? null : null,
          session: sid || 'unknown',
          actor: 'hook:subagent-context',
        },
        'dispatch',
        { agent: subagentType, task: row.id },
      );
    } catch (e) {
      process.stderr.write(`subagent-context: dispatch event not appended: ${e.message}\n`);
    }

    // PREPEND, never replace (pinned): the original prompt survives verbatim,
    // and every other tool_input field passes through untouched.
    const originalPrompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, prompt: `${preamble}\n\n${originalPrompt}` },
        },
      }) + '\n',
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(`subagent-context: internal error, passthrough: ${e.stack || e.message}\n`);
    passthrough();
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

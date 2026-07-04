// v3 tasks.mjs — the TASKS.md task-board library (spec §1.1, §8/WP1). LIBRARY ONLY:
// no CLI main — `loop-state.mjs --task …` is the single sanctioned writer of status
// cells (R17); workflow-state.mjs, precompact-anchor.mjs and session hooks read
// through this parser.
//
// The board is one git-tracked pipe table with POSITIONAL columns (the proven
// FINDINGS.md discipline — check-gate-style parsers key on position, not header
// magic): `| ID | milestone | title | status | next step | owner | updated |`.
// Rich per-task artifacts live where v2 already puts them (DESIGN/DECISIONS/
// dispatch prompts) — a row is a pointer plus a resume-precise next step, not a
// document.
//
// Precedence (§1.2, R25): markdown wins for INTENT — a row a human/model hand-edited
// is reported by --doctor, never reverted. That is why parseBoard NEVER throws and
// why writers must refuse to serialize a board whose parse degraded (error set):
// rewriting a half-understood file would destroy intent.
//
// Node stdlib only. Pure functions; no I/O in this module.

// ---------------------------------------------------------------------------
// Status machine — STATUSES is the single source for the workflow-state
// invariant test (§3.2): every status here must have a [workflow-state:*]
// block in WORKFLOW.md.
// ---------------------------------------------------------------------------

export const STATUSES = Object.freeze([
  'queued',
  'planning',
  'in_progress',
  'verifying',
  'committing',
  'done',
  'blocked',
  'dropped',
]);

/** The "exactly one task is being worked" trio (activeRow, workflow-state rung 3). */
export const ACTIVE_STATUSES = Object.freeze(['in_progress', 'verifying', 'committing']);

// Legal moves (§8/WP1): forward along queued→planning→in_progress→verifying→
// committing→done (skips allowed — the loop legitimately jumps queued→in_progress);
// any non-terminal → blocked/dropped; blocked → any non-terminal (re-queue or
// resume anywhere); done and dropped are terminal (doctor NOTES divergence on a
// terminal row, it never "fixes" one).
export const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['planning', 'in_progress', 'verifying', 'committing', 'done', 'blocked', 'dropped']),
  planning: Object.freeze(['in_progress', 'verifying', 'committing', 'done', 'blocked', 'dropped']),
  in_progress: Object.freeze(['verifying', 'committing', 'done', 'blocked', 'dropped']),
  verifying: Object.freeze(['committing', 'done', 'blocked', 'dropped']),
  committing: Object.freeze(['done', 'blocked', 'dropped']),
  blocked: Object.freeze(['queued', 'planning', 'in_progress', 'verifying', 'committing', 'dropped']),
  done: Object.freeze([]),
  dropped: Object.freeze([]),
});

export function canTransition(from, to) {
  const legal = TRANSITIONS[from];
  return Array.isArray(legal) && legal.includes(to);
}

// ---------------------------------------------------------------------------
// Board grammar — positional columns, pinned by tests.
// ---------------------------------------------------------------------------

export const BOARD_COLUMNS = Object.freeze(['id', 'milestone', 'title', 'status', 'next step', 'owner', 'updated']);
export const BOARD_HEADER = '| ID | milestone | title | status | next step | owner | updated |';
export const BOARD_SEPARATOR = '|----|-----------|-------|--------|-----------|-------|---------|';
export const ARCHIVE_HEADING = '## Done (archive)';

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((s) => s.trim());
}

function cellsToRow(cells) {
  return {
    id: cells[0],
    milestone: cells[1],
    title: cells[2],
    status: cells[3],
    next_step: cells[4],
    owner: cells[5],
    updated: cells[6],
  };
}

/** Cell values must never break the table grammar — one line, no raw pipes. */
export function sanitizeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim();
}

function rowToLine(row) {
  const c = (v) => sanitizeCell(v);
  return `| ${c(row.id)} | ${c(row.milestone)} | ${c(row.title)} | ${c(row.status)} | ${c(row.next_step)} | ${c(row.owner)} | ${c(row.updated)} |`;
}

function isSeparatorLine(line) {
  const t = line.trim();
  return /^\|[\s\-:|]+\|$/.test(t) && t.includes('-');
}

/** Parse one section's pipe table; degrade (rows [], error set), never throw. */
function parseTable(lines) {
  const res = { pre: [], rows: [], post: [], error: null, found: false };
  const i = lines.findIndex((l) => l.trim().startsWith('|'));
  if (i === -1) {
    res.pre = [...lines];
    return res;
  }
  res.pre = lines.slice(0, i);
  const headerCells = splitRow(lines[i]);
  const headerOk =
    headerCells &&
    headerCells.length === BOARD_COLUMNS.length &&
    BOARD_COLUMNS.every((c, k) => headerCells[k].toLowerCase() === c);
  if (!headerOk) {
    res.error = `unexpected table header: ${lines[i].trim()}`;
    res.pre = [...lines]; // treat the whole section as opaque — degrade to no rows
    return res;
  }
  res.found = true;
  let j = i + 1;
  if (j < lines.length && isSeparatorLine(lines[j])) j++;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    if (!cells || cells.length !== BOARD_COLUMNS.length) {
      res.error = `malformed row skipped: ${line.trim()}`;
      continue;
    }
    res.rows.push(cellsToRow(cells));
  }
  res.post = lines.slice(j);
  return res;
}

/**
 * parseBoard(md) → {rows, archiveRows, error, …layout} — NEVER throws (§8/WP1:
 * malformed input degrades to [] with a visible `error` flag). The extra `_`
 * fields capture the surrounding prose verbatim so serializeBoard round-trips
 * byte-stable — writers must not launder a file they only partly understood.
 */
export function parseBoard(md) {
  const board = {
    rows: [],
    archiveRows: [],
    error: null,
    _pre: [],
    _mid: [],
    _heading: null,
    _archivePre: [],
    _archivePost: [],
  };
  if (typeof md !== 'string' || md.trim() === '') {
    board.error = 'board missing or empty';
    return board;
  }
  const lines = md.split('\n');
  const hIdx = lines.findIndex((l) => /^##\s+Done \(archive\)\s*$/.test(l.trim()));
  const mainLines = hIdx === -1 ? lines : lines.slice(0, hIdx);
  const archLines = hIdx === -1 ? [] : lines.slice(hIdx + 1);
  if (hIdx !== -1) board._heading = lines[hIdx];

  const main = parseTable(mainLines);
  board._pre = main.pre;
  board._mid = main.post;
  board.rows = main.rows;
  if (main.error) board.error = main.error;
  else if (!main.found) board.error = 'no task table found';

  if (hIdx !== -1) {
    const arch = parseTable(archLines);
    board._archivePre = arch.pre;
    board._archivePost = arch.post;
    board.archiveRows = arch.rows;
    if (arch.error && !board.error) board.error = arch.error;
  }
  return board;
}

/** serializeBoard(board) → markdown. Canonical header/separator; rows single-space
 * padded (`| a | b | … |`); surrounding prose emitted verbatim from the parse. */
export function serializeBoard(board) {
  const out = [...board._pre, BOARD_HEADER, BOARD_SEPARATOR, ...board.rows.map(rowToLine), ...board._mid];
  if (board._heading !== null && board._heading !== undefined) {
    out.push(board._heading, ...board._archivePre);
    if (board.archiveRows.length > 0) {
      out.push(BOARD_HEADER, BOARD_SEPARATOR, ...board.archiveRows.map(rowToLine));
    }
    out.push(...board._archivePost);
  }
  return out.join('\n');
}

/** A fresh board in the shipped TASKS.md shape (used when the file is absent). */
export function emptyBoard() {
  return {
    rows: [],
    archiveRows: [],
    error: null,
    _pre: [
      '# Tasks',
      '_Statuses: queued → planning → in_progress → verifying → committing → done (+ blocked, dropped)._',
      '_Status cells change ONLY via `node .claude/hooks/loop-state.mjs --task <id> --to <status> [--next "…"]`',
      '(it appends the ledger event first, then rewrites this row). Hand-edits are detected by --doctor, never reverted._',
      '',
    ],
    _mid: [''],
    _heading: ARCHIVE_HEADING,
    _archivePre: ['_Rows moved here by the milestone-boundary Record step; never deleted._', ''],
    _archivePost: [''],
  };
}

// ---------------------------------------------------------------------------
// Pure board operations — none mutate their input.
// ---------------------------------------------------------------------------

/** Update the row with row.id (merge) or append it. Pure. */
export function upsertRow(board, row) {
  const rows = [...board.rows];
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) rows.push({ ...row });
  else rows[i] = { ...rows[i], ...row };
  return { ...board, rows };
}

/** Next free T# across BOTH the live table and the archive (ids are never reused). */
export function nextTaskId(board) {
  let max = 0;
  for (const r of [...board.rows, ...board.archiveRows]) {
    const m = /^T(\d+)$/.exec(r.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T${max + 1}`;
}

/** activeRow(rows) — exactly one row in {in_progress, verifying, committing},
 * else null (never guess between two candidates — §3.2's "never guess" rule). */
export function activeRow(rows) {
  const active = (rows || []).filter((r) => ACTIVE_STATUSES.includes(r.status));
  return active.length === 1 ? active[0] : null;
}

/** archiveDone(md) → md with `done` rows MOVED (never deleted) under
 * `## Done (archive)`. A degraded parse returns the input untouched — never
 * rewrite a board that didn't fully round-trip. */
export function archiveDone(md) {
  const board = parseBoard(md);
  if (board.error) return md;
  const done = board.rows.filter((r) => r.status === 'done');
  if (done.length === 0) return md;
  board.rows = board.rows.filter((r) => r.status !== 'done');
  if (board._heading === null || board._heading === undefined) {
    board._heading = ARCHIVE_HEADING;
    board._archivePre = ['_Rows moved here by the milestone-boundary Record step; never deleted._', ''];
    board._archivePost = [];
    if (board._mid.length === 0) board._mid = [''];
  }
  board.archiveRows = [...board.archiveRows, ...done];
  return serializeBoard(board);
}

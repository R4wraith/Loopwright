// v3 tasks.test.mjs — pins for the task-board library (spec §8/WP1): positional
// columns, byte-stable round-trip, the 8-status machine, archive-never-deletes,
// and degrade-not-throw on malformed input.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES,
  ACTIVE_STATUSES,
  TRANSITIONS,
  canTransition,
  BOARD_COLUMNS,
  BOARD_HEADER,
  BOARD_SEPARATOR,
  parseBoard,
  serializeBoard,
  upsertRow,
  nextTaskId,
  activeRow,
  archiveDone,
  emptyBoard,
  sanitizeCell,
} from './tasks.mjs';

// The canonical shipped-TASKS.md shape (WP6 ships it with {{KEYSTONE}}/{{DATE}}
// placeholders — grammar identical).
const CANONICAL = [
  '# Tasks',
  '_Statuses: queued → planning → in_progress → verifying → committing → done (+ blocked, dropped)._',
  '_Status cells change ONLY via `node .claude/hooks/loop-state.mjs --task <id> --to <status> [--next "…"]`',
  '(it appends the ledger event first, then rewrites this row). Hand-edits are detected by --doctor, never reverted._',
  '',
  BOARD_HEADER,
  BOARD_SEPARATOR,
  '| T1 | M1 | parser — first slice | queued | plan the slice: read DESIGN build order | — | 2026-07-04 |',
  '| T2 | M1 | parser EOF handling | in_progress | re-run T2 verify after EOF fix | ofek | 2026-07-04 |',
  '',
  '## Done (archive)',
  '_Rows moved here by the milestone-boundary Record step; never deleted._',
  '',
].join('\n');

test('STATUSES is the pinned 8-status set, in order (single source for WORKFLOW.md blocks)', () => {
  assert.deepEqual(STATUSES, ['queued', 'planning', 'in_progress', 'verifying', 'committing', 'done', 'blocked', 'dropped']);
  assert.deepEqual(ACTIVE_STATUSES, ['in_progress', 'verifying', 'committing']);
});

test('column positions are pinned: | ID | milestone | title | status | next step | owner | updated |', () => {
  assert.deepEqual(BOARD_COLUMNS, ['id', 'milestone', 'title', 'status', 'next step', 'owner', 'updated']);
  const board = parseBoard(CANONICAL);
  assert.equal(board.error, null);
  assert.equal(board.rows.length, 2);
  const r = board.rows[1];
  assert.equal(r.id, 'T2');
  assert.equal(r.milestone, 'M1');
  assert.equal(r.title, 'parser EOF handling');
  assert.equal(r.status, 'in_progress');
  assert.equal(r.next_step, 're-run T2 verify after EOF fix');
  assert.equal(r.owner, 'ofek');
  assert.equal(r.updated, '2026-07-04');
});

test('round-trip is byte-stable on the canonical shape', () => {
  assert.equal(serializeBoard(parseBoard(CANONICAL)), CANONICAL);
});

test('round-trip is byte-stable with rows in the archive table too', () => {
  const md = CANONICAL + '\n' + BOARD_HEADER + '\n' + BOARD_SEPARATOR + '\n' +
    '| T0 | M0 | bootstrap | done | — | — | 2026-07-01 |' + '\n';
  // Rebuild via parse→serialize twice: idempotent and stable.
  const once = serializeBoard(parseBoard(md));
  const twice = serializeBoard(parseBoard(once));
  assert.equal(once, twice);
  const board = parseBoard(once);
  assert.equal(board.archiveRows.length, 1);
  assert.equal(board.archiveRows[0].id, 'T0');
});

test('legal transitions: forward chain (skips allowed), any active → blocked/dropped, blocked → any active', () => {
  // forward chain incl. the loop's real queued→in_progress jump
  assert.ok(canTransition('queued', 'planning'));
  assert.ok(canTransition('queued', 'in_progress'));
  assert.ok(canTransition('planning', 'in_progress'));
  assert.ok(canTransition('in_progress', 'verifying'));
  assert.ok(canTransition('verifying', 'committing'));
  assert.ok(canTransition('committing', 'done'));
  // any active → blocked/dropped
  for (const from of ['queued', 'planning', 'in_progress', 'verifying', 'committing']) {
    assert.ok(canTransition(from, 'blocked'), `${from} → blocked`);
    assert.ok(canTransition(from, 'dropped'), `${from} → dropped`);
  }
  // blocked → any non-terminal
  for (const to of ['queued', 'planning', 'in_progress', 'verifying', 'committing']) {
    assert.ok(canTransition('blocked', to), `blocked → ${to}`);
  }
});

test('illegal transitions: no backward moves, done/dropped terminal', () => {
  assert.ok(!canTransition('in_progress', 'queued'), 'no backward moves outside blocked');
  assert.ok(!canTransition('verifying', 'in_progress'), 'verify-failed routes through blocked, not backward');
  assert.ok(!canTransition('done', 'in_progress'), 'done is terminal');
  assert.ok(!canTransition('done', 'blocked'), 'done is terminal even for blocked');
  assert.ok(!canTransition('dropped', 'queued'), 'dropped is terminal');
  assert.ok(!canTransition('nonsense', 'queued'), 'unknown from-status is never legal');
  assert.ok(!canTransition('queued', 'nonsense'), 'unknown to-status is never legal');
});

test('TRANSITIONS map is total over STATUSES and closed over STATUSES', () => {
  for (const s of STATUSES) {
    assert.ok(Array.isArray(TRANSITIONS[s]), `TRANSITIONS[${s}] exists`);
    for (const t of TRANSITIONS[s]) assert.ok(STATUSES.includes(t), `${s} → ${t} targets a known status`);
  }
  assert.deepEqual(TRANSITIONS.done, []);
  assert.deepEqual(TRANSITIONS.dropped, []);
});

test('upsertRow updates by id, appends when new, and never mutates its input', () => {
  const board = parseBoard(CANONICAL);
  const updated = upsertRow(board, { id: 'T2', status: 'verifying' });
  assert.equal(updated.rows.find((r) => r.id === 'T2').status, 'verifying');
  assert.equal(updated.rows.find((r) => r.id === 'T2').title, 'parser EOF handling', 'merge keeps other cells');
  assert.equal(board.rows.find((r) => r.id === 'T2').status, 'in_progress', 'input board untouched');
  const appended = upsertRow(board, { id: 'T3', milestone: 'M2', title: 'new', status: 'queued', next_step: 'x', owner: '—', updated: 'd' });
  assert.equal(appended.rows.length, 3);
});

test('done rows persist on the live table until archived; archiveDone moves (never deletes) them', () => {
  const board = upsertRow(parseBoard(CANONICAL), { id: 'T2', status: 'done' });
  const md = serializeBoard(board);
  assert.match(md, /\| T2 \|.*\| done \|/, 'done row still on the live table');
  const archived = archiveDone(md);
  const after = parseBoard(archived);
  assert.equal(after.rows.find((r) => r.id === 'T2'), undefined, 'moved off the live table');
  const archRow = after.archiveRows.find((r) => r.id === 'T2');
  assert.ok(archRow, 'row exists in the archive');
  assert.equal(archRow.title, 'parser EOF handling', 'row content preserved verbatim');
  assert.equal(after.rows.length, 1, 'non-done rows untouched');
});

test('archive accumulates across repeated archiveDone calls — rows are never deleted', () => {
  let md = serializeBoard(upsertRow(parseBoard(CANONICAL), { id: 'T2', status: 'done' }));
  md = archiveDone(md);
  let board = parseBoard(md);
  board = upsertRow(board, { id: 'T1', status: 'done' });
  md = archiveDone(serializeBoard(board));
  const after = parseBoard(md);
  assert.equal(after.archiveRows.length, 2, 'first archived row survived the second archive pass');
  assert.deepEqual(after.archiveRows.map((r) => r.id).sort(), ['T1', 'T2']);
  assert.equal(after.rows.length, 0);
});

test('archiveDone is a no-op without done rows and never rewrites a degraded parse', () => {
  assert.equal(archiveDone(CANONICAL), CANONICAL, 'no done rows ⇒ input returned untouched');
  const garbage = 'not a board at all';
  assert.equal(archiveDone(garbage), garbage, 'degraded parse ⇒ input returned untouched');
});

test('malformed table degrades to rows [] with a visible error flag — never throws', () => {
  const noTable = parseBoard('# Tasks\n\nno table here\n');
  assert.deepEqual(noTable.rows, []);
  assert.ok(noTable.error, 'error flag set');

  const badHeader = parseBoard('# Tasks\n\n| what | is | this |\n|---|---|---|\n| a | b | c |\n');
  assert.deepEqual(badHeader.rows, []);
  assert.match(badHeader.error, /unexpected table header/);

  const empty = parseBoard('');
  assert.deepEqual(empty.rows, []);
  assert.ok(empty.error);

  const notAString = parseBoard(undefined);
  assert.deepEqual(notAString.rows, []);
  assert.ok(notAString.error);
});

test('a single malformed row is skipped with the error flag set; good rows still parse', () => {
  const md = [
    BOARD_HEADER,
    BOARD_SEPARATOR,
    '| T1 | M1 | good | queued | next | — | d |',
    '| T2 | M1 | missing cells | queued |',
    '| T3 | M1 | also good | queued | next | — | d |',
  ].join('\n');
  const board = parseBoard(md);
  assert.deepEqual(board.rows.map((r) => r.id), ['T1', 'T3']);
  assert.match(board.error, /malformed row skipped/);
});

test('activeRow: exactly one of {in_progress, verifying, committing} else null (never guess)', () => {
  const rows = (statuses) => statuses.map((s, i) => ({ id: `T${i + 1}`, status: s }));
  assert.equal(activeRow(rows(['queued', 'in_progress', 'done'])).id, 'T2');
  assert.equal(activeRow(rows(['queued', 'done'])), null, 'zero active ⇒ null');
  assert.equal(activeRow(rows(['in_progress', 'verifying'])), null, 'two active ⇒ null, never guess');
  assert.equal(activeRow([]), null);
  assert.equal(activeRow(undefined), null);
});

test('nextTaskId counts live AND archived rows — ids are never reused', () => {
  assert.equal(nextTaskId(parseBoard(CANONICAL)), 'T3');
  const md = CANONICAL + '\n' + BOARD_HEADER + '\n' + BOARD_SEPARATOR + '\n' + '| T9 | M0 | old | done | — | — | d |' + '\n';
  assert.equal(nextTaskId(parseBoard(md)), 'T10');
  assert.equal(nextTaskId(emptyBoard()), 'T1');
});

test('cell sanitization: pipes and newlines cannot break the table grammar', () => {
  assert.equal(sanitizeCell('a | b'), 'a / b');
  assert.equal(sanitizeCell('line1\nline2'), 'line1 line2');
  const board = upsertRow(emptyBoard(), {
    id: 'T1', milestone: 'M1', title: 'evil | title\nwith newline', status: 'queued', next_step: 'n', owner: '—', updated: 'd',
  });
  const reparsed = parseBoard(serializeBoard(board));
  assert.equal(reparsed.error, null);
  assert.equal(reparsed.rows.length, 1);
  assert.equal(reparsed.rows[0].title, 'evil / title with newline');
});

test('emptyBoard serializes to a parseable board with the archive section', () => {
  const md = serializeBoard(emptyBoard());
  const board = parseBoard(md);
  assert.equal(board.error, null);
  assert.deepEqual(board.rows, []);
  assert.ok(md.includes('## Done (archive)'));
  assert.equal(serializeBoard(board), md, 'idempotent');
});

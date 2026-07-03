#!/usr/bin/env node
// SP1.5 secret-scan.mjs — PostToolUse hook on Edit|Write|MultiEdit.
//
// Confirmed constraint: PostToolUse CANNOT block — the file is already on disk by the
// time this runs. This hook is honestly detect-and-remediate, not a block: on a hit it
// tells Claude to scrub the secret from disk and move it to an env/secret store (never
// "commit blocked" — nothing was blocked). Exit 2 to surface the feedback loudly; that
// is its only effect here. It NEVER prints the matched secret — only file:line + rule
// name (F36). A missing pattern file is a loud error, never a silent exit 0 (F32).
//
// The primary fail-closed enforcement for secret *writes via Bash redirection* is
// guard.mjs's PreToolUse check; this hook is the after-the-fact net for Edit/Write/
// MultiEdit, which guard.mjs cannot see.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadPatterns } from './guard.mjs';

const ALLOWLIST_PRAGMA = /#\s*pragma:\s*allowlist secret/i;

/** Read an optional allowlist file: one relative/absolute path (or path suffix) per
 * line. Comments (#) and blank lines ignored. Missing file => empty list (this file is
 * optional — only secret-patterns.txt is mandatory). */
export function loadAllowlist(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** True if `filePath` matches (by suffix, normalized to forward slashes) any entry in
 * `allowlist`. */
export function isAllowlisted(filePath, allowlist) {
  const norm = String(filePath).replace(/\\/g, '/');
  return allowlist.some((entry) => norm.endsWith(String(entry).replace(/\\/g, '/')));
}

/** Scan a file on disk against `patterns` (from loadPatterns). Returns an array of
 * hits: { file, line, rule } — never the matched text (F36). `allowlist` is a list of
 * file paths/suffixes whose findings are fully suppressed (fixtures). Lines carrying
 * the inline `# pragma: allowlist secret` marker are individually suppressed. */
export function scanFile(filePath, patterns, allowlist = []) {
  if (isAllowlisted(filePath, allowlist)) return [];
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOWLIST_PRAGMA.test(line)) continue;
    for (const p of patterns) {
      if (p.regex.test(line)) {
        hits.push({ file: filePath, line: i + 1, rule: p.name });
        break; // one hit per line is enough signal; avoid duplicate noise
      }
    }
  }
  return hits;
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loudError(message) {
  process.stderr.write(`secret-scan ERROR: ${message}\n`);
  process.exit(2);
}

function main() {
  let payload;
  try {
    const raw = readStdinSync();
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    loudError(`could not parse hook input: ${e.message}`);
    return;
  }

  const ti = payload?.tool_input ?? {};
  const filePath = ti.file_path || ti.path || '';
  if (!filePath) process.exit(0); // nothing to scan

  if (!existsSync(filePath)) process.exit(0); // file not on disk — nothing to scan

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const patternsPath = path.join(here, 'secret-patterns.txt');
  const allowlistPath = path.join(here, 'secret-allowlist.txt');

  let patterns;
  try {
    patterns = loadPatterns(patternsPath);
  } catch (e) {
    // F32: missing/unreadable pattern file is a loud error, never a silent exit 0 —
    // PostToolUse can't block, but it must not pretend the file was scanned.
    loudError(`secret-patterns.txt missing or unreadable at ${patternsPath} — file was NOT scanned: ${e.message}`);
    return;
  }

  const allowlist = loadAllowlist(allowlistPath);
  const hits = scanFile(filePath, patterns, allowlist);

  if (hits.length === 0) process.exit(0);

  const lines = hits.map((h) => `  ${h.file}:${h.line} — rule '${h.rule}'`).join('\n');
  process.stderr.write(
    `secret-scan: possible secret(s) detected (file already on disk — PostToolUse cannot block):\n${lines}\n` +
    `Action required: scrub the secret value from disk and move it to an env var / secret store. ` +
    `Do not just avoid committing it — it is already written. ` +
    `If this is an intentional test fixture, add "# pragma: allowlist secret" on the line or list the ` +
    `file in .claude/hooks/secret-allowlist.txt.\n`,
  );
  process.exit(2);
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) main();

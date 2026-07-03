import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { scanFile, loadAllowlist, isAllowlisted } from './secret-scan.mjs';
import { loadPatterns } from './guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN_PATH = path.join(HERE, 'secret-scan.mjs');
const PATTERNS_PATH = path.join(HERE, 'secret-patterns.txt');
const patterns = loadPatterns(PATTERNS_PATH);

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp15-scan-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('scanFile — provider coverage', () => {
  test('detects sk-ant- (Anthropic-style) key', () => {
    const f = tmpFile('a.env', 'CLAUDE_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx\n');
    const hits = scanFile(f, patterns, []);
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.rule === 'GENERIC_SK_PREFIX'));
  });

  test('detects unquoted .env KEY=value (F10)', () => {
    const f = tmpFile('b.env', 'API_KEY=plainunquotedvalue123\n');
    const hits = scanFile(f, patterns, []);
    assert.ok(hits.some((h) => h.rule === 'UNQUOTED_ENV_ASSIGNMENT'));
  });

  const providerFixtures = [
    ['AWS_ACCESS_KEY_ID', 'AKIAABCDEFGHIJKLMNOP'],
    ['AWS_TEMP_ACCESS_KEY_ID', 'ASIAABCDEFGHIJKLMNOP'],
    ['PEM_PRIVATE_KEY', '-----BEGIN RSA PRIVATE KEY-----'],
    ['SLACK_TOKEN', 'xoxb-1234567890-abcdefghij'],
    ['GITHUB_TOKEN', 'ghp_' + 'a'.repeat(36)],
    ['GITHUB_FINE_GRAINED_PAT', 'github_pat_' + 'a'.repeat(25)],
    ['GITLAB_TOKEN', 'glpat-' + 'a'.repeat(20)],
    ['STRIPE_LIVE_KEY', 'sk_live_' + 'a'.repeat(20)],
    ['GOOGLE_API_KEY', 'AIza' + 'a'.repeat(35)],
    ['SENDGRID_API_KEY', 'SG.' + 'a'.repeat(20) + '.' + 'b'.repeat(20)],
    ['TWILIO_SID', 'AC' + 'a'.repeat(32)],
    ['JWT_TOKEN', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456'],
  ];

  for (const [rule, value] of providerFixtures) {
    test(`detects ${rule}`, () => {
      const f = tmpFile('c.txt', `SECRET_VALUE = "${value}"\n`);
      const hits = scanFile(f, patterns, []);
      assert.ok(hits.some((h) => h.rule === rule), `expected ${rule} to fire for ${value}; got ${JSON.stringify(hits)}`);
    });
  }
});

describe('scanFile — allowlist suppression (F38)', () => {
  test('inline pragma suppresses the finding', () => {
    const f = tmpFile('d.env', 'API_KEY=plainunquotedvalue123 # pragma: allowlist secret\n');
    const hits = scanFile(f, patterns, []);
    assert.equal(hits.length, 0);
  });

  test('allowlist file (by path) suppresses all findings in that file', () => {
    const f = tmpFile('fixture.env', 'API_KEY=plainunquotedvalue123\n');
    const hits = scanFile(f, patterns, [f]);
    assert.equal(hits.length, 0);
  });

  test('non-allowlisted lines in an otherwise clean file still fire', () => {
    const f = tmpFile('e.env', 'SAFE=1\nAPI_KEY=plainunquotedvalue123\n');
    const hits = scanFile(f, patterns, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });
});

describe('scanFile — output shape (F36: never the secret)', () => {
  test('hit carries file path, line number, rule name — not the matched text', () => {
    const secretValue = 'plainunquotedvalue123';
    const f = tmpFile('f.env', `API_KEY=${secretValue}\n`);
    const hits = scanFile(f, patterns, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, f);
    assert.equal(hits[0].line, 1);
    assert.equal(hits[0].rule, 'UNQUOTED_ENV_ASSIGNMENT');
    assert.ok(!('match' in hits[0]) && !('value' in hits[0]) && !('text' in hits[0]),
      'hit object must not carry the raw matched text under any key');
    assert.ok(!JSON.stringify(hits[0]).includes(secretValue));
  });
});

describe('loadAllowlist / isAllowlisted', () => {
  test('loads paths from an allowlist file, ignoring comments/blank lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp15-allow-'));
    const allowPath = path.join(dir, 'secret-allowlist.txt');
    fs.writeFileSync(allowPath, '# comment\n\nfixtures/a.env\nfixtures/b.env\n');
    const list = loadAllowlist(allowPath);
    assert.deepEqual(list, ['fixtures/a.env', 'fixtures/b.env']);
  });

  test('missing allowlist file yields empty list (allowlist is optional)', () => {
    const list = loadAllowlist(path.join(os.tmpdir(), 'does-not-exist-allowlist.txt'));
    assert.deepEqual(list, []);
  });

  test('isAllowlisted matches by path suffix', () => {
    assert.equal(isAllowlisted('/proj/fixtures/a.env', ['fixtures/a.env']), true);
    assert.equal(isAllowlisted('/proj/other/a.env', ['fixtures/a.env']), false);
  });
});

describe('process-level: missing pattern file => loud error, never silent exit 0 (F32)', () => {
  test('missing secret-patterns.txt => non-zero exit with loud stderr, not silent success', () => {
    // Patterns are resolved relative to the hook script's own location (same convention
    // as guard.mjs), so to genuinely simulate "missing" we run a copy of the hooks
    // without their pattern file, in an isolated directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp15-nopatterns-'));
    fs.copyFileSync(SCAN_PATH, path.join(dir, 'secret-scan.mjs'));
    fs.copyFileSync(path.join(HERE, 'guard.mjs'), path.join(dir, 'guard.mjs'));
    const target = path.join(dir, 'touched.txt');
    fs.writeFileSync(target, 'hello world\n');
    const stdin = JSON.stringify({ tool_input: { file_path: target } });
    let result;
    try {
      const out = execFileSync(process.execPath, [path.join(dir, 'secret-scan.mjs')], {
        input: stdin,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      result = { code: 0, stderr: '' };
    } catch (e) {
      result = { code: e.status, stderr: e.stderr ? e.stderr.toString() : '' };
    }
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /secret-patterns\.txt/i);
  });
});

describe('process-level: end-to-end secret-scan.mjs hook', () => {
  function runScan(stdin, env = {}) {
    try {
      const out = execFileSync(process.execPath, [SCAN_PATH], {
        input: stdin,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, stdout: out.toString() };
    } catch (e) {
      return { code: e.status, stdout: e.stdout ? e.stdout.toString() : '', stderr: e.stderr ? e.stderr.toString() : '' };
    }
  }

  test('touched file with a secret => exit 2, stderr has file:line and rule, never the secret', () => {
    const secretValue = 'plainunquotedvalue123';
    const f = tmpFile('touched.env', `API_KEY=${secretValue}\n`);
    const stdin = JSON.stringify({ tool_input: { file_path: f } });
    const r = runScan(stdin, { CLAUDE_PROJECT_DIR: HERE });
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes(secretValue));
    assert.match(r.stderr, /UNQUOTED_ENV_ASSIGNMENT/);
    assert.match(r.stderr, /:1/);
    assert.match(r.stderr, /scrub/i);
  });

  test('touched file with no secret => exit 0', () => {
    const f = tmpFile('clean.txt', 'hello world\n');
    const stdin = JSON.stringify({ tool_input: { file_path: f } });
    const r = runScan(stdin, { CLAUDE_PROJECT_DIR: HERE });
    assert.equal(r.code, 0);
  });

  test('missing file_path (e.g. unrelated tool_input shape) => exit 0, no crash', () => {
    const r = runScan(JSON.stringify({ tool_input: {} }), { CLAUDE_PROJECT_DIR: HERE });
    assert.equal(r.code, 0);
  });

  test('nonexistent target file => exit 0 (nothing to scan), no crash', () => {
    const r = runScan(
      JSON.stringify({ tool_input: { file_path: path.join(os.tmpdir(), 'sp15-nope-' + Date.now() + '.txt') } }),
      { CLAUDE_PROJECT_DIR: HERE },
    );
    assert.equal(r.code, 0);
  });
});

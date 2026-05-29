/**
 * Tests für die datei-basierten Operationen aus Schritt 3:
 *   add-file, replace-file, delete-file, regex-replace.
 *
 * Jede Operation wird über ihren Default-Export direkt geprüft (gegen ein
 * frisches Temp-Verzeichnis als "Repo"). Schwerpunkte: Idempotenz, sauberes
 * Verhalten bei fehlender Zieldatei und der Path-Traversal-Schutz.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import addFile from '../../src/operations/add-file.js';
import replaceFile from '../../src/operations/replace-file.js';
import deleteFile from '../../src/operations/delete-file.js';
import regexReplace from '../../src/operations/regex-replace.js';
import type { Operation, OperationContext, OperationResult } from '../../src/operations/types.js';

function makeCtx(repoDir: string): OperationContext {
  return {
    repoDir,
    ru: 'test-repo',
    ticket: 'AKB-1',
    branch: 'AKB-1-feature/x',
    sourceBranch: 'master',
  };
}

// Bequemer Aufruf-Helfer: parst Params durchs Schema (Defaults!) und ruft apply.
async function run<P>(
  op: Operation<P>,
  repoDir: string,
  params: Record<string, unknown>,
): Promise<OperationResult> {
  const parsed = op.schema.parse(params);
  return op.apply(parsed, makeCtx(repoDir));
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gitbulk-fileops-'));
});

// ── add-file ────────────────────────────────────────────────────────

describe('add-file operation', () => {
  it('creates a new file (incl. parent dirs)', async () => {
    const r = await run(addFile, ws, { path: 'src/Foo.java', content: 'hello' });
    assert.equal(r.changed, true);
    assert.equal(readFileSync(join(ws, 'src/Foo.java'), 'utf8'), 'hello');
  });

  it('is idempotent when content already matches', async () => {
    await run(addFile, ws, { path: 'a.txt', content: 'x' });
    const r = await run(addFile, ws, { path: 'a.txt', content: 'x' });
    assert.equal(r.changed, false);
  });

  it('skips an existing file with different content (no overwrite)', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old');
    const r = await run(addFile, ws, { path: 'a.txt', content: 'new' });
    assert.equal(r.changed, false);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'old');
  });

  it('overwrites when overwrite: true', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old');
    const r = await run(addFile, ws, { path: 'a.txt', content: 'new', overwrite: true });
    assert.equal(r.changed, true);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'new');
  });

  it('rejects a path that escapes the repo', async () => {
    const r = await run(addFile, ws, { path: '../escape.txt', content: 'x' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
    assert.equal(existsSync(join(ws, '../escape.txt')), false);
  });

  it('rejects an absolute path', async () => {
    const r = await run(addFile, ws, { path: join(tmpdir(), 'abs.txt'), content: 'x' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
  });
});

// ── replace-file ────────────────────────────────────────────────────

describe('replace-file operation', () => {
  it('replaces the content of an existing file', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old');
    const r = await run(replaceFile, ws, { path: 'a.txt', content: 'new' });
    assert.equal(r.changed, true);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'new');
  });

  it('skips (no error) when the file does not exist', async () => {
    const r = await run(replaceFile, ws, { path: 'missing.txt', content: 'x' });
    assert.equal(r.changed, false);
    assert.ok(!r.error);
  });

  it('is idempotent when content already matches', async () => {
    writeFileSync(join(ws, 'a.txt'), 'same');
    const r = await run(replaceFile, ws, { path: 'a.txt', content: 'same' });
    assert.equal(r.changed, false);
  });
});

// ── delete-file ─────────────────────────────────────────────────────

describe('delete-file operation', () => {
  it('deletes an existing file', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    const r = await run(deleteFile, ws, { path: 'a.txt' });
    assert.equal(r.changed, true);
    assert.equal(existsSync(join(ws, 'a.txt')), false);
  });

  it('is a no-op (no error) when the file is already gone', async () => {
    const r = await run(deleteFile, ws, { path: 'missing.txt' });
    assert.equal(r.changed, false);
    assert.ok(!r.error);
  });

  it('errors when the target is a directory', async () => {
    mkdirSync(join(ws, 'adir'));
    const r = await run(deleteFile, ws, { path: 'adir' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
    assert.equal(existsSync(join(ws, 'adir')), true);
  });
});

// ── regex-replace ───────────────────────────────────────────────────

describe('regex-replace operation', () => {
  it('replaces all matches by default (global flag)', async () => {
    writeFileSync(join(ws, 'v.txt'), 'a=1\nb=1\n');
    const r = await run(regexReplace, ws, { path: 'v.txt', pattern: '=1', replacement: '=2' });
    assert.equal(r.changed, true);
    assert.equal(readFileSync(join(ws, 'v.txt'), 'utf8'), 'a=2\nb=2\n');
  });

  it('supports capture-group backreferences', async () => {
    writeFileSync(join(ws, 'v.txt'), 'version: 1.2.3');
    const r = await run(regexReplace, ws, {
      path: 'v.txt',
      pattern: 'version: (\\d+)\\.\\d+\\.\\d+',
      replacement: 'version: $1.0.0',
    });
    assert.equal(r.changed, true);
    assert.equal(readFileSync(join(ws, 'v.txt'), 'utf8'), 'version: 1.0.0');
  });

  it('skips (no error) when the file does not exist', async () => {
    const r = await run(regexReplace, ws, { path: 'missing.txt', pattern: 'x', replacement: 'y' });
    assert.equal(r.changed, false);
    assert.ok(!r.error);
  });

  it('skips when there is no match', async () => {
    writeFileSync(join(ws, 'v.txt'), 'hello');
    const r = await run(regexReplace, ws, { path: 'v.txt', pattern: 'world', replacement: 'x' });
    assert.equal(r.changed, false);
    assert.ok(!r.error);
  });

  it('errors on no match when requireMatch is true', async () => {
    writeFileSync(join(ws, 'v.txt'), 'hello');
    const r = await run(regexReplace, ws, {
      path: 'v.txt',
      pattern: 'world',
      replacement: 'x',
      requireMatch: true,
    });
    assert.equal(r.changed, false);
    assert.ok(r.error);
  });

  it('errors on an invalid regex', async () => {
    writeFileSync(join(ws, 'v.txt'), 'hello');
    const r = await run(regexReplace, ws, { path: 'v.txt', pattern: '(', replacement: 'x' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
  });

  it('is idempotent when the replacement has no effect', async () => {
    writeFileSync(join(ws, 'v.txt'), 'a=2\n');
    const r = await run(regexReplace, ws, { path: 'v.txt', pattern: '=2', replacement: '=2' });
    assert.equal(r.changed, false);
  });
});

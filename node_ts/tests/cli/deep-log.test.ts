/**
 * Unit-Tests für die Deep-Log-Helfer (cli/deep-log.ts).
 *
 * Der interaktive `[D]/[P]`-Prompt ist terminal-only; getestet wird die reine
 * Logik (Dateiname, Datei schreiben) sowie der Nicht-TTY-Pfad von finishDeepLog.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deepLogFileName, writeDeepLogFile, finishDeepLog } from '../../src/cli/deep-log.js';
import { LogCapture } from '../../src/utils/logger.js';

describe('deepLogFileName', () => {
  it('builds a filesystem-safe name with a timestamp', () => {
    const name = deepLogFileName(new Date('2026-06-03T12:34:56.789Z'));
    assert.equal(name, 'gitbulk-log-2026-06-03T12-34-56-789Z.log');
    // Der Zeitstempel-Teil (vor ".log") darf keine ":"/"." enthalten (Windows-sicher).
    const stem = name.replace(/\.log$/, '');
    assert.doesNotMatch(stem, /[:.]/);
  });
});

describe('writeDeepLogFile', () => {
  it('writes the buffered log into the given directory and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitbulk-dl-'));
    const cap = new LogCapture();
    cap.add('[ts] [INFO] hello');
    cap.add('[ts] [WARN] [repo-a] careful');

    const target = writeDeepLogFile(cap, dir);
    assert.match(target, /[\\/]gitbulk-log-.*\.log$/);
    const content = readFileSync(target, 'utf8');
    assert.match(content, /\[INFO\] hello/);
    assert.match(content, /\[WARN\] \[repo-a\] careful/);
  });
});

describe('finishDeepLog (non-interactive)', () => {
  it('does nothing on an empty capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitbulk-dl-empty-'));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      await finishDeepLog(new LogCapture(), { interactive: false });
      // Kein gitbulk/-Ordner angelegt.
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      process.chdir(orig);
    }
  });

  it('auto-writes the log file when not interactive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitbulk-dl-auto-'));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const cap = new LogCapture();
      cap.add('[ts] [INFO] something happened');
      await finishDeepLog(cap, { interactive: false });
      // Datei liegt unter ./gitbulk/
      const files = readdirSync(join(dir, 'gitbulk'));
      assert.equal(files.length, 1);
      assert.match(files[0]!, /^gitbulk-log-.*\.log$/);
      const content = readFileSync(join(dir, 'gitbulk', files[0]!), 'utf8');
      assert.match(content, /something happened/);
    } finally {
      process.chdir(orig);
    }
  });
});

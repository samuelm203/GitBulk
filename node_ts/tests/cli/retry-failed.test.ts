/**
 * Unit-Tests für cli/retry-failed.ts (`--retry-failed report.json`).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFailedRus } from '../../src/cli/retry-failed.js';
import { REPORT_VERSION } from '../../src/core/report-file.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-retry-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeReport(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

describe('readFailedRus', () => {
  it('returns pr-failed, fatal-error and not-processed RUs (in report order)', () => {
    const path = writeReport('ok.json', {
      reportVersion: REPORT_VERSION,
      results: [
        { ru: 'a', outcome: 'pr-created' },
        { ru: 'b', outcome: 'pr-failed' },
        { ru: 'c', outcome: 'pr-skipped' },
        { ru: 'd', outcome: 'fatal-error' },
        { ru: 'e', outcome: 'not-processed' },
      ],
    });
    assert.deepEqual(readFailedRus(path), ['b', 'd', 'e']);
  });

  it('returns an empty list when nothing failed', () => {
    const path = writeReport('green.json', {
      reportVersion: REPORT_VERSION,
      results: [{ ru: 'a', outcome: 'pr-created' }],
    });
    assert.deepEqual(readFailedRus(path), []);
  });

  it('throws a clear error for a missing file', () => {
    assert.throws(() => readFailedRus(join(dir, 'nope.json')), /cannot read report file/);
  });

  it('throws a clear error for invalid JSON', () => {
    const path = writeReport('broken.json', '{ not json');
    assert.throws(() => readFailedRus(path), /not valid JSON/);
  });

  it('throws a clear error when the results array is missing', () => {
    const path = writeReport('shape.json', { foo: 'bar' });
    assert.throws(() => readFailedRus(path), /missing "results" array/);
  });

  it('rejects a newer report version instead of misreading it', () => {
    const path = writeReport('future.json', {
      reportVersion: REPORT_VERSION + 1,
      results: [{ ru: 'a', outcome: 'pr-failed' }],
    });
    assert.throws(() => readFailedRus(path), /newer than supported/);
  });

  it('ignores malformed entries defensively', () => {
    const path = writeReport('mixed.json', {
      reportVersion: REPORT_VERSION,
      results: [{ ru: 42, outcome: 'pr-failed' }, { outcome: 'pr-failed' }, { ru: 'ok', outcome: 'pr-failed' }, null],
    });
    assert.deepEqual(readFailedRus(path), ['ok']);
  });
});

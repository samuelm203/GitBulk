/**
 * Unit-Tests für core/report-file.ts (`--report out.json`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunReport, writeRunReport, REPORT_VERSION } from '../../src/core/report-file.js';
import { GitBulkConfigSchema } from '../../src/config/schema.js';
import type { RunSummary } from '../../src/core/runner.js';

const config = GitBulkConfigSchema.parse({
  rus: ['repo-a', 'repo-b'],
  ticket: 'AKB-1',
  branch: 'feature/x',
  operations: [{ type: 'delete-file', path: 'x.txt' }],
  commitMessage: 'm',
  prSummary: 's',
  createPrOnError: false,
  prPlatform: 'github',
  github: { owner: 'me' },
});

function summary(): RunSummary {
  return {
    results: [
      {
        ru: 'repo-a',
        phase3: {
          ru: 'repo-a',
          processed: true,
          prStatus: 'create_PR',
          featureBranch: 'AKB-1-feature/x',
          notes: ['note-3'],
          cleanupOk: true,
        },
        phase4: {
          ru: 'repo-a',
          apiCalled: true,
          success: true,
          prId: 42,
          prUrl: 'https://x/42',
          prUpdated: true,
          notes: ['note-4'],
        },
        outcome: 'pr-created',
        durationMs: 234,
      },
      {
        ru: 'repo-b',
        phase3: {
          ru: 'repo-b',
          processed: true,
          prStatus: 'create_PR',
          featureBranch: 'AKB-1-feature/x',
          notes: [],
          cleanupOk: true,
        },
        phase4: {
          ru: 'repo-b',
          apiCalled: true,
          success: false,
          error: 'HTTP 500',
          notes: [],
        },
        outcome: 'pr-failed',
        durationMs: 120,
      },
    ],
    totals: { rus: 2, prsCreated: 1, prsSkipped: 0, prsFailed: 1, notProcessed: 0, fatalErrors: 0 },
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    totalDurationMs: 1000,
  };
}

describe('buildRunReport', () => {
  it('captures metadata, totals and flat per-RU entries', () => {
    const report = buildRunReport(config, summary(), 1);

    assert.equal(report.reportVersion, REPORT_VERSION);
    assert.equal(report.dryRun, false);
    assert.equal(report.prPlatform, 'github');
    assert.equal(report.ticket, 'AKB-1');
    assert.equal(report.branch, 'feature/x');
    assert.equal(report.exitCode, 1);
    assert.equal(report.totals.prsFailed, 1);

    assert.equal(report.results.length, 2);
    const a = report.results[0]!;
    assert.equal(a.ru, 'repo-a');
    assert.equal(a.outcome, 'pr-created');
    assert.equal(a.prId, 42);
    assert.equal(a.prUrl, 'https://x/42');
    assert.equal(a.prUpdated, true);
    assert.deepEqual(a.notes, ['note-3', 'note-4']);

    const b = report.results[1]!;
    assert.equal(b.outcome, 'pr-failed');
    assert.equal(b.error, 'HTTP 500');
    assert.equal(b.prId, undefined);
  });

  it('never contains token-like data', () => {
    const json = JSON.stringify(buildRunReport(config, summary(), 0));
    assert.doesNotMatch(json, /token/i);
  });
});

describe('writeRunReport', () => {
  it('writes pretty-printed JSON that round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-report-'));
    try {
      const path = join(dir, 'out.json');
      const report = buildRunReport(config, summary(), 2);
      writeRunReport(path, report);

      const raw = readFileSync(path, 'utf8');
      assert.ok(raw.endsWith('\n'));
      const parsed = JSON.parse(raw) as typeof report;
      assert.equal(parsed.exitCode, 2);
      assert.equal(parsed.results.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Unit-Tests für core/reporter.ts.
 *
 * Capturt stdout, um die Tabellen-Ausgabe zu verifizieren.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { printRunSummary } from '../../src/core/reporter.js';
import type { RunSummary } from '../../src/core/runner.js';

/**
 * Capturt stdout für die Dauer eines Aufrufs.
 */
function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return captured;
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    results: [],
    totals: { rus: 0, prsCreated: 0, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
    startedAt: '2025-01-01T00:00:00Z',
    finishedAt: '2025-01-01T00:00:01Z',
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('printRunSummary', () => {
  it('prints header and totals for empty run', () => {
    const out = captureStdout(() => printRunSummary(summary(), { noColor: true }));
    assert.match(out, /GitBulk Run Summary/);
    assert.match(out, /Total: 0 RUs/);
  });

  it('shows pr-created with PR ID', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-a',
              phase3: {
                ru: 'repo-a',
                processed: true,
                prStatus: 'create_PR',
                featureBranch: 'AKB-1-f',
                notes: [],
                cleanupOk: true,
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: true,
                success: true,
                prId: 42,
                prUrl: 'https://x.com/42',
                notes: [],
              },
              outcome: 'pr-created',
              durationMs: 234,
            },
          ],
          totals: { rus: 1, prsCreated: 1, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /repo-a/);
    assert.match(out, /PR created/);
    assert.match(out, /PR #42/);
    assert.match(out, /Created PRs:/);
    assert.match(out, /https:\/\/x\.com\/42/);
  });

  it('shows error detail for pr-failed', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-a',
              phase3: {
                ru: 'repo-a',
                processed: true,
                prStatus: 'create_PR',
                featureBranch: 'AKB-1-f',
                notes: [],
                cleanupOk: true,
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: true,
                success: false,
                error: 'HTTP 401: unauthorized',
                notes: [],
              },
              outcome: 'pr-failed',
              durationMs: 100,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 0, prsFailed: 1, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /PR failed/);
    assert.match(out, /unauthorized/);
  });

  it('formats durations under 1s as ms', () => {
    const out = captureStdout(() =>
      printRunSummary(summary({ totalDurationMs: 750 }), { noColor: true }),
    );
    assert.match(out, /750ms/);
  });

  it('formats durations 1s-60s as seconds', () => {
    const out = captureStdout(() =>
      printRunSummary(summary({ totalDurationMs: 5500 }), { noColor: true }),
    );
    assert.match(out, /5\.5s/);
  });

  it('formats durations over 1m as minutes', () => {
    const out = captureStdout(() =>
      printRunSummary(summary({ totalDurationMs: 65_500 }), { noColor: true }),
    );
    assert.match(out, /1m05s/);
  });
});

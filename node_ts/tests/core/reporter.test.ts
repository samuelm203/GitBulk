/**
 * Unit-Tests für core/reporter.ts.
 *
 * Capturt stdout, um die Tabellen-Ausgabe zu verifizieren.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

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

  it('labels an updated PR as "PR updated" with (updated) markers', () => {
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
                prUpdated: true,
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
    assert.match(out, /PR updated/);
    assert.doesNotMatch(out, /PR created/);
    assert.match(out, /PR #42 \(updated\)/);
    assert.match(out, /1 created \(1 updated\)/);
    assert.match(out, /https:\/\/x\.com\/42 \(updated\)/);
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

  it('shows error detail for fatal-error', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-a',
              phase3: {
                ru: 'repo-a',
                processed: false,
                prStatus: 'empty',
                fatalError: 'Clone failed: network timeout',
                featureBranch: '',
                notes: [],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'fatal-error',
              durationMs: 234,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 1 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /fatal error/);
    assert.match(out, /Clone failed: network timeout/);
    assert.match(out, /1 fatal/);
  });

  it('shows error detail for pr-failed without prId', () => {
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
                error: 'API rate limit exceeded',
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
    assert.match(out, /API rate limit exceeded/);
  });

  it('shows pr-skipped status', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-a',
              phase3: {
                ru: 'repo-a',
                processed: false,
                prStatus: 'empty',
                featureBranch: '',
                notes: ['Repository is archived'],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'pr-skipped',
              durationMs: 50,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 1, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /skipped/);
    assert.match(out, /Repository is archived/);
    assert.match(out, /1 skipped/);
  });

  it('shows not-processed status', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-b',
              phase3: {
                ru: 'repo-b',
                processed: false,
                prStatus: 'empty',
                featureBranch: '',
                notes: ['Already has changes'],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-b',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'not-processed',
              durationMs: 30,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 0, prsFailed: 0, notProcessed: 1, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /not processed/);
    assert.match(out, /Already has changes/);
    assert.match(out, /1 not processed/);
  });

  it('truncates long detail strings', () => {
    const longError =
      'This is a very long error message that exceeds the detail column width and should be truncated with an ellipsis character';
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
                error: longError,
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
    assert.match(out, /…/);
  });

  it('shows multiple results with mixed outcomes', () => {
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
                prId: 10,
                prUrl: 'https://github.com/org/repo-a/pull/10',
                notes: [],
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
                featureBranch: 'AKB-1-f',
                notes: [],
                cleanupOk: true,
              },
              phase4: {
                ru: 'repo-b',
                apiCalled: true,
                success: false,
                error: 'Unauthorized',
                notes: [],
              },
              outcome: 'pr-failed',
              durationMs: 100,
            },
            {
              ru: 'repo-c',
              phase3: {
                ru: 'repo-c',
                processed: false,
                prStatus: 'empty',
                featureBranch: '',
                notes: ['Skipped'],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-c',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'pr-skipped',
              durationMs: 50,
            },
          ],
          totals: { rus: 3, prsCreated: 1, prsSkipped: 1, prsFailed: 1, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /repo-a/);
    assert.match(out, /repo-b/);
    assert.match(out, /repo-c/);
    assert.match(out, /Total: 3 RUs/);
    assert.match(out, /1 created, 1 skipped, 1 failed/);
  });

  it('uses color when enabled', () => {
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
                error: 'Connection timeout',
                notes: [],
              },
              outcome: 'pr-failed',
              durationMs: 234,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 0, prsFailed: 1, notProcessed: 0, fatalErrors: 0 },
        }),
      ),
    );
    // When color is enabled, output should still contain the data
    assert.match(out, /repo-a/);
    assert.match(out, /PR failed/);
    assert.match(out, /Connection timeout/);
  });

  it('handles pr-created output with ANSI color codes', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-xyz',
              phase3: {
                ru: 'repo-xyz',
                processed: true,
                prStatus: 'create_PR',
                featureBranch: 'TICKET-5-feature',
                notes: [],
                cleanupOk: true,
              },
              phase4: {
                ru: 'repo-xyz',
                apiCalled: true,
                success: true,
                prId: 123,
                prUrl: 'https://bitbucket.org/team/repo-xyz/pullrequests/123',
                notes: [],
              },
              outcome: 'pr-created',
              durationMs: 567,
            },
          ],
          totals: { rus: 1, prsCreated: 1, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
        }),
      ),
    );
    assert.match(out, /repo-xyz/);
    assert.match(out, /PR created/);
    assert.match(out, /PR #123/);
  });

  it('handles very large RU names', () => {
    const longRuName = 'org-with-very-long-repository-name-that-exceeds-normal-widths';
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: longRuName,
              phase3: {
                ru: longRuName,
                processed: true,
                prStatus: 'create_PR',
                featureBranch: 'feature',
                notes: [],
                cleanupOk: true,
              },
              phase4: {
                ru: longRuName,
                apiCalled: true,
                success: true,
                prId: 1,
                prUrl: 'https://example.com/pr/1',
                notes: [],
              },
              outcome: 'pr-created',
              durationMs: 100,
            },
          ],
          totals: { rus: 1, prsCreated: 1, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, new RegExp(longRuName));
  });

  it('handles pr-skipped with note details', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-archived',
              phase3: {
                ru: 'repo-archived',
                processed: false,
                prStatus: 'empty',
                featureBranch: '',
                notes: ['Repository is archived, skipping'],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-archived',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'pr-skipped',
              durationMs: 25,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 1, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /repo-archived/);
    assert.match(out, /skipped/);
    assert.match(out, /Repository is archived/);
  });

  it('handles fatal-error with no fatalError message', () => {
    const out = captureStdout(() =>
      printRunSummary(
        summary({
          results: [
            {
              ru: 'repo-a',
              phase3: {
                ru: 'repo-a',
                processed: false,
                prStatus: 'empty',
                featureBranch: '',
                notes: [],
                cleanupOk: false,
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: false,
                success: false,
                notes: [],
              },
              outcome: 'fatal-error',
              durationMs: 100,
            },
          ],
          totals: { rus: 1, prsCreated: 0, prsSkipped: 0, prsFailed: 0, notProcessed: 0, fatalErrors: 1 },
        }),
        { noColor: true },
      ),
    );
    assert.match(out, /fatal error/);
    assert.match(out, /\(no details\)/);
  });

  it('handles pr-failed with no error message in phase4', () => {
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
                fatalError: 'Some phase3 error',
              },
              phase4: {
                ru: 'repo-a',
                apiCalled: true,
                success: false,
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
    assert.match(out, /Some phase3 error/);
  });
});

/**
 * Unit-Tests für core/runner.ts.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { runBulk } from '../../src/core/runner.js';
import type {
  CreatePrInput,
  CreatePrResult,
  PullRequestAdapter,
} from '../../src/git/pr-adapter.js';
import type { GitBulkConfig } from '../../src/config/schema.js';
import { setDefaultLogger, createLogger } from '../../src/utils/logger.js';
import {
  createWorkspace,
  cleanup,
  setupRu,
  writeShellScript,
} from '../helpers/git-fixtures.js';

before(() => {
  setDefaultLogger(createLogger({ level: 'error', timestamps: false, noColor: true }));
});

class MockAdapter implements PullRequestAdapter {
  public readonly platformName = 'mock';
  public calls: CreatePrInput[] = [];
  public failNext = false;

  async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    this.calls.push(input);
    if (this.failNext) {
      return { ok: false, statusCode: 401, error: 'mock unauthorized' };
    }
    return {
      ok: true,
      id: this.calls.length,
      url: `mock://pr/${this.calls.length}`,
      statusCode: 201,
    };
  }
}

function makeConfig(
  workspace: string,
  scriptPath: string,
  overrides: Partial<GitBulkConfig> = {},
): GitBulkConfig {
  return {
    rus: ['repo-a'],
    ticket: 'AKB-1',
    branch: 'feature/x',
    script: scriptPath,
    commitMessage: 'feat: x',
    prSummary: 'PR',
    createPrOnError: false,
    cloneIfMissing: false,
    sourceBranch: 'master',
    workspaceDir: workspace,
    retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 5 },
    concurrency: 1,
    commandTimeoutMs: 10_000,
    dryRun: false,
    skipHooks: false,
    prPlatform: 'bitbucket',
    bitbucket: {
      workspace: 'ws',
      apiVariant: 'cloud',
      targetBranch: 'master',
      reviewers: [],
    },
    ...overrides,
  } as GitBulkConfig;
}

describe('runBulk', () => {
  it('processes multiple RUs sequentially and creates PRs', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      setupRu(ws, 'r2');
      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const adapter = new MockAdapter();

      const summary = await runBulk(makeConfig(ws, script, { rus: ['r1', 'r2'] }), {
        prAdapter: adapter,
      });

      assert.equal(summary.totals.prsCreated, 2);
      assert.equal(summary.totals.rus, 2);
      assert.equal(adapter.calls.length, 2);
      assert.equal(summary.results[0]!.outcome, 'pr-created');
      assert.equal(summary.results[1]!.outcome, 'pr-created');
    } finally {
      cleanup(ws);
    }
  });

  it('handles mixed outcomes correctly', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      setupRu(ws, 'r2');
      // r3 does not exist → not-processed
      const script = writeShellScript(
        ws,
        // Only r1 modifies → r2 ends up skipped
        `if [ "$GITBULK_RU" = "r1" ]; then echo "x" > new.txt; fi`,
      );
      const adapter = new MockAdapter();

      const summary = await runBulk(
        makeConfig(ws, script, { rus: ['r1', 'r2', 'r3'] }),
        { prAdapter: adapter },
      );

      assert.equal(summary.totals.prsCreated, 1);
      assert.equal(summary.totals.prsSkipped, 1);
      assert.equal(summary.totals.notProcessed, 1);
      assert.equal(adapter.calls.length, 1);
    } finally {
      cleanup(ws);
    }
  });

  it('classifies PR API failures as pr-failed', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const adapter = new MockAdapter();
      adapter.failNext = true;

      const summary = await runBulk(makeConfig(ws, script, { rus: ['r1'] }), {
        prAdapter: adapter,
      });

      assert.equal(summary.totals.prsFailed, 1);
      assert.equal(summary.results[0]!.outcome, 'pr-failed');
    } finally {
      cleanup(ws);
    }
  });

  it('supports parallel processing with concurrency > 1', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      setupRu(ws, 'r2');
      setupRu(ws, 'r3');
      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const adapter = new MockAdapter();

      const summary = await runBulk(
        makeConfig(ws, script, { rus: ['r1', 'r2', 'r3'], concurrency: 3 }),
        { prAdapter: adapter },
      );

      assert.equal(summary.totals.prsCreated, 3);
    } finally {
      cleanup(ws);
    }
  });

  it('dry-run does not call adapter', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const adapter = new MockAdapter();

      const summary = await runBulk(makeConfig(ws, script, { dryRun: true, rus: ['r1'] }), {
        prAdapter: adapter,
      });

      assert.equal(adapter.calls.length, 0);
      // In dry-run, the result is classified as skipped (no API call made)
      assert.equal(summary.totals.prsSkipped, 1);
    } finally {
      cleanup(ws);
    }
  });

  it('RunSummary includes timestamps and durations', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      const script = writeShellScript(ws, 'echo "x" > new.txt');

      const summary = await runBulk(makeConfig(ws, script, { rus: ['r1'] }), {
        prAdapter: new MockAdapter(),
      });

      assert.ok(summary.startedAt);
      assert.ok(summary.finishedAt);
      assert.ok(summary.totalDurationMs >= 0);
      assert.ok(summary.results[0]!.durationMs >= 0);
    } finally {
      cleanup(ws);
    }
  });

  it('aborts gracefully when signal fires', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'r1');
      setupRu(ws, 'r2');
      const script = writeShellScript(ws, 'echo "x" > new.txt');

      const controller = new AbortController();
      controller.abort(); // abort immediately

      const summary = await runBulk(
        makeConfig(ws, script, { rus: ['r1', 'r2'] }),
        { prAdapter: new MockAdapter(), signal: controller.signal },
      );

      assert.equal(summary.totals.notProcessed, 2);
    } finally {
      cleanup(ws);
    }
  });
});

/**
 * Unit-Tests für git/phase4.ts.
 * Verwendet einen In-Memory-Mock-Adapter (kein HTTP).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runPhase4 } from '../../src/git/phase4.js';
import type {
  CreatePrInput,
  CreatePrResult,
  PullRequestAdapter,
} from '../../src/git/pr-adapter.js';
import type { Phase3Result } from '../../src/git/phase3.js';
import type { GitBulkConfig } from '../../src/config/schema.js';
import { setDefaultLogger, createLogger } from '../../src/utils/logger.js';

setDefaultLogger(createLogger({ level: 'error', timestamps: false, noColor: true }));

/**
 * Minimal-Mock-Adapter, der über `enqueue()` definierte Antworten liefert.
 */
class MockAdapter implements PullRequestAdapter {
  public readonly platformName = 'mock';
  public calls: CreatePrInput[] = [];
  public queue: CreatePrResult[] = [];

  async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next) return next;
    return { ok: true, id: this.calls.length, url: `mock://pr/${this.calls.length}`, statusCode: 201 };
  }
}

function makePhase3(overrides: Partial<Phase3Result> = {}): Phase3Result {
  return {
    ru: 'repo-a',
    processed: true,
    prStatus: 'create_PR',
    featureBranch: 'AKB-1-feature/x',
    notes: [],
    cleanupOk: true,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GitBulkConfig> = {}): GitBulkConfig {
  return {
    rus: ['repo-a'],
    ticket: 'AKB-1',
    branch: 'feature/x',
    script: '/tmp/x.sh',
    commitMessage: 'm',
    prSummary: 'PR summary',
    createPrOnError: false,
    cloneIfMissing: false,
    sourceBranch: 'master',
    retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 },
    concurrency: 1,
    commandTimeoutMs: 5000,
    dryRun: false,
    skipHooks: false,
    prPlatform: 'bitbucket',
    bitbucket: { workspace: 'ws', apiVariant: 'cloud', targetBranch: 'master', reviewers: [] },
    ...overrides,
  } as GitBulkConfig;
}

let adapter: MockAdapter;

beforeEach(() => {
  adapter = new MockAdapter();
});

describe('Phase 4 - prStatus routing', () => {
  it('skips API call when prStatus=empty', async () => {
    const result = await runPhase4(makePhase3({ prStatus: 'empty' }), makeConfig(), adapter);
    assert.equal(result.apiCalled, false);
    assert.equal(adapter.calls.length, 0);
    assert.ok(result.notes.some((n) => n.startsWith('No PR')));
  });

  it('skips PR_with_Error when createPrOnError=false', async () => {
    const result = await runPhase4(
      makePhase3({ prStatus: 'create_PR_with_Error' }),
      makeConfig({ createPrOnError: false }),
      adapter,
    );
    assert.equal(result.apiCalled, false);
    assert.ok(result.notes.some((n) => n.includes('PR Skip')));
  });

  it('creates PR for create_PR with [ERROR] prefix when createPrOnError=true', async () => {
    const result = await runPhase4(
      makePhase3({ prStatus: 'create_PR_with_Error' }),
      makeConfig({ createPrOnError: true }),
      adapter,
    );
    assert.equal(result.apiCalled, true);
    assert.equal(result.success, true);
    assert.match(adapter.calls[0]!.title, /^\[ERROR\]/);
  });

  it('creates normal PR for create_PR', async () => {
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.apiCalled, true);
    assert.equal(result.success, true);
    assert.equal(adapter.calls[0]!.title, 'PR summary');
  });
});

describe('Phase 4 - Dry-run', () => {
  it('does not call adapter when dryRun=true', async () => {
    const result = await runPhase4(makePhase3(), makeConfig({ dryRun: true }), adapter);
    assert.equal(result.apiCalled, false);
    assert.equal(result.success, true);
    assert.equal(adapter.calls.length, 0);
  });
});

describe('Phase 4 - Retry behavior', () => {
  it('retries on transient 5xx and eventually succeeds', async () => {
    adapter.queue.push(
      { ok: false, statusCode: 503, error: 'down' },
      { ok: false, statusCode: 502, error: 'gateway' },
      { ok: true, id: 99, url: 'mock://99', statusCode: 201 },
    );
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.success, true);
    assert.equal(adapter.calls.length, 3);
    assert.equal(result.prId, 99);
  });

  it('stops immediately on permanent 4xx (no retry)', async () => {
    adapter.queue.push({ ok: false, statusCode: 401, error: 'unauthorized' });
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.success, false);
    assert.equal(adapter.calls.length, 1);
    assert.match(result.error ?? '', /unauthorized/);
  });

  it('retries on 429 (rate limit)', async () => {
    adapter.queue.push(
      { ok: false, statusCode: 429, error: 'rate limit' },
      { ok: true, id: 7, url: 'mock://7', statusCode: 201 },
    );
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.success, true);
    assert.equal(adapter.calls.length, 2);
  });

  it('retries on network error (statusCode 0)', async () => {
    adapter.queue.push(
      { ok: false, statusCode: 0, error: 'network error' },
      { ok: true, id: 1, url: 'mock://1', statusCode: 201 },
    );
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.success, true);
    assert.equal(adapter.calls.length, 2);
  });

  it('reports PR failed [API] note on exhausted retries', async () => {
    for (let i = 0; i < 5; i++) {
      adapter.queue.push({ ok: false, statusCode: 503, error: 'down' });
    }
    const result = await runPhase4(makePhase3(), makeConfig(), adapter);
    assert.equal(result.success, false);
    assert.ok(result.notes.some((n) => n.includes('PR failed [API]')));
  });
});

describe('Phase 4 - Reviewer + target branch routing', () => {
  it('passes target branch from bitbucket config', async () => {
    const cfg = makeConfig({
      bitbucket: {
        workspace: 'ws',
        apiVariant: 'cloud',
        targetBranch: 'develop',
        reviewers: ['r1'],
      },
    });
    await runPhase4(makePhase3(), cfg, adapter);
    assert.equal(adapter.calls[0]!.targetBranch, 'develop');
    assert.deepEqual([...adapter.calls[0]!.reviewers], ['r1']);
  });

  it('passes target branch and reviewers from github config (not sourceBranch)', async () => {
    // Regression: github fiel früher in den default-Zweig → targetBranch wurde
    // fälschlich sourceBranch ('master') und reviewers wurden verworfen.
    const cfg = makeConfig({
      prPlatform: 'github',
      sourceBranch: 'master',
      github: { owner: 'org', targetBranch: 'main', reviewers: ['octocat', 'hubot'] },
    });
    await runPhase4(makePhase3(), cfg, adapter);
    assert.equal(adapter.calls[0]!.targetBranch, 'main');
    assert.deepEqual([...adapter.calls[0]!.reviewers], ['octocat', 'hubot']);
  });
});

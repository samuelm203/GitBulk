/**
 * Tests für die PR-Status-Abfrage:
 *   - `getPullRequestStatus` der Bitbucket-/GitHub-Adapter (gegen HTTP-Mock)
 *   - `collectPrStatus` (Aggregation, Branch-Ableitung, Workspace-Override)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { BitbucketPrAdapter } from '../../src/git/pr-bitbucket.js';
import { GitHubPrAdapter } from '../../src/git/pr-github.js';
import {
  collectPrStatus,
  adapterSupportsStatus,
} from '../../src/git/pr-status.js';
import type {
  CreatePrResult,
  PrLookupInput,
  PrStatusInfo,
  PullRequestAdapter,
} from '../../src/git/pr-adapter.js';
import type { GitBulkConfig, RuSpec } from '../../src/config/schema.js';
import { startMockServer, type MockServer } from '../helpers/http-mock.js';
import { createLogger } from '../../src/utils/logger.js';

const silentLogger = createLogger({ level: 'error', timestamps: false, noColor: true });

let mock: MockServer;

before(async () => {
  mock = await startMockServer();
});

after(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.requests.length = 0;
  mock.clearRoutes();
  mock.setDefault({ status: 200, body: {} });
});

const lookup: PrLookupInput = { ru: 'repo-a', sourceBranch: 'AKB-1-feature/x' };

// ── Bitbucket Cloud ──────────────────────────────────────────────
function bbCloud() {
  return new BitbucketPrAdapter(
    { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
    'bb-token',
    silentLogger,
  );
}

describe('BitbucketPrAdapter.getPullRequestStatus (cloud)', () => {
  it('maps OPEN → open and returns id + url', async () => {
    mock.enqueue({
      status: 200,
      body: { values: [{ id: 5, state: 'OPEN', links: { html: { href: 'https://bb/pr/5' } } }] },
    });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.equal(info.id, 5);
    assert.equal(info.url, 'https://bb/pr/5');
    // Query fragt nach dem Source-Branch über ALLE States (kein &state=OPEN).
    assert.match(mock.requests[0]!.url, /source\.branch\.name/);
    assert.doesNotMatch(mock.requests[0]!.url, /state=OPEN/);
  });

  it('maps MERGED → merged', async () => {
    mock.enqueue({ status: 200, body: { values: [{ id: 6, state: 'MERGED' }] } });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'merged');
  });

  it('maps DECLINED → declined', async () => {
    mock.enqueue({ status: 200, body: { values: [{ id: 7, state: 'DECLINED' }] } });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'declined');
  });

  it('returns none when no PR matches', async () => {
    mock.enqueue({ status: 200, body: { values: [] } });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'none');
    assert.equal(info.id, undefined);
  });

  it('reports an API error (non-200) without throwing', async () => {
    mock.enqueue({ status: 500, body: {} });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'none');
    assert.match(info.error ?? '', /HTTP 500/);
  });
});

// ── Bitbucket Server ─────────────────────────────────────────────
describe('BitbucketPrAdapter.getPullRequestStatus (server)', () => {
  it('uses state=ALL and maps the result', async () => {
    const adapter = new BitbucketPrAdapter(
      { workspace: 'PROJ', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'pat',
      silentLogger,
    );
    mock.enqueue({
      status: 200,
      body: { values: [{ id: 9, state: 'OPEN', links: { self: [{ href: 'https://srv/pr/9' }] } }] },
    });
    const info = await adapter.getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.equal(info.id, 9);
    assert.equal(info.url, 'https://srv/pr/9');
    assert.match(mock.requests[0]!.url, /state=ALL/);
    assert.match(mock.requests[0]!.url, /pull-requests/);
  });
});

// ── GitHub ───────────────────────────────────────────────────────
function gh() {
  return new GitHubPrAdapter(
    { owner: 'org', apiBaseUrl: mock.baseUrl, targetBranch: 'main', reviewers: [] },
    'gh-token',
    silentLogger,
  );
}

describe('GitHubPrAdapter.getPullRequestStatus', () => {
  it('maps open → open', async () => {
    mock.enqueue({ status: 200, body: [{ number: 1, state: 'open', html_url: 'https://gh/pr/1' }] });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.equal(info.id, 1);
    assert.equal(info.url, 'https://gh/pr/1');
    assert.match(mock.requests[0]!.url, /state=all/);
  });

  it('maps closed + merged_at → merged', async () => {
    mock.enqueue({
      status: 200,
      body: [{ number: 2, state: 'closed', merged_at: '2020-01-01T00:00:00Z', html_url: 'u' }],
    });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'merged');
  });

  it('maps closed without merged_at → declined', async () => {
    mock.enqueue({ status: 200, body: [{ number: 3, state: 'closed', merged_at: null, html_url: 'u' }] });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'declined');
  });

  it('returns none for an empty array', async () => {
    mock.enqueue({ status: 200, body: [] });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'none');
  });
});

// ── v2: Approvals + CI-Rollup (best-effort, parallele Calls → Routing) ──
describe('getPullRequestStatus enrichment (approvals + CI)', () => {
  it('GitHub: counts latest-per-user approvals and rolls up check-runs', async () => {
    mock.route('/pulls?', { status: 200, body: [{ number: 1, state: 'open', html_url: 'o', head: { sha: 'sha1' } }] });
    mock.route('/pulls/1/reviews', {
      status: 200,
      body: [
        { user: { login: 'a' }, state: 'COMMENTED' },
        { user: { login: 'a' }, state: 'APPROVED' }, // jüngstes Review von a gewinnt
        { user: { login: 'b' }, state: 'APPROVED' },
        { user: { login: 'c' }, state: 'CHANGES_REQUESTED' },
      ],
    });
    mock.route('/commits/sha1/check-runs', {
      status: 200,
      body: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
    });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.deepEqual(info.approvals, { approved: 2 });
    assert.equal(info.ci, 'passed');
  });

  it('GitHub: a failing check-run wins the rollup', async () => {
    mock.route('/pulls?', { status: 200, body: [{ number: 2, state: 'open', html_url: 'o', head: { sha: 'sha2' } }] });
    mock.route('/commits/sha2/check-runs', {
      status: 200,
      body: { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] },
    });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.ci, 'failed');
  });

  it('GitHub: enrichment failure does not flag the row as error', async () => {
    mock.route('/pulls?', { status: 200, body: [{ number: 3, state: 'open', html_url: 'o', head: { sha: 'sha3' } }] });
    mock.route('/pulls/3/reviews', { status: 500, body: {} });
    mock.route('/commits/sha3/check-runs', { status: 500, body: {} });
    const info = await gh().getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.equal(info.error, undefined);
    assert.equal(info.approvals, undefined);
    assert.equal(info.ci, undefined);
  });

  it('Bitbucket Cloud: approvals from PR detail + statuses rollup', async () => {
    mock.route('/pullrequests?', {
      status: 200,
      body: { values: [{ id: 5, state: 'OPEN', links: { html: { href: 'u' } }, source: { commit: { hash: 'abc' } } }] },
    });
    mock.route('/pullrequests/5', {
      status: 200,
      body: { participants: [{ role: 'REVIEWER', approved: true }, { role: 'REVIEWER', approved: false }, { role: 'PARTICIPANT', approved: true }] },
    });
    mock.route('/commit/abc/statuses', { status: 200, body: { values: [{ state: 'SUCCESSFUL' }] } });
    const info = await bbCloud().getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.deepEqual(info.approvals, { approved: 2, required: 2 });
    assert.equal(info.ci, 'passed');
  });

  it('Bitbucket Server: approvals from list reviewers + build-status running', async () => {
    const adapter = new BitbucketPrAdapter(
      { workspace: 'PROJ', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'pat',
      silentLogger,
    );
    mock.route('/pull-requests?', {
      status: 200,
      body: {
        values: [{
          id: 9, state: 'OPEN', links: { self: [{ href: 'su' }] },
          fromRef: { latestCommit: 'def' },
          reviewers: [{ approved: true }, { approved: false }, { approved: true }],
        }],
      },
    });
    mock.route('/build-status/1.0/commits/def', { status: 200, body: { values: [{ state: 'INPROGRESS' }] } });
    const info = await adapter.getPullRequestStatus(lookup);
    assert.equal(info.state, 'open');
    assert.deepEqual(info.approvals, { approved: 2, required: 3 });
    assert.equal(info.ci, 'running');
  });
});

// ── collectPrStatus (In-Memory-Mock-Adapter) ─────────────────────
class MockStatusAdapter implements PullRequestAdapter {
  public readonly platformName = 'mock';
  public calls: PrLookupInput[] = [];
  constructor(private readonly byRepo: Record<string, PrStatusInfo>) {}
  async createPullRequest(): Promise<CreatePrResult> {
    return { ok: false, statusCode: 0, error: 'not used in status tests' };
  }
  async getPullRequestStatus(input: PrLookupInput): Promise<PrStatusInfo> {
    this.calls.push(input);
    return this.byRepo[input.ru] ?? { state: 'none' };
  }
}

function makeConfig(rus: RuSpec[], overrides: Partial<GitBulkConfig> = {}): GitBulkConfig {
  return {
    rus,
    ticket: 'AKB-1',
    branch: 'feature/x',
    concurrency: 2,
    prPlatform: 'bitbucket',
    ...overrides,
  } as GitBulkConfig;
}

describe('collectPrStatus', () => {
  it('derives <ticket>-<branch> as the source branch for every lookup', async () => {
    const adapter = new MockStatusAdapter({ 'repo-a': { state: 'open', id: 1 } });
    const report = await collectPrStatus(makeConfig([{ repo: 'repo-a' }]), adapter);
    assert.equal(report.sourceBranch, 'AKB-1-feature/x');
    assert.equal(adapter.calls[0]!.sourceBranch, 'AKB-1-feature/x');
    assert.equal(report.platform, 'mock');
  });

  it('passes a per-RU workspace override into the lookup', async () => {
    const adapter = new MockStatusAdapter({});
    await collectPrStatus(
      makeConfig([{ repo: 'repo-a', workspace: 'ws-2' }, { repo: 'repo-b' }]),
      adapter,
    );
    const a = adapter.calls.find((c) => c.ru === 'repo-a')!;
    const b = adapter.calls.find((c) => c.ru === 'repo-b')!;
    assert.equal(a.workspace, 'ws-2');
    assert.equal(b.workspace, undefined);
  });

  it('aggregates totals and counts errors separately from none', async () => {
    const adapter = new MockStatusAdapter({
      'r-open': { state: 'open', id: 1 },
      'r-merged': { state: 'merged', id: 2 },
      'r-declined': { state: 'declined', id: 3 },
      'r-none': { state: 'none' },
      'r-error': { state: 'none', error: 'boom' },
    });
    const report = await collectPrStatus(
      makeConfig([
        { repo: 'r-open' },
        { repo: 'r-merged' },
        { repo: 'r-declined' },
        { repo: 'r-none' },
        { repo: 'r-error' },
      ]),
      adapter,
    );
    assert.deepEqual(report.totals, { open: 1, merged: 1, declined: 1, none: 1, errored: 1 });
    // Reihenfolge bleibt config-stabil.
    assert.deepEqual(report.results.map((r) => r.ru), [
      'r-open', 'r-merged', 'r-declined', 'r-none', 'r-error',
    ]);
  });
});

describe('adapterSupportsStatus', () => {
  it('is true for an adapter with getPullRequestStatus, false without', () => {
    const withStatus = new MockStatusAdapter({});
    const withoutStatus: PullRequestAdapter = {
      platformName: 'x',
      async createPullRequest() {
        return { ok: false, statusCode: 0, error: 'n/a' };
      },
    };
    assert.equal(adapterSupportsStatus(withStatus), true);
    assert.equal(adapterSupportsStatus(withoutStatus), false);
  });
});

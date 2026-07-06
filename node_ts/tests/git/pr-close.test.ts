/**
 * Tests für `gitbulk close`:
 *   - Orchestrierung (git/pr-close.ts) mit Fake-Adapter + echten Git-Fixtures
 *     (Remote-Branch wird wirklich gelöscht).
 *   - closePullRequest der vier Adapter gegen den lokalen HTTP-Mock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

import {
  closePullRequests,
  adapterSupportsClose,
  type CloseCapableAdapter,
} from '../../src/git/pr-close.js';
import type {
  ClosePrInput,
  ClosePrResult,
  PrLookupInput,
  PrStatusInfo,
  PullRequestAdapter,
} from '../../src/git/pr-adapter.js';
import { GitBulkConfigSchema, type GitBulkConfig } from '../../src/config/schema.js';
import { GitHubPrAdapter } from '../../src/git/pr-github.js';
import { GitLabPrAdapter } from '../../src/git/pr-gitlab.js';
import { AzureDevOpsPrAdapter } from '../../src/git/pr-azure.js';
import { BitbucketPrAdapter } from '../../src/git/pr-bitbucket.js';
import { createWorkspace, cleanup, setupRu } from '../helpers/git-fixtures.js';
import { startMockServer, type MockServer } from '../helpers/http-mock.js';
import { createLogger } from '../../src/utils/logger.js';

const silentLogger = createLogger({ level: 'error', timestamps: false, noColor: true });

/** Baut eine echte (geparste) Config für den Close-Flow. */
function makeConfig(workspaceDir: string, rus: string[]): GitBulkConfig {
  return GitBulkConfigSchema.parse({
    rus,
    ticket: 'AKB-1',
    branch: 'feature/x',
    operations: [{ type: 'delete-file', path: 'x.txt' }],
    commitMessage: 'm',
    prSummary: 's',
    createPrOnError: false,
    prPlatform: 'github',
    github: { owner: 'me' },
    workspaceDir,
    concurrency: 1,
  });
}

/** Fake-Adapter mit programmierbarem Status/Close-Verhalten. */
function fakeAdapter(opts: {
  status: (input: PrLookupInput) => PrStatusInfo;
  close?: (input: ClosePrInput) => ClosePrResult;
  onClose?: (input: ClosePrInput) => void;
}): CloseCapableAdapter {
  return {
    platformName: 'fake',
    createPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestStatus: (input) => Promise.resolve(opts.status(input)),
    closePullRequest: (input) => {
      opts.onClose?.(input);
      return Promise.resolve(opts.close?.(input) ?? { ok: true, statusCode: 200 });
    },
  };
}

describe('adapterSupportsClose', () => {
  it('requires both status lookup and close', () => {
    const bare: PullRequestAdapter = {
      platformName: 'x',
      createPullRequest: () => Promise.reject(new Error('n/a')),
    };
    assert.equal(adapterSupportsClose(bare), false);
    assert.equal(adapterSupportsClose(fakeAdapter({ status: () => ({ state: 'none' }) })), true);
  });
});

describe('closePullRequests (orchestration)', () => {
  it('closes an open PR and deletes the remote feature branch (real git)', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      // Feature-Branch anlegen + pushen — der soll gelöscht werden.
      execSync('git checkout -q -b "AKB-1-feature/x"', { cwd: ruPath, stdio: 'pipe' });
      execSync('git push -q origin "AKB-1-feature/x"', { cwd: ruPath, stdio: 'pipe' });
      execSync('git checkout -q master', { cwd: ruPath, stdio: 'pipe' });

      const closed: ClosePrInput[] = [];
      const adapter = fakeAdapter({
        status: () => ({ state: 'open', id: 7, url: 'http://pr/7' }),
        onClose: (input) => closed.push(input),
      });

      const report = await closePullRequests(makeConfig(ws, ['repo-a']), adapter);

      assert.equal(report.results[0]!.pr, 'closed');
      assert.equal(report.results[0]!.branch, 'deleted');
      assert.equal(closed[0]?.id, 7);
      assert.equal(report.totals.prsClosed, 1);
      assert.equal(report.totals.failed, 0);

      // Der Remote-Branch ist wirklich weg.
      const branches = execSync('git ls-remote --heads origin', { cwd: ruPath, encoding: 'utf8' });
      assert.doesNotMatch(branches, /AKB-1-feature\/x/);
    } finally {
      cleanup(ws);
    }
  });

  it('reports not-found when the remote branch never existed', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'repo-a');
      const adapter = fakeAdapter({ status: () => ({ state: 'none' }) });
      const report = await closePullRequests(makeConfig(ws, ['repo-a']), adapter);
      assert.equal(report.results[0]!.pr, 'no-open-pr');
      assert.equal(report.results[0]!.branch, 'not-found');
      assert.equal(report.totals.failed, 0);
    } finally {
      cleanup(ws);
    }
  });

  it('dry-run only reports what would happen (close is never called)', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'repo-a');
      let closeCalled = false;
      const adapter = fakeAdapter({
        status: () => ({ state: 'open', id: 1 }),
        onClose: () => {
          closeCalled = true;
        },
      });
      const report = await closePullRequests(makeConfig(ws, ['repo-a']), adapter, {
        dryRun: true,
      });
      assert.equal(closeCalled, false);
      assert.equal(report.dryRun, true);
      assert.equal(report.results[0]!.pr, 'would-close');
      assert.equal(report.results[0]!.branch, 'would-delete');
    } finally {
      cleanup(ws);
    }
  });

  it('reports repo-missing when the RU is not cloned locally', async () => {
    const ws = createWorkspace();
    try {
      const adapter = fakeAdapter({ status: () => ({ state: 'merged', id: 2 }) });
      const report = await closePullRequests(makeConfig(ws, ['ghost-repo']), adapter);
      assert.equal(report.results[0]!.pr, 'no-open-pr');
      assert.equal(report.results[0]!.branch, 'repo-missing');
    } finally {
      cleanup(ws);
    }
  });

  it('counts close failures and status errors as failed', async () => {
    const ws = createWorkspace();
    try {
      const failing = fakeAdapter({
        status: () => ({ state: 'open', id: 3 }),
        close: () => ({ ok: false, statusCode: 500, error: 'HTTP 500' }),
      });
      const r1 = await closePullRequests(makeConfig(ws, ['ghost']), failing);
      assert.equal(r1.results[0]!.pr, 'close-failed');
      assert.equal(r1.totals.failed, 1);

      const erroring = fakeAdapter({ status: () => ({ state: 'none', error: 'boom' }) });
      const r2 = await closePullRequests(makeConfig(ws, ['ghost']), erroring);
      assert.equal(r2.results[0]!.pr, 'error');
      assert.equal(r2.totals.failed, 1);
    } finally {
      cleanup(ws);
    }
  });
});

describe('adapter closePullRequest (HTTP)', () => {
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

  it('GitHub: PATCH /pulls/{id} with state=closed', async () => {
    const adapter = new GitHubPrAdapter({ owner: 'me', targetBranch: 'main', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 7 });
    assert.equal(r.ok, true);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'PATCH');
    assert.match(req.url, /\/repos\/me\/repo-a\/pulls\/7$/);
    assert.deepEqual(req.body, { state: 'closed' });
  });

  it('GitLab: PUT /merge_requests/{iid} with state_event=close', async () => {
    const adapter = new GitLabPrAdapter({ namespace: 'g', targetBranch: 'main', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 5 });
    assert.equal(r.ok, true);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'PUT');
    assert.match(req.url, /\/projects\/g%2Frepo-a\/merge_requests\/5$/);
    assert.deepEqual(req.body, { state_event: 'close' });
  });

  it('Azure: PATCH /pullrequests/{id} with status=abandoned', async () => {
    const adapter = new AzureDevOpsPrAdapter({ organization: 'o', project: 'p', targetBranch: 'main', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 9 });
    assert.equal(r.ok, true);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'PATCH');
    assert.match(req.url, /\/pullrequests\/9\?api-version=7\.1$/);
    assert.deepEqual(req.body, { status: 'abandoned' });
  });

  it('Bitbucket Cloud: POST /pullrequests/{id}/decline', async () => {
    const adapter = new BitbucketPrAdapter({ workspace: 'ws', apiVariant: 'cloud', targetBranch: 'master', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 3 });
    assert.equal(r.ok, true);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/repositories\/ws\/repo-a\/pullrequests\/3\/decline$/);
  });

  it('Bitbucket Server: fetches the PR version, then declines with it', async () => {
    mock.route('/pull-requests/3/decline', { status: 200, body: {} });
    mock.route('/pull-requests/3', { status: 200, body: { version: 4 } });

    const adapter = new BitbucketPrAdapter({ workspace: 'KEY', apiVariant: 'server', targetBranch: 'master', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 3 });
    assert.equal(r.ok, true);
    const decline = mock.requests.find((x) => x.url.includes('/decline'));
    assert.ok(decline);
    assert.match(decline.url, /\/rest\/api\/1\.0\/projects\/KEY\/repos\/repo-a\/pull-requests\/3\/decline\?version=4$/);
  });

  it('reports an HTTP failure as a result (no throw)', async () => {
    mock.setDefault({ status: 403, body: {} });
    const adapter = new GitHubPrAdapter({ owner: 'me', targetBranch: 'main', reviewers: [], apiBaseUrl: mock.baseUrl }, 't', silentLogger);
    const r = await adapter.closePullRequest({ ru: 'repo-a', sourceBranch: 'b', id: 7 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /HTTP 403/);
  });
});

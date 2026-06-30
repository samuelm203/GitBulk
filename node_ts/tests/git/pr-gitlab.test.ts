/**
 * Unit-Tests für git/pr-gitlab.ts mit lokalem HTTP-Mock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { GitLabPrAdapter } from '../../src/git/pr-gitlab.js';
import { createPrAdapter, PrAdapterError } from '../../src/git/pr-adapter.js';
import { GitBulkConfigSchema, type GitBulkConfig } from '../../src/config/schema.js';
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

function makeAdapter(reviewers: string[] = []) {
  return new GitLabPrAdapter(
    { namespace: 'my-group', apiBaseUrl: mock.baseUrl, targetBranch: 'main', reviewers },
    'glpat-token',
    silentLogger,
  );
}

const baseInput = {
  ru: 'repo-a',
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  title: 'Test MR',
  description: 'desc',
  reviewers: [] as string[],
};

describe('GitLabPrAdapter.createPullRequest', () => {
  it('posts to /projects/{ns%2Frepo}/merge_requests and returns iid + web_url', async () => {
    mock.enqueue({ status: 201, body: { iid: 7, web_url: 'https://gitlab.com/my-group/repo-a/-/merge_requests/7' } });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 7);
      assert.equal(result.url, 'https://gitlab.com/my-group/repo-a/-/merge_requests/7');
      assert.equal(result.statusCode, 201);
    }
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/projects\/my-group%2Frepo-a\/merge_requests$/);
    const body = req.body as Record<string, unknown>;
    assert.equal(body.source_branch, 'feature/x');
    assert.equal(body.target_branch, 'main');
    assert.equal(body.title, 'Test MR');
    assert.equal(body.description, 'desc');
  });

  it('sends the PRIVATE-TOKEN header', async () => {
    mock.enqueue({ status: 201, body: { iid: 1, web_url: 'u' } });
    await makeAdapter().createPullRequest(baseInput);
    assert.equal(mock.requests[0]!.headers['private-token'], 'glpat-token');
  });

  it('maps numeric reviewers to reviewer_ids and skips non-numeric', async () => {
    mock.enqueue({ status: 201, body: { iid: 2, web_url: 'u' } });
    await makeAdapter().createPullRequest({ ...baseInput, reviewers: ['42', 'not-a-number', '7'] });
    const body = mock.requests[0]!.body as { reviewer_ids?: number[] };
    assert.deepEqual(body.reviewer_ids, [42, 7]);
  });

  it('treats a 409 conflict as an update by looking up the open MR', async () => {
    mock.enqueue({ status: 409, body: { message: ['Another open merge request already exists'] } });
    mock.enqueue({ status: 200, body: [{ iid: 5, web_url: 'https://gl/5' }] });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.updated, true);
      assert.equal(result.id, 5);
      assert.equal(result.url, 'https://gl/5');
    }
  });

  it('returns a failure result with the API message on 400', async () => {
    mock.enqueue({ status: 400, body: { message: 'branch not found' } });
    const result = await makeAdapter().createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.match(result.error, /branch not found/);
    }
  });

  it('returns a network-error result on fetch failure', async () => {
    const broken = new GitLabPrAdapter(
      { namespace: 'g', apiBaseUrl: 'http://127.0.0.1:1/api/v4', targetBranch: 'main', reviewers: [] },
      't',
      silentLogger,
    );
    const result = await broken.createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 0);
      assert.match(result.error, /network error/);
    }
  });
});

describe('GitLabPrAdapter.getPullRequestStatus', () => {
  it('maps opened → open with approvals + CI rollup', async () => {
    mock.route('/merge_requests?source_branch=', {
      status: 200,
      body: [{ iid: 11, state: 'opened', web_url: 'https://gl/11' }],
    });
    mock.route('/merge_requests/11/approvals', {
      status: 200,
      body: { approved_by: [{ user: { id: 1 } }, { user: { id: 2 } }], approvals_required: 3 },
    });
    mock.route('/merge_requests/11/pipelines', { status: 200, body: [{ status: 'success' }] });

    const info = await makeAdapter().getPullRequestStatus({ ru: 'repo-a', sourceBranch: 'feature/x' });
    assert.equal(info.state, 'open');
    assert.equal(info.id, 11);
    assert.equal(info.url, 'https://gl/11');
    assert.deepEqual(info.approvals, { approved: 2, required: 3 });
    assert.equal(info.ci, 'passed');
  });

  it('maps merged and closed states', async () => {
    mock.route('/merge_requests?source_branch=', { status: 200, body: [{ iid: 1, state: 'merged' }] });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'merged');

    mock.clearRoutes();
    mock.route('/merge_requests?source_branch=', { status: 200, body: [{ iid: 1, state: 'closed' }] });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'declined');
  });

  it('returns none for an empty list', async () => {
    mock.enqueue({ status: 200, body: [] });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'none');
  });

  it('reports an API error without throwing', async () => {
    mock.setDefault({ status: 500, body: {} });
    const info = await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' });
    assert.equal(info.state, 'none');
    assert.match(info.error ?? '', /HTTP 500/);
  });

  it('honors a per-RU namespace override in the project path', async () => {
    mock.route('/merge_requests?source_branch=', { status: 200, body: [{ iid: 1, state: 'opened', web_url: 'u' }] });
    await makeAdapter().getPullRequestStatus({ ru: 'repo-a', workspace: 'other-grp', sourceBranch: 'b' });
    assert.match(mock.requests[0]!.url, /\/projects\/other-grp%2Frepo-a\/merge_requests/);
  });
});

describe('GitLab config + factory wiring', () => {
  it('validates a gitlab config through the real schema', () => {
    const result = GitBulkConfigSchema.safeParse({
      rus: ['repo-a'],
      ticket: 'AKB-1',
      branch: 'feature/x',
      operations: [{ type: 'delete-file', path: 'x.txt' }],
      commitMessage: 'm',
      prSummary: 's',
      createPrOnError: false,
      prPlatform: 'gitlab',
      gitlab: { namespace: 'my-group' },
    });
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
  });

  it('rejects prPlatform=gitlab without a gitlab block', () => {
    const result = GitBulkConfigSchema.safeParse({
      rus: ['repo-a'],
      ticket: 'AKB-1',
      branch: 'feature/x',
      operations: [{ type: 'delete-file', path: 'x.txt' }],
      commitMessage: 'm',
      prSummary: 's',
      createPrOnError: false,
      prPlatform: 'gitlab',
    });
    assert.equal(result.success, false);
  });

  it('createPrAdapter builds a GitLab adapter when the token is set', async () => {
    const prev = process.env.GITBULK_GITLAB_TOKEN;
    process.env.GITBULK_GITLAB_TOKEN = 'glpat-x';
    try {
      const cfg = {
        prPlatform: 'gitlab',
        gitlab: { namespace: 'g', targetBranch: 'main', reviewers: [] },
      } as unknown as GitBulkConfig;
      const adapter = await createPrAdapter(cfg);
      assert.equal(adapter.platformName, 'gitlab');
    } finally {
      if (prev === undefined) delete process.env.GITBULK_GITLAB_TOKEN;
      else process.env.GITBULK_GITLAB_TOKEN = prev;
    }
  });

  it('createPrAdapter throws without a GitLab token', async () => {
    const prev = process.env.GITBULK_GITLAB_TOKEN;
    delete process.env.GITBULK_GITLAB_TOKEN;
    try {
      const cfg = {
        prPlatform: 'gitlab',
        gitlab: { namespace: 'g', targetBranch: 'main', reviewers: [] },
      } as unknown as GitBulkConfig;
      await assert.rejects(() => createPrAdapter(cfg), PrAdapterError);
    } finally {
      if (prev !== undefined) process.env.GITBULK_GITLAB_TOKEN = prev;
    }
  });
});

/**
 * Unit-Tests für git/pr-azure.ts mit lokalem HTTP-Mock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { AzureDevOpsPrAdapter } from '../../src/git/pr-azure.js';
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
  return new AzureDevOpsPrAdapter(
    {
      organization: 'my-org',
      project: 'my-proj',
      apiBaseUrl: mock.baseUrl,
      targetBranch: 'main',
      reviewers,
    },
    'pat-token',
    silentLogger,
  );
}

const baseInput = {
  ru: 'repo-a',
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  title: 'Test PR',
  description: 'desc',
  reviewers: [] as string[],
};

describe('AzureDevOpsPrAdapter.createPullRequest', () => {
  it('posts to the repo pullrequests endpoint and returns pullRequestId + web url', async () => {
    mock.enqueue({ status: 201, body: { pullRequestId: 7 } });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 7);
      assert.equal(result.statusCode, 201);
      assert.match(result.url, /\/my-org\/my-proj\/_git\/repo-a\/pullrequest\/7$/);
    }
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.match(
      req.url,
      /\/my-org\/my-proj\/_apis\/git\/repositories\/repo-a\/pullrequests\?api-version=7\.1$/,
    );
    const body = req.body as Record<string, unknown>;
    assert.equal(body.sourceRefName, 'refs/heads/feature/x');
    assert.equal(body.targetRefName, 'refs/heads/main');
    assert.equal(body.title, 'Test PR');
    assert.equal(body.description, 'desc');
  });

  it('sends a Basic Authorization header built from the PAT', async () => {
    mock.enqueue({ status: 201, body: { pullRequestId: 1 } });
    await makeAdapter().createPullRequest(baseInput);
    const expected = `Basic ${Buffer.from(':pat-token').toString('base64')}`;
    assert.equal(mock.requests[0]!.headers['authorization'], expected);
  });

  it('maps reviewers to Azure { id } objects (pass-through)', async () => {
    mock.enqueue({ status: 201, body: { pullRequestId: 2 } });
    await makeAdapter().createPullRequest({ ...baseInput, reviewers: ['guid-1', 'guid-2'] });
    const body = mock.requests[0]!.body as { reviewers?: Array<{ id: string }> };
    assert.deepEqual(body.reviewers, [{ id: 'guid-1' }, { id: 'guid-2' }]);
  });

  it('treats a 409 conflict as an update by looking up the active PR', async () => {
    mock.enqueue({ status: 409, body: { message: 'TF401179: An active pull request already exists' } });
    mock.enqueue({ status: 200, body: { value: [{ pullRequestId: 5 }] } });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.updated, true);
      assert.equal(result.id, 5);
      assert.match(result.url, /\/_git\/repo-a\/pullrequest\/5$/);
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
    const broken = new AzureDevOpsPrAdapter(
      { organization: 'o', project: 'p', apiBaseUrl: 'http://127.0.0.1:1', targetBranch: 'main', reviewers: [] },
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

describe('AzureDevOpsPrAdapter.getPullRequestStatus', () => {
  it('maps active → open with approvals + CI rollup', async () => {
    mock.route('/pullrequests?searchCriteria.sourceRefName=', {
      status: 200,
      body: {
        value: [
          {
            pullRequestId: 11,
            status: 'active',
            reviewers: [
              { vote: 10, isRequired: true },
              { vote: 5, isRequired: true },
              { vote: 0, isRequired: true },
            ],
          },
        ],
      },
    });
    mock.route('/pullrequests/11/statuses', { status: 200, body: { value: [{ state: 'succeeded' }] } });

    const info = await makeAdapter().getPullRequestStatus({ ru: 'repo-a', sourceBranch: 'feature/x' });
    assert.equal(info.state, 'open');
    assert.equal(info.id, 11);
    assert.match(info.url ?? '', /\/_git\/repo-a\/pullrequest\/11$/);
    assert.deepEqual(info.approvals, { approved: 2, required: 3 });
    assert.equal(info.ci, 'passed');
  });

  it('rolls a failed status up to ci=failed', async () => {
    mock.route('/pullrequests?searchCriteria.sourceRefName=', {
      status: 200,
      body: { value: [{ pullRequestId: 12, status: 'active' }] },
    });
    mock.route('/pullrequests/12/statuses', {
      status: 200,
      body: { value: [{ state: 'succeeded' }, { state: 'failed' }] },
    });
    const info = await makeAdapter().getPullRequestStatus({ ru: 'repo-a', sourceBranch: 'feature/x' });
    assert.equal(info.ci, 'failed');
  });

  it('maps completed → merged and abandoned → declined', async () => {
    mock.route('/pullrequests?searchCriteria.sourceRefName=', {
      status: 200,
      body: { value: [{ pullRequestId: 1, status: 'completed' }] },
    });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'merged');

    mock.clearRoutes();
    mock.route('/pullrequests?searchCriteria.sourceRefName=', {
      status: 200,
      body: { value: [{ pullRequestId: 1, status: 'abandoned' }] },
    });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'declined');
  });

  it('returns none for an empty value list', async () => {
    mock.route('/pullrequests?searchCriteria.sourceRefName=', { status: 200, body: { value: [] } });
    assert.equal((await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' })).state, 'none');
  });

  it('reports an API error without throwing', async () => {
    mock.setDefault({ status: 500, body: {} });
    const info = await makeAdapter().getPullRequestStatus({ ru: 'r', sourceBranch: 'b' });
    assert.equal(info.state, 'none');
    assert.match(info.error ?? '', /HTTP 500/);
  });

  it('honors a per-RU workspace override as the project in the path', async () => {
    mock.route('/pullrequests?searchCriteria.sourceRefName=', {
      status: 200,
      body: { value: [{ pullRequestId: 1, status: 'active' }] },
    });
    await makeAdapter().getPullRequestStatus({ ru: 'repo-a', workspace: 'other-proj', sourceBranch: 'b' });
    assert.match(
      mock.requests[0]!.url,
      /\/my-org\/other-proj\/_apis\/git\/repositories\/repo-a\/pullrequests/,
    );
  });
});

describe('Azure DevOps config + factory wiring', () => {
  it('validates an azure-devops config through the real schema', () => {
    const result = GitBulkConfigSchema.safeParse({
      rus: ['repo-a'],
      ticket: 'AKB-1',
      branch: 'feature/x',
      operations: [{ type: 'delete-file', path: 'x.txt' }],
      commitMessage: 'm',
      prSummary: 's',
      createPrOnError: false,
      prPlatform: 'azure-devops',
      azureDevOps: { organization: 'my-org', project: 'my-proj' },
    });
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
  });

  it('rejects prPlatform=azure-devops without an azureDevOps block', () => {
    const result = GitBulkConfigSchema.safeParse({
      rus: ['repo-a'],
      ticket: 'AKB-1',
      branch: 'feature/x',
      operations: [{ type: 'delete-file', path: 'x.txt' }],
      commitMessage: 'm',
      prSummary: 's',
      createPrOnError: false,
      prPlatform: 'azure-devops',
    });
    assert.equal(result.success, false);
  });

  it('createPrAdapter builds an Azure adapter when the token is set', async () => {
    const prev = process.env.GITBULK_AZURE_DEVOPS_TOKEN;
    process.env.GITBULK_AZURE_DEVOPS_TOKEN = 'pat-x';
    try {
      const cfg = {
        prPlatform: 'azure-devops',
        azureDevOps: { organization: 'o', project: 'p', targetBranch: 'main', reviewers: [] },
      } as unknown as GitBulkConfig;
      const adapter = await createPrAdapter(cfg);
      assert.equal(adapter.platformName, 'azure-devops');
    } finally {
      if (prev === undefined) delete process.env.GITBULK_AZURE_DEVOPS_TOKEN;
      else process.env.GITBULK_AZURE_DEVOPS_TOKEN = prev;
    }
  });

  it('createPrAdapter throws without an Azure token', async () => {
    const prev = process.env.GITBULK_AZURE_DEVOPS_TOKEN;
    delete process.env.GITBULK_AZURE_DEVOPS_TOKEN;
    try {
      const cfg = {
        prPlatform: 'azure-devops',
        azureDevOps: { organization: 'o', project: 'p', targetBranch: 'main', reviewers: [] },
      } as unknown as GitBulkConfig;
      await assert.rejects(() => createPrAdapter(cfg), PrAdapterError);
    } finally {
      if (prev !== undefined) process.env.GITBULK_AZURE_DEVOPS_TOKEN = prev;
    }
  });
});

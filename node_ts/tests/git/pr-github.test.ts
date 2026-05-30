/**
 * Unit-Tests für git/pr-github.ts mit lokalem HTTP-Mock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubPrAdapter } from '../../src/git/pr-github.js';
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
  mock.setDefault({ status: 200, body: {} });
});

function makeAdapter(reviewers: string[] = []) {
  return new GitHubPrAdapter(
    { owner: 'my-org', apiBaseUrl: mock.baseUrl, targetBranch: 'main', reviewers },
    'gh-token',
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

describe('GitHubPrAdapter', () => {
  it('posts to /repos/{owner}/{repo}/pulls with head/base/title and returns id+url', async () => {
    mock.enqueue({ status: 201, body: { number: 7, html_url: 'https://github.com/my-org/repo-a/pull/7' } });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 7);
      assert.equal(result.statusCode, 201);
      assert.equal(result.url, 'https://github.com/my-org/repo-a/pull/7');
    }
    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/repos/my-org/repo-a/pulls');
    const body = req.body as Record<string, unknown>;
    assert.equal(body.head, 'feature/x');
    assert.equal(body.base, 'main');
    assert.equal(body.title, 'Test PR');
    assert.equal(body.body, 'desc');
  });

  it('sends a Bearer token and the GitHub Accept header', async () => {
    mock.enqueue({ status: 201, body: { number: 1, html_url: 'u' } });
    await makeAdapter().createPullRequest(baseInput);
    const headers = mock.requests[0]!.headers;
    assert.equal(headers['authorization'], 'Bearer gh-token');
    assert.match(String(headers['accept']), /vnd\.github/);
  });

  it('returns a failure result with the API message on 422', async () => {
    mock.enqueue({
      status: 422,
      body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] },
    });

    const result = await makeAdapter().createPullRequest(baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 422);
      assert.match(result.error, /Validation Failed/);
      assert.match(result.error, /already exists/);
    }
    assert.equal(mock.requests.length, 1);
  });

  it('requests reviewers in a second call (best-effort) without failing the PR', async () => {
    mock.enqueue({ status: 201, body: { number: 9, html_url: 'u' } }); // PR create
    mock.enqueue({ status: 422, body: { message: 'reviewer not found' } }); // reviewers fail

    const result = await makeAdapter(['octocat']).createPullRequest({ ...baseInput, reviewers: ['octocat'] });

    // PR-Erstellung bleibt erfolgreich, obwohl der Reviewer-Call scheitert.
    assert.equal(result.ok, true);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]!.url, '/repos/my-org/repo-a/pulls/9/requested_reviewers');
    assert.deepEqual((mock.requests[1]!.body as Record<string, unknown>).reviewers, ['octocat']);
  });

  it('returns a network-error result when the host is unreachable', async () => {
    const adapter = new GitHubPrAdapter(
      { owner: 'my-org', apiBaseUrl: 'http://127.0.0.1:1', targetBranch: 'main', reviewers: [] },
      'gh-token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 0);
      assert.match(result.error, /network error/);
    }
  });
});

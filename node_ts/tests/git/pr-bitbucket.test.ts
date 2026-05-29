/**
 * Unit-Tests für git/pr-bitbucket.ts mit lokalem HTTP-Mock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { BitbucketPrAdapter } from '../../src/git/pr-bitbucket.js';
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

const baseInput = {
  ru: 'repo-a',
  sourceBranch: 'feature/x',
  targetBranch: 'master',
  title: 'Test PR',
  description: 'desc',
  reviewers: [],
};

describe('BitbucketPrAdapter - Cloud variant', () => {
  it('posts to /2.0/repositories/{ws}/{ru}/pullrequests', async () => {
    mock.enqueue({
      status: 201,
      body: { id: 42, links: { html: { href: 'https://bb.org/pr/42' } } },
    });
    const adapter = new BitbucketPrAdapter(
      {
        workspace: 'my-ws',
        apiVariant: 'cloud',
        apiBaseUrl: mock.baseUrl,
        targetBranch: 'master',
        reviewers: [],
      },
      'token-abc',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 42);
      assert.equal(result.statusCode, 201);
      assert.equal(result.url, 'https://bb.org/pr/42');
    }
    assert.equal(mock.requests.length, 1);
    assert.equal(
      mock.requests[0]!.url,
      '/repositories/my-ws/repo-a/pullrequests',
    );
  });

  it('uses Cloud payload format (source.branch.name)', async () => {
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    assert.equal(body.title, 'Test PR');
    assert.deepEqual((body.source as Record<string, unknown>).branch, { name: 'feature/x' });
    assert.deepEqual((body.destination as Record<string, unknown>).branch, { name: 'master' });
  });

  it('detects UUID format reviewers', async () => {
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    await adapter.createPullRequest({
      ...baseInput,
      reviewers: ['{abc-uuid}', 'plain-id'],
    });
    const reviewers = (mock.requests[0]!.body as Record<string, unknown>).reviewers as Array<Record<string, string>>;
    assert.deepEqual(reviewers[0], { uuid: '{abc-uuid}' });
    assert.deepEqual(reviewers[1], { account_id: 'plain-id' });
  });
});

describe('BitbucketPrAdapter - Server variant', () => {
  it('posts to /rest/api/1.0/projects/{key}/repos/{ru}/pull-requests', async () => {
    mock.enqueue({
      status: 201,
      body: { id: 5, links: { self: [{ href: 'https://srv/pr/5' }] } },
    });
    const adapter = new BitbucketPrAdapter(
      {
        workspace: 'PROJ',
        apiVariant: 'server',
        apiBaseUrl: mock.baseUrl,
        targetBranch: 'master',
        reviewers: [],
      },
      'token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 5);
      assert.equal(result.url, 'https://srv/pr/5');
    }
    assert.equal(mock.requests[0]!.url, '/rest/api/1.0/projects/PROJ/repos/repo-a/pull-requests');
  });

  it('uses Server payload format (fromRef.id with refs/heads/)', async () => {
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'P', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    assert.deepEqual(body.fromRef, { id: 'refs/heads/feature/x' });
    assert.deepEqual(body.toRef, { id: 'refs/heads/master' });
  });

  it('throws when Server variant has no apiBaseUrl', () => {
    assert.throws(
      () =>
        new BitbucketPrAdapter(
          { workspace: 'P', apiVariant: 'server', targetBranch: 'master', reviewers: [] },
          'token',
          silentLogger,
        ),
      /apiBaseUrl/i,
    );
  });
});

describe('BitbucketPrAdapter - Authentication', () => {
  it('sends Bearer token by default (for ATATT... tokens)', async () => {
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'ATATT-bearer-token-123',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    assert.equal(mock.requests[0]!.headers.authorization, 'Bearer ATATT-bearer-token-123');
  });

  it('uses Basic auth when token contains colon (for legacy app passwords)', async () => {
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'user:app-pwd-456',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    const auth = mock.requests[0]!.headers.authorization as string;
    assert.match(auth, /^Basic /);
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    assert.equal(decoded, 'user:app-pwd-456');
  });
});

describe('BitbucketPrAdapter - Error handling', () => {
  it('returns ok=false on HTTP 401', async () => {
    mock.enqueue({ status: 401, body: { error: { message: 'unauthorized' } } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'bad-token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 401);
      assert.match(result.error, /unauthorized/);
    }
  });

  it('returns ok=false with statusCode 0 on network error', async () => {
    const adapter = new BitbucketPrAdapter(
      {
        workspace: 'ws',
        apiVariant: 'cloud',
        apiBaseUrl: 'http://127.0.0.1:1', // invalid port
        targetBranch: 'master',
        reviewers: [],
      },
      'token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 0);
      assert.match(result.error, /network error/i);
    }
  });

  it('handles non-JSON error body gracefully', async () => {
    mock.enqueue({ status: 500, body: 'internal server error' });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 500);
      assert.match(result.error, /500/);
    }
  });
});

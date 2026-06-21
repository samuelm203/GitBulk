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

// Leerer Lookup ("kein offener PR vorhanden") — vor jedem echten Create nötig,
// weil der Adapter jetzt ZUERST nach einem bestehenden PR sucht.
const EMPTY_LOOKUP = { status: 200, body: { values: [] } };
const cloudAdapter = (ws = 'ws') =>
  new BitbucketPrAdapter(
    { workspace: ws, apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
    'token',
    silentLogger,
  );

describe('BitbucketPrAdapter - Cloud variant', () => {
  it('posts to /2.0/repositories/{ws}/{ru}/pullrequests (after an empty lookup)', async () => {
    mock.enqueue(EMPTY_LOOKUP); // Lookup: kein bestehender PR
    mock.enqueue({ status: 201, body: { id: 42, links: { html: { href: 'https://bb.org/pr/42' } } } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'my-ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token-abc',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 42);
      assert.equal(result.statusCode, 201);
      assert.equal(result.url, 'https://bb.org/pr/42');
      assert.notEqual(result.updated, true); // echter neuer PR
    }
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0]!.method, 'GET'); // Lookup zuerst
    assert.equal(mock.requests[1]!.method, 'POST'); // dann Create
    assert.equal(mock.requests[1]!.url, '/repositories/my-ws/repo-a/pullrequests');
  });

  it('honors a per-RU workspace override in lookup + create URLs', async () => {
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 7 } });
    // Adapter-Default ist "default-ws"; der Input überschreibt mit "override-ws".
    const result = await cloudAdapter('default-ws').createPullRequest({
      ...baseInput,
      workspace: 'override-ws',
    });
    assert.equal(result.ok, true);
    // Sowohl der Lookup-GET als auch der Create-POST nutzen den Override.
    assert.match(mock.requests[0]!.url, /^\/repositories\/override-ws\/repo-a\/pullrequests\?q=/);
    assert.equal(mock.requests[1]!.url, '/repositories/override-ws/repo-a/pullrequests');
  });

  it('uses Cloud payload format (source.branch.name)', async () => {
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 1 } });
    await cloudAdapter().createPullRequest(baseInput);
    const body = mock.requests[1]!.body as Record<string, unknown>;
    assert.equal(body.title, 'Test PR');
    assert.deepEqual((body.source as Record<string, unknown>).branch, { name: 'feature/x' });
    assert.deepEqual((body.destination as Record<string, unknown>).branch, { name: 'master' });
  });

  it('detects UUID format reviewers', async () => {
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 1 } });
    await cloudAdapter().createPullRequest({ ...baseInput, reviewers: ['{abc-uuid}', 'plain-id'] });
    const reviewers = (mock.requests[1]!.body as Record<string, unknown>).reviewers as Array<Record<string, string>>;
    assert.deepEqual(reviewers[0], { uuid: '{abc-uuid}' });
    assert.deepEqual(reviewers[1], { account_id: 'plain-id' });
  });

  it('re-run: reports an existing open PR as UPDATED without posting a duplicate', async () => {
    // Der eigentliche Bug: beim zweiten Lauf existiert der PR schon → "updated".
    mock.enqueue({ status: 200, body: { values: [{ id: 77, links: { html: { href: 'https://bb.org/pr/77' } } }] } });
    const result = await cloudAdapter('my-ws').createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 77);
      assert.equal(result.url, 'https://bb.org/pr/77');
      assert.equal(result.updated, true);
    }
    // Nur der Lookup-GET, KEIN Create-POST (kein Duplikat).
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]!.method, 'GET');
    assert.match(mock.requests[0]!.url, /^\/repositories\/my-ws\/repo-a\/pullrequests\?q=/);
    assert.match(mock.requests[0]!.url, /state=OPEN/);
  });
});

describe('BitbucketPrAdapter - Server variant', () => {
  it('posts to /rest/api/1.0/projects/{key}/repos/{ru}/pull-requests (after an empty lookup)', async () => {
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 5, links: { self: [{ href: 'https://srv/pr/5' }] } } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'PROJ', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 5);
      assert.equal(result.url, 'https://srv/pr/5');
    }
    assert.equal(mock.requests[1]!.url, '/rest/api/1.0/projects/PROJ/repos/repo-a/pull-requests');
  });

  it('uses Server payload format (fromRef.id with refs/heads/)', async () => {
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'P', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    const body = mock.requests[1]!.body as Record<string, unknown>;
    assert.deepEqual(body.fromRef, { id: 'refs/heads/feature/x' });
    assert.deepEqual(body.toRef, { id: 'refs/heads/master' });
  });

  it('re-run (Server): reports an existing open PR as UPDATED', async () => {
    mock.enqueue({ status: 200, body: { values: [{ id: 5, links: { self: [{ href: 'https://srv/pr/5' }] } }] } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'PROJ', apiVariant: 'server', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'token',
      silentLogger,
    );
    const result = await adapter.createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 5);
      assert.equal(result.updated, true);
    }
    assert.equal(mock.requests.length, 1);
    assert.match(mock.requests[0]!.url, /\/rest\/api\/1\.0\/projects\/PROJ\/repos\/repo-a\/pull-requests\?/);
    assert.match(mock.requests[0]!.url, /direction=OUTGOING/);
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
    mock.enqueue(EMPTY_LOOKUP);
    mock.enqueue({ status: 201, body: { id: 1 } });
    const adapter = new BitbucketPrAdapter(
      { workspace: 'ws', apiVariant: 'cloud', apiBaseUrl: mock.baseUrl, targetBranch: 'master', reviewers: [] },
      'ATATT-bearer-token-123',
      silentLogger,
    );
    await adapter.createPullRequest(baseInput);
    // Sowohl Lookup-GET als auch Create-POST tragen den Auth-Header.
    assert.equal(mock.requests[0]!.headers.authorization, 'Bearer ATATT-bearer-token-123');
  });

  it('uses Basic auth when token contains colon (for legacy app passwords)', async () => {
    mock.enqueue(EMPTY_LOOKUP);
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
    mock.enqueue(EMPTY_LOOKUP); // Lookup findet nichts → Create wird versucht
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

  it('race: create rejected with 409 but a PR appeared concurrently → UPDATED', async () => {
    mock.enqueue(EMPTY_LOOKUP); // erster Lookup: noch keiner
    mock.enqueue({ status: 409, body: { error: { message: 'conflict' } } }); // Create scheitert
    mock.enqueue({ status: 200, body: { values: [{ id: 88, links: { html: { href: 'https://bb.org/pr/88' } } }] } }); // zweiter Lookup findet ihn
    const result = await cloudAdapter('my-ws').createPullRequest(baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.id, 88);
      assert.equal(result.updated, true);
    }
    assert.equal(mock.requests.length, 3); // Lookup, Create(409), Lookup
  });

  it('handles non-JSON error body gracefully', async () => {
    mock.enqueue(EMPTY_LOOKUP);
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

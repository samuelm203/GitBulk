/**
 * Tests für gui/server.ts — echter HTTP-Server auf 127.0.0.1:0, Runner injiziert.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import type { RunSummary } from '../../src/core/runner.js';
import type { GuiPageModel } from '../../src/gui/page.js';

const model: GuiPageModel = {
  rus: ['repo-a', 'repo-b'],
  dryRun: true,
  concurrency: 2,
  platform: 'bitbucket',
  ticket: 'AKB-1',
  branch: 'feat',
};

function fakeSummary(): RunSummary {
  return {
    results: [],
    totals: { rus: 2, prsCreated: 1, prsSkipped: 1, prsFailed: 0, notProcessed: 0, fatalErrors: 0 },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalDurationMs: 42,
  } as unknown as RunSummary;
}

/** Liest vom SSE-Stream, bis `predicate` auf den Gesamttext zutrifft (mit Timeout). */
async function readSse(
  handle: GuiServerHandle,
  predicate: (text: string) => boolean,
  actions?: () => Promise<void> | void,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(`${handle.url}/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    // Aktionen erst NACH dem Verbinden ausführen, damit kein Event verpasst wird.
    if (actions) await actions();
    while (!predicate(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return text;
}

describe('startGuiServer', () => {
  it('serves the page with RU names and no token material', async () => {
    const handle = await startGuiServer({ model, runRunner: () => Promise.resolve(fakeSummary()) });
    try {
      assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(handle.url);
      const html = await res.text();
      assert.match(html, /repo-a/);
      assert.match(html, /repo-b/);
      assert.match(html, /Bitbucket Repo/);
      assert.doesNotMatch(html, /GITBULK_.*_TOKEN/);
    } finally {
      await handle.close();
    }
  });

  it('starts the injected runner exactly once; second POST gets 409', async () => {
    let calls = 0;
    const handle = await startGuiServer({
      model,
      runRunner: () => {
        calls++;
        return Promise.resolve(fakeSummary());
      },
    });
    try {
      const first = await fetch(`${handle.url}/start`, { method: 'POST' });
      assert.equal(first.status, 202);
      const second = await fetch(`${handle.url}/start`, { method: 'POST' });
      assert.equal(second.status, 409);
      await handle.runFinished;
      assert.equal(calls, 1);
      assert.equal(handle.started(), true);
    } finally {
      await handle.close();
    }
  });

  it('broadcasts progress and log events to connected SSE clients', async () => {
    const handle = await startGuiServer({ model, runRunner: () => Promise.resolve(fakeSummary()) });
    try {
      const text = await readSse(
        handle,
        (t) => t.includes('event: progress') && t.includes('event: log'),
        () => {
          handle.broadcast('progress', { ru: 'repo-a', status: 'running', stage: 'git' });
          handle.broadcast('log', { line: '[INFO] hello from runner' });
        },
      );
      assert.match(text, /"ru":"repo-a"/);
      assert.match(text, /"stage":"git"/);
      assert.match(text, /hello from runner/);
    } finally {
      await handle.close();
    }
  });

  it('emits started and summary events around the run', async () => {
    const handle = await startGuiServer({ model, runRunner: () => Promise.resolve(fakeSummary()) });
    try {
      const text = await readSse(
        handle,
        (t) => t.includes('event: summary'),
        async () => {
          await fetch(`${handle.url}/start`, { method: 'POST' });
        },
      );
      assert.match(text, /event: started/);
      assert.match(text, /"prsCreated":1/);
      const summary = await handle.runFinished;
      assert.equal(summary.totals.prsCreated, 1);
    } finally {
      await handle.close();
    }
  });

  it('rejects runFinished when the runner crashes', async () => {
    const handle = await startGuiServer({
      model,
      runRunner: () => Promise.reject(new Error('boom')),
    });
    try {
      await fetch(`${handle.url}/start`, { method: 'POST' });
      await assert.rejects(handle.runFinished, /boom/);
    } finally {
      await handle.close();
    }
  });
});

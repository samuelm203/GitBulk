/**
 * Unit-Tests für utils/retry.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { retry, computeBackoff } from '../../src/utils/retry.js';
import { createLogger } from '../../src/utils/logger.js';

// Stille Logger-Instanz für alle Tests in dieser Datei
const logger = createLogger({ level: 'error', timestamps: false, noColor: true });

describe('computeBackoff', () => {
  it('returns exponential values without jitter', () => {
    assert.equal(computeBackoff(1, 1000, 30_000, false), 1000);
    assert.equal(computeBackoff(2, 1000, 30_000, false), 2000);
    assert.equal(computeBackoff(3, 1000, 30_000, false), 4000);
    assert.equal(computeBackoff(4, 1000, 30_000, false), 8000);
  });

  it('caps at maxBackoffMs', () => {
    assert.equal(computeBackoff(20, 1000, 5000, false), 5000);
    assert.equal(computeBackoff(100, 1000, 5000, false), 5000);
  });

  it('applies jitter within ±25%', () => {
    for (let i = 0; i < 100; i++) {
      const v = computeBackoff(2, 1000, 30_000, true);
      // 2^1 * 1000 = 2000 → jitter range [1500, 2500]
      assert.ok(v >= 1499 && v <= 2501, `value ${v} out of jitter range`);
    }
  });

  it('returns 0 for attempt < 1', () => {
    assert.equal(computeBackoff(0, 1000, 30_000, false), 0);
    assert.equal(computeBackoff(-5, 1000, 30_000, false), 0);
  });
});

describe('retry', () => {
  it('returns success on first attempt', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        return { ok: true, value: 'hello' };
      },
      { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 100, logger },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, 'hello');
      assert.equal(result.attempts, 1);
    }
    assert.equal(calls, 1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await retry(
      async (attempt) => {
        calls++;
        if (attempt < 3) return { ok: false as const, retry: true, error: 'transient' };
        return { ok: true, value: 42 };
      },
      { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10, logger },
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  });

  it('exhausts maxAttempts and reports it', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        return { ok: false as const, retry: true, error: 'still failing' };
      },
      { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10, logger },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.attempts, 3);
      assert.equal(result.exhausted, true);
      assert.equal(result.error, 'still failing');
    }
    assert.equal(calls, 3);
  });

  it('stops immediately on permanent error', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        return { ok: false as const, retry: false, error: 'auth failed' };
      },
      { maxAttempts: 5, backoffMs: 1, maxBackoffMs: 10, logger },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.attempts, 1);
      assert.equal(result.exhausted, false);
    }
    assert.equal(calls, 1);
  });

  it('treats thrown exceptions as retryable', async () => {
    let calls = 0;
    const result = await retry(
      async (attempt) => {
        calls++;
        if (attempt === 1) throw new Error('boom');
        return { ok: true, value: 'recovered' };
      },
      { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10, logger },
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
  });

  it('aborts during backoff when signal fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    const result = await retry(
      async () => ({ ok: false as const, retry: true, error: 'fail' }),
      {
        maxAttempts: 10,
        backoffMs: 200,
        maxBackoffMs: 1000,
        logger,
        signal: controller.signal,
      },
    );
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.exhausted, false);
    assert.ok(elapsed < 500, `abort should be quick, took ${elapsed}ms`);
  });

  it('throws on invalid maxAttempts', async () => {
    await assert.rejects(
      retry(async () => ({ ok: true, value: 'x' }), {
        maxAttempts: 0,
        backoffMs: 100,
        maxBackoffMs: 100,
        logger,
      }),
      /maxAttempts/,
    );
  });

  it('throws when maxBackoffMs < backoffMs', async () => {
    await assert.rejects(
      retry(async () => ({ ok: true, value: 'x' }), {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 500,
        logger,
      }),
      /maxBackoffMs/,
    );
  });

  it('throws on negative backoffMs', async () => {
    await assert.rejects(
      retry(async () => ({ ok: true, value: 'x' }), {
        maxAttempts: 3,
        backoffMs: -1,
        maxBackoffMs: 100,
        logger,
      }),
      /backoffMs/,
    );
  });

  it('does not wait after the last attempt', async () => {
    const start = Date.now();
    await retry(
      async () => ({ ok: false as const, retry: true, error: 'fail' }),
      { maxAttempts: 2, backoffMs: 50, maxBackoffMs: 100, logger, jitter: false },
    );
    const elapsed = Date.now() - start;
    // Nur 1 Backoff von 50ms zwischen Versuch 1 und 2, kein weiterer nach Versuch 2
    assert.ok(elapsed < 200, `should not wait after last attempt, took ${elapsed}ms`);
  });
});

/**
 * Unit-Tests für utils/logger.ts.
 *
 * Capturt stdout/stderr-Writes via process.stdout.write-Mock,
 * damit wir Log-Output verifizieren können, ohne die Test-Ausgabe zu spammen.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, LOG_LEVELS } from '../../src/utils/logger.js';

/**
 * Hilfsfunktion: capturt alle stdout/stderr-Writes während `fn` läuft.
 */
async function captureOutput(fn: () => void | Promise<void>): Promise<{
  stdout: string;
  stderr: string;
}> {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stdout, stderr };
}

describe('Logger', () => {
  it('exposes the four standard log levels', () => {
    assert.deepEqual([...LOG_LEVELS], ['debug', 'info', 'warn', 'error']);
  });

  it('writes info messages to stdout', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: false });
    const { stdout, stderr } = await captureOutput(() => {
      logger.info('hello');
    });
    assert.match(stdout, /\[INFO\].*hello/);
    assert.equal(stderr, '');
  });

  it('writes error messages to stderr', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: false });
    const { stdout, stderr } = await captureOutput(() => {
      logger.error('boom');
    });
    assert.equal(stdout, '');
    assert.match(stderr, /\[ERROR\].*boom/);
  });

  it('respects log level filtering', async () => {
    const logger = createLogger({ level: 'warn', noColor: true, timestamps: false });
    const { stdout, stderr } = await captureOutput(() => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    });
    // debug und info werden gefiltert
    assert.doesNotMatch(stdout, /\[DEBUG\]/);
    assert.doesNotMatch(stdout, /\[INFO\]/);
    // warn geht nach stdout (nur error geht nach stderr)
    assert.match(stdout, /\[WARN\].*warn/);
    // error geht nach stderr
    assert.match(stderr, /\[ERROR\].*error/);
  });

  it('adds RU context with withRu()', async () => {
    const root = createLogger({ level: 'info', noColor: true, timestamps: false });
    const ruLog = root.withRu('my-repo');
    const { stdout } = await captureOutput(() => {
      ruLog.info('processing');
    });
    assert.match(stdout, /\[my-repo\].*processing/);
  });

  it('omits timestamps when disabled', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: false });
    const { stdout } = await captureOutput(() => {
      logger.info('msg');
    });
    // Kein ISO-Timestamp-Pattern wie "2025-..."
    assert.doesNotMatch(stdout, /\d{4}-\d{2}-\d{2}/);
  });

  it('includes timestamps when enabled', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: true });
    const { stdout } = await captureOutput(() => {
      logger.info('msg');
    });
    assert.match(stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('prints Error objects with stack trace', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: false });
    const err = new Error('test error');
    const { stderr } = await captureOutput(() => {
      logger.error('failed:', err);
    });
    assert.match(stderr, /failed:/);
    assert.match(stderr, /test error/);
  });

  it('serializes object args as JSON', async () => {
    const logger = createLogger({ level: 'info', noColor: true, timestamps: false });
    const { stdout } = await captureOutput(() => {
      logger.info('payload:', { foo: 'bar', n: 42 });
    });
    assert.match(stdout, /"foo": "bar"/);
    assert.match(stdout, /"n": 42/);
  });
});

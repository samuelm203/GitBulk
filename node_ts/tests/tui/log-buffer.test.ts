/**
 * Unit-Tests für tui/log-buffer.ts.
 *
 * Der Puffer schützt die TUI-Live-Ansicht: Während des Renderings werden
 * Log-Zeilen gesammelt statt geschrieben und nach dem Lauf am Stück geflusht.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TuiLogBuffer } from '../../src/tui/log-buffer.js';
import type { LogSink } from '../../src/utils/logger.js';

function makeSink(): { sink: LogSink; getOutput: () => string } {
  let out = '';
  return {
    sink: {
      write(chunk: string | Uint8Array): boolean {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    },
    getOutput: () => out,
  };
}

describe('TuiLogBuffer', () => {
  it('passes writes straight through before buffering begins', () => {
    const { sink, getOutput } = makeSink();
    const buf = new TuiLogBuffer(sink);
    buf.write('early warning\n');
    assert.equal(getOutput(), 'early warning\n');
    assert.equal(buf.size, 0);
  });

  it('collects writes while buffering and keeps the target silent', () => {
    const { sink, getOutput } = makeSink();
    const buf = new TuiLogBuffer(sink);
    buf.beginBuffering();
    buf.write('[WARN] push failed\n');
    buf.write('[WARN] conflict skip\n');
    assert.equal(getOutput(), '', 'target must stay untouched during the live render');
    assert.equal(buf.size, 2);
  });

  it('flush writes everything in original order and resumes passthrough', () => {
    const { sink, getOutput } = makeSink();
    const buf = new TuiLogBuffer(sink);
    buf.beginBuffering();
    buf.write('one\n');
    buf.write('two\n');
    buf.flush();
    assert.equal(getOutput(), 'one\ntwo\n');
    assert.equal(buf.size, 0);
    // Nach dem Flush wieder Echtzeit-Durchreichen.
    buf.write('three\n');
    assert.equal(getOutput(), 'one\ntwo\nthree\n');
  });

  it('flush with an empty buffer is a no-op (idempotent)', () => {
    const { sink, getOutput } = makeSink();
    const buf = new TuiLogBuffer(sink);
    buf.beginBuffering();
    buf.flush();
    buf.flush();
    assert.equal(getOutput(), '');
  });

  it('decodes Uint8Array chunks as UTF-8', () => {
    const { sink, getOutput } = makeSink();
    const buf = new TuiLogBuffer(sink);
    buf.beginBuffering();
    buf.write(Buffer.from('bytes ärger\n', 'utf8'));
    buf.flush();
    assert.equal(getOutput(), 'bytes ärger\n');
  });
});

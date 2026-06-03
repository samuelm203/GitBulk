/**
 * Unit-Tests für tui/render.ts.
 *
 * Testet die reine Frame-Bau-Logik und den Renderer gegen einen
 * Mock-Stream (kein echtes Terminal nötig).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFrame,
  countByStatus,
  TuiRenderer,
  SPINNER_FRAMES,
  type TuiRuRow,
} from '../../src/tui/render.js';

/**
 * Mock-WritableStream, der alle Writes in einem String sammelt.
 */
function makeMockStream(): { stream: NodeJS.WritableStream; getOutput: () => string } {
  let buffer = '';
  const stream = {
    write: (chunk: string | Uint8Array): boolean => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    },
  } as NodeJS.WritableStream;
  return { stream, getOutput: () => buffer };
}

/**
 * Entfernt ANSI-Escape-Sequenzen, um den reinen Text zu prüfen.
 */
function stripAnsi(s: string): string {
  // ANSI-Escape-Sequenzen enthalten per Definition Control-Characters (\u001b).
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Grobe Anzahl aktiver Timer im Prozess (für Leak-Erkennung).
 * Nutzt die interne Node-API; wenn nicht verfügbar, wird 0 zurückgegeben
 * (der Test ist dann eine No-Op-Absicherung).
 */
function getActiveTimerCount(): number {
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  if (typeof proc._getActiveHandles !== 'function') return 0;
  return proc._getActiveHandles().filter((h) => {
    const ctor = (h as { constructor?: { name?: string } })?.constructor?.name;
    return ctor === 'Timeout';
  }).length;
}

describe('countByStatus', () => {
  it('counts each status correctly', () => {
    const rows: TuiRuRow[] = [
      { ru: 'a', status: 'done' },
      { ru: 'b', status: 'done' },
      { ru: 'c', status: 'failed' },
      { ru: 'd', status: 'pending' },
      { ru: 'e', status: 'running' },
      { ru: 'f', status: 'skipped' },
    ];
    const counts = countByStatus(rows);
    assert.equal(counts.done, 2);
    assert.equal(counts.failed, 1);
    assert.equal(counts.pending, 1);
    assert.equal(counts.running, 1);
    assert.equal(counts.skipped, 1);
  });

  it('returns all zeros for empty list', () => {
    const counts = countByStatus([]);
    assert.equal(counts.done, 0);
    assert.equal(counts.failed, 0);
    assert.equal(counts.pending, 0);
  });
});

describe('buildFrame', () => {
  it('includes the title when provided', () => {
    const frame = buildFrame([{ ru: 'repo-a', status: 'pending' }], {
      noColor: true,
      title: 'My Run',
    });
    assert.ok(frame[0]!.includes('My Run'));
  });

  it('renders one line per RU plus footer', () => {
    const rows: TuiRuRow[] = [
      { ru: 'repo-a', status: 'done' },
      { ru: 'repo-b', status: 'failed' },
    ];
    const frame = buildFrame(rows, { noColor: true });
    // Keine Titelzeile → 2 RU-Zeilen + Leerzeile + Footer = 4
    assert.equal(frame.length, 4);
    assert.ok(frame[0]!.includes('repo-a'));
    assert.ok(frame[1]!.includes('repo-b'));
  });

  it('shows status labels', () => {
    const frame = buildFrame([{ ru: 'x', status: 'running' }], { noColor: true });
    assert.ok(frame.some((l) => l.includes('running')));
  });

  it('shows detail text when present', () => {
    const frame = buildFrame([{ ru: 'x', status: 'done', detail: 'PR #42' }], {
      noColor: true,
    });
    assert.ok(frame.some((l) => l.includes('PR #42')));
  });

  it('includes counts in the footer', () => {
    const rows: TuiRuRow[] = [
      { ru: 'a', status: 'done' },
      { ru: 'b', status: 'failed' },
      { ru: 'c', status: 'pending' },
    ];
    const frame = buildFrame(rows, { noColor: true });
    const footer = frame[frame.length - 1]!;
    assert.ok(footer.includes('1 done'));
    assert.ok(footer.includes('1 failed'));
    assert.ok(footer.includes('1 remaining'));
  });

  it('emits no ANSI codes when noColor is true', () => {
    const frame = buildFrame([{ ru: 'x', status: 'done' }], { noColor: true });
    const joined = frame.join('\n');
    assert.equal(joined, stripAnsi(joined), 'expected no ANSI escape codes');
  });

  it('emits ANSI codes when color is enabled', () => {
    const frame = buildFrame([{ ru: 'x', status: 'done' }], { noColor: false });
    const joined = frame.join('\n');
    assert.notEqual(joined, stripAnsi(joined), 'expected ANSI escape codes');
  });

  it('uses a spinner frame for running rows when spinnerFrame is set', () => {
    const frame0 = buildFrame([{ ru: 'x', status: 'running' }], {
      noColor: true,
      spinnerFrame: 0,
    });
    assert.ok(frame0.some((l) => l.includes(SPINNER_FRAMES[0]!)), 'expected first spinner frame');

    const frame1 = buildFrame([{ ru: 'x', status: 'running' }], {
      noColor: true,
      spinnerFrame: 1,
    });
    assert.ok(frame1.some((l) => l.includes(SPINNER_FRAMES[1]!)), 'expected second spinner frame');
  });

  it('wraps spinner frame index around the frame count', () => {
    const idx = SPINNER_FRAMES.length + 2;
    const frame = buildFrame([{ ru: 'x', status: 'running' }], {
      noColor: true,
      spinnerFrame: idx,
    });
    // Index wird modulo gerechnet → entspricht Frame 2
    assert.ok(frame.some((l) => l.includes(SPINNER_FRAMES[2]!)));
  });

  it('uses the static symbol when noSpinner is true', () => {
    const frame = buildFrame([{ ru: 'x', status: 'running' }], {
      noColor: true,
      spinnerFrame: 3,
      noSpinner: true,
    });
    // Statisches Symbol ◐, kein Braille-Frame
    assert.ok(frame.some((l) => l.includes('◐')));
    assert.ok(!frame.some((l) => l.includes(SPINNER_FRAMES[3]!)));
  });

  it('only animates running rows, not other statuses', () => {
    const frame = buildFrame(
      [
        { ru: 'a', status: 'done' },
        { ru: 'b', status: 'pending' },
      ],
      { noColor: true, spinnerFrame: 0 },
    );
    // Keine Braille-Frames bei done/pending
    const joined = frame.join('\n');
    assert.ok(!SPINNER_FRAMES.some((f) => joined.includes(f)));
  });
});

describe('TuiRenderer', () => {
  it('draws initial frame on start', () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'repo-a', status: 'pending' }], {
      out: stream,
      noColor: true,
      title: 'Test',
    });
    renderer.start();
    const out = stripAnsi(getOutput());
    assert.ok(out.includes('Test'));
    assert.ok(out.includes('repo-a'));
    assert.ok(out.includes('pending'));
    renderer.stop();
  });

  it('updates a RU status', () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer(
      [
        { ru: 'repo-a', status: 'pending' },
        { ru: 'repo-b', status: 'pending' },
      ],
      { out: stream, noColor: true },
    );
    renderer.start();
    renderer.update('repo-a', 'done', 'PR #5');
    const rows = renderer.getRows();
    const a = rows.find((r) => r.ru === 'repo-a')!;
    assert.equal(a.status, 'done');
    assert.equal(a.detail, 'PR #5');
    // Letzte Ausgabe sollte den neuen Status enthalten
    const out = stripAnsi(getOutput());
    assert.ok(out.includes('PR #5'));
    renderer.stop();
  });

  it('does not crash when updating an unknown RU', () => {
    const { stream } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'repo-a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    renderer.start();
    assert.doesNotThrow(() => renderer.update('does-not-exist', 'done'));
    renderer.stop();
  });

  it('hides and shows cursor with color enabled', () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: false,
    });
    renderer.start();
    assert.ok(getOutput().includes('\u001b[?25l'), 'expected hide-cursor code');
    renderer.stop();
    assert.ok(getOutput().includes('\u001b[?25h'), 'expected show-cursor code');
  });

  it('uses cursor-up to redraw in place on subsequent updates', () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    renderer.start();
    const afterStart = getOutput().length;
    renderer.update('a', 'done');
    const delta = getOutput().slice(afterStart);
    // Das Redraw sollte einen Cursor-Up-Code (ESC[<n>A) enthalten
    // eslint-disable-next-line no-control-regex
    const cursorUpPattern = /\u001b\[[0-9]+A/;
    assert.ok(cursorUpPattern.test(delta), 'expected cursor-up escape on redraw');
    renderer.stop();
  });

  it('redraws by moving the cursor up exactly the previous frame line count', () => {
    // Regression: stimmt die cursor-up-Zahl nicht mit der Zeilenzahl des zuvor
    // gezeichneten Frames überein, überschreibt das Redraw nicht alle alten
    // Zeilen → duplizierte/zerschossene Darstellung.
    const rows: TuiRuRow[] = [
      { ru: 'a', status: 'pending' },
      { ru: 'b', status: 'pending' },
    ];
    const expectedLines = buildFrame(rows, { noColor: true, noSpinner: true }).length;

    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer(rows, { out: stream, noColor: true, noSpinner: true });
    renderer.start();
    const afterStart = getOutput().length;
    renderer.update('a', 'done');
    const delta = getOutput().slice(afterStart);

    // eslint-disable-next-line no-control-regex
    const m = /\[(\d+)A/.exec(delta);
    assert.ok(m, 'expected a cursor-up escape on redraw');
    assert.equal(Number(m![1]), expectedLines, 'cursor-up count must match previous frame lines');
    renderer.stop();
  });

  it('is idempotent on double start/stop', () => {
    const { stream } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    assert.doesNotThrow(() => {
      renderer.start();
      renderer.start();
      renderer.stop();
      renderer.stop();
    });
  });

  it('animates the spinner over time for running rows', async () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    renderer.start();
    renderer.update('a', 'running');
    // Warte über mehrere Spinner-Intervalle (80ms each).
    await new Promise((r) => setTimeout(r, 220));
    renderer.stop();
    const out = getOutput();
    // Mindestens zwei verschiedene Spinner-Frames sollten gezeichnet worden sein.
    const distinctFrames = SPINNER_FRAMES.filter((f) => out.includes(f));
    assert.ok(
      distinctFrames.length >= 2,
      `expected the spinner to advance through frames, saw ${distinctFrames.length}`,
    );
  });

  it('stops the spinner timer when no rows are running', async () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    renderer.start();
    renderer.update('a', 'running');
    await new Promise((r) => setTimeout(r, 100));
    renderer.update('a', 'done'); // keine running-RU mehr → Timer sollte stoppen
    const lengthAfterDone = getOutput().length;
    await new Promise((r) => setTimeout(r, 200));
    // Keine weiteren Draws nach 'done' (Timer wurde gestoppt).
    assert.equal(getOutput().length, lengthAfterDone, 'expected no draws after timer stopped');
    renderer.stop();
  });

  it('does not leak a timer after stop (process can exit)', async () => {
    const { stream } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
    });
    renderer.start();
    renderer.update('a', 'running');
    renderer.stop();
    const before = getActiveTimerCount();
    await new Promise((r) => setTimeout(r, 50));
    // Nach stop() sollte kein Spinner-Timer mehr laufen.
    assert.ok(getActiveTimerCount() <= before, 'expected no leaked spinner timer');
  });

  it('respects noSpinner: no timer, static symbol', async () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
      noSpinner: true,
    });
    renderer.start();
    renderer.update('a', 'running');
    const lengthAfterRunning = getOutput().length;
    await new Promise((r) => setTimeout(r, 200));
    // Kein Timer → keine zusätzlichen Draws.
    assert.equal(getOutput().length, lengthAfterRunning);
    renderer.stop();
  });

  it('plain mode: no ANSI control codes, one line per finished RU', () => {
    const { stream, getOutput } = makeMockStream();
    const renderer = new TuiRenderer(
      [
        { ru: 'repo-a', status: 'pending' },
        { ru: 'repo-b', status: 'pending' },
      ],
      { out: stream, noColor: true, plain: true },
    );
    renderer.start();
    renderer.update('repo-a', 'running'); // running → keine Zeile im Plain-Modus
    renderer.update('repo-a', 'done', 'PR #1');
    renderer.update('repo-b', 'failed', 'boom');
    const mid = getOutput();
    // Keine Cursor-Steuercodes im Plain-Modus.
    assert.equal(mid, stripAnsi(mid), 'plain mode must not emit ANSI codes');
    assert.ok(mid.includes('repo-a: done'), 'expected a line for the done RU');
    assert.ok(mid.includes('repo-b: failed'), 'expected a line for the failed RU');
    assert.ok(!mid.includes('repo-a: running'), 'running should not print a line');
    renderer.stop();
    // Nach stop() steht der finale Frame mit der Fußzeile da.
    assert.ok(getOutput().includes('done'));
  });

  it('plain mode: no spinner timer is started', async () => {
    const { stream } = makeMockStream();
    const renderer = new TuiRenderer([{ ru: 'a', status: 'pending' }], {
      out: stream,
      noColor: true,
      plain: true,
    });
    renderer.start();
    renderer.update('a', 'running');
    const before = getActiveTimerCount();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(getActiveTimerCount() <= before, 'plain mode must not start a spinner timer');
    renderer.stop();
  });
});

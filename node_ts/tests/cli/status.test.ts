/**
 * Tests für die reinen Formatter von `gitbulk status`
 * (`formatStatusReport` / `formatStatusJson`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatStatusReport, formatStatusJson } from '../../src/cli/status.js';
import type { PrStatusReport } from '../../src/git/pr-status.js';

const ESC = String.fromCharCode(27);

const report: PrStatusReport = {
  ticket: 'AKB-1',
  sourceBranch: 'AKB-1-feature/x',
  platform: 'bitbucket',
  results: [
    { ru: 'repo-a', state: 'merged', id: 1, url: 'https://x/1' },
    { ru: 'repo-b', state: 'open', id: 2, url: 'https://x/2' },
    { ru: 'repo-c', state: 'none' },
    { ru: 'repo-d', state: 'none', error: 'boom' },
  ],
  totals: { open: 1, merged: 1, declined: 0, none: 1, errored: 1 },
};

describe('formatStatusReport', () => {
  it('renders header, rows and a summary (no-color)', () => {
    const out = formatStatusReport(report, { noColor: true });
    assert.match(out, /Ticket AKB-1/);
    assert.match(out, /AKB-1-feature\/x/);
    assert.match(out, /bitbucket/);
    assert.match(out, /4 RUs/);
    // Zeilen mit PR-Nummern und States.
    assert.match(out, /repo-a.*#1.*merged.*https:\/\/x\/1/);
    assert.match(out, /repo-b.*#2.*open/);
    assert.match(out, /repo-c.*-.*none/);
    // Fehlerzeile zeigt die Meldung statt einer URL.
    assert.match(out, /repo-d.*error.*\(error: boom\)/);
    // Summary inkl. Fehler-Zähler.
    assert.match(out, /Summary: 1 merged · 1 open · 0 declined · 1 none · 1 error/);
  });

  it('omits the error counter from the summary when there are none', () => {
    const clean: PrStatusReport = {
      ...report,
      results: [{ ru: 'r', state: 'open', id: 1 }],
      totals: { open: 1, merged: 0, declined: 0, none: 0, errored: 0 },
    };
    const out = formatStatusReport(clean, { noColor: true });
    assert.match(out, /Summary: 0 merged · 1 open · 0 declined · 0 none\n?$/);
    assert.doesNotMatch(out, /error/);
  });

  it('produces no ANSI escapes with noColor, but does with color', () => {
    const plain = formatStatusReport(report, { noColor: true });
    const colored = formatStatusReport(report, { noColor: false });
    assert.equal(plain.includes(ESC), false);
    assert.equal(colored.includes(ESC), true);
  });
});

describe('formatStatusJson', () => {
  it('round-trips to the report object', () => {
    const parsed = JSON.parse(formatStatusJson(report)) as PrStatusReport;
    assert.equal(parsed.ticket, 'AKB-1');
    assert.equal(parsed.sourceBranch, 'AKB-1-feature/x');
    assert.equal(parsed.results.length, 4);
    assert.deepEqual(parsed.totals, { open: 1, merged: 1, declined: 0, none: 1, errored: 1 });
  });
});

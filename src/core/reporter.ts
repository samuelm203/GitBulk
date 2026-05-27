/**
 * Reporter — formatiert eine `RunSummary` für die CLI-Ausgabe.
 *
 * Die Logik ist absichtlich aus dem Runner herausgehalten, damit der Runner
 * pure Daten liefert und der Reporter sich um die Darstellung kümmert. So
 * können wir später JSON-Output, Markdown-Report etc. ohne Eingriff am
 * Runner ergänzen.
 */

import chalk from 'chalk';

import type { RuResult, RunSummary } from './runner.js';

/**
 * Symbol + Farbe pro Outcome-Typ.
 */
const OUTCOME_STYLES: Record<
  RuResult['outcome'],
  { symbol: string; color: (s: string) => string; label: string }
> = {
  'pr-created': { symbol: '✓', color: chalk.green, label: 'PR created' },
  'pr-skipped': { symbol: '○', color: chalk.gray, label: 'skipped' },
  'pr-failed': { symbol: '✗', color: chalk.red, label: 'PR failed' },
  'not-processed': { symbol: '–', color: chalk.dim, label: 'not processed' },
  'fatal-error': { symbol: '!', color: chalk.red.bold, label: 'fatal error' },
};

/**
 * Formatiert eine Zeit-Dauer als kompakten String (z. B. `1.2s` oder `345ms`).
 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec.toString().padStart(2, '0')}s`;
}

/**
 * Padding-Helfer, der Farbcodes ignoriert.
 */
function padEndPlain(str: string, plainStr: string, width: number): string {
  const pad = Math.max(0, width - plainStr.length);
  return str + ' '.repeat(pad);
}

/**
 * Druckt die `RunSummary` als Tabelle auf stdout.
 */
export function printRunSummary(summary: RunSummary, options: { noColor?: boolean } = {}): void {
  const useColor = !options.noColor;
  const out = process.stdout;

  // Spalten-Breiten berechnen
  const ruWidth = Math.max(8, ...summary.results.map((r) => r.ru.length));
  const statusWidth = 14;
  const detailWidth = 50;
  const durationWidth = 8;

  // ── Header ─────────────────────────────────────────────────────
  out.write('\n');
  const title = `── GitBulk Run Summary ${'─'.repeat(60)}`.slice(0, 84);
  out.write(`${useColor ? chalk.bold(title) : title}\n`);

  const header = [
    'RU'.padEnd(ruWidth),
    'Status'.padEnd(statusWidth),
    'Detail'.padEnd(detailWidth),
    'Duration'.padEnd(durationWidth),
  ].join('  ');
  out.write(`${useColor ? chalk.dim(header) : header}\n`);

  // ── Zeilen ─────────────────────────────────────────────────────
  for (const r of summary.results) {
    const style = OUTCOME_STYLES[r.outcome];

    // Detail-Spalte: aussagekräftigste Info
    const detail = pickDetail(r);
    const detailTrunc = detail.length > detailWidth ? `${detail.slice(0, detailWidth - 1)}…` : detail;

    const ruCol = r.ru.padEnd(ruWidth);
    const statusLabel = `${style.symbol} ${style.label}`;
    const statusCol = padEndPlain(
      useColor ? style.color(statusLabel) : statusLabel,
      statusLabel,
      statusWidth,
    );
    const detailCol = detailTrunc.padEnd(detailWidth);
    const durationCol = fmtDuration(r.durationMs).padEnd(durationWidth);

    out.write(`${ruCol}  ${statusCol}  ${detailCol}  ${durationCol}\n`);

    // Bei Fehlern: Details ausgeben (eingerückt)
    if (r.outcome === 'pr-failed' || r.outcome === 'fatal-error') {
      const errMsg = r.phase3.fatalError ?? r.phase4.error ?? '(no details)';
      const indented = `    ${useColor ? chalk.dim('└') : '└'} ${errMsg}`;
      out.write(`${indented}\n`);
    }
  }

  // ── Totals ─────────────────────────────────────────────────────
  out.write('\n');
  const t = summary.totals;
  const parts = [
    useColor ? chalk.green(`${t.prsCreated} created`) : `${t.prsCreated} created`,
    useColor ? chalk.gray(`${t.prsSkipped} skipped`) : `${t.prsSkipped} skipped`,
    useColor ? chalk.red(`${t.prsFailed} failed`) : `${t.prsFailed} failed`,
    useColor ? chalk.dim(`${t.notProcessed} not processed`) : `${t.notProcessed} not processed`,
  ];
  if (t.fatalErrors > 0) {
    parts.push(useColor ? chalk.red.bold(`${t.fatalErrors} fatal`) : `${t.fatalErrors} fatal`);
  }
  out.write(`Total: ${t.rus} RUs — ${parts.join(', ')} — ${fmtDuration(summary.totalDurationMs)}\n`);

  // PR-URLs auflisten
  const created = summary.results.filter((r) => r.outcome === 'pr-created' && r.phase4.prUrl);
  if (created.length > 0) {
    out.write('\n');
    out.write(useColor ? chalk.bold('Created PRs:\n') : 'Created PRs:\n');
    for (const r of created) {
      out.write(`  • ${r.ru}: ${r.phase4.prUrl}\n`);
    }
  }
  out.write('\n');
}

/**
 * Wählt den aussagekräftigsten Detail-Text pro Zeile.
 */
function pickDetail(r: RuResult): string {
  if (r.outcome === 'pr-created' && r.phase4.prId !== undefined) {
    return `PR #${r.phase4.prId}`;
  }
  if (r.outcome === 'pr-failed') {
    return r.phase4.error ?? '(no error message)';
  }
  if (r.outcome === 'fatal-error') {
    return r.phase3.fatalError ?? '(unknown)';
  }
  // Skip / not-processed: erste relevante Note nehmen
  const notes = [...r.phase3.notes, ...r.phase4.notes];
  return notes[0] ?? '';
}

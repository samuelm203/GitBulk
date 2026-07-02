/**
 * `--retry-failed <report.json>` — nur die fehlgeschlagenen RUs eines
 * vorherigen Laufs erneut verarbeiten.
 *
 * Liest den mit `--report` geschriebenen JSON-Report und liefert die RU-Namen,
 * deren Outcome ein erneutes Ausführen rechtfertigt:
 *
 *   - `pr-failed`     → PR-Erstellung schlug fehl
 *   - `fatal-error`   → RU brach mit Fehler ab
 *   - `not-processed` → RU kam nie dran (z. B. Ctrl+C)
 *
 * `pr-created` und `pr-skipped` (kein Diff) werden NICHT wiederholt.
 * Die eigentliche Filterung der Config übernimmt der Aufrufer via `filterRus`
 * (inkl. Validierung gegen die konfigurierten RUs).
 */

import { readFileSync } from 'node:fs';

import { REPORT_VERSION } from '../core/report-file.js';

/** Outcomes, die einen erneuten Lauf rechtfertigen. */
const RETRYABLE_OUTCOMES = new Set(['pr-failed', 'fatal-error', 'not-processed']);

/**
 * Liest die zu wiederholenden RU-Namen aus einem Report.
 *
 * @throws {Error} mit klarer Meldung bei fehlender/unlesbarer Datei, kaputtem
 *                 JSON oder unerwartetem Format (kein `results`-Array).
 */
export function readFailedRus(reportPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(reportPath, 'utf8');
  } catch (err) {
    throw new Error(`--retry-failed: cannot read report file: ${(err as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`--retry-failed: "${reportPath}" is not valid JSON.`);
  }

  const report = data as { reportVersion?: unknown; results?: unknown };
  if (!Array.isArray(report.results)) {
    throw new Error(
      `--retry-failed: "${reportPath}" is not a GitBulk run report (missing "results" array). ` +
        'Generate one with `gitbulk --config … --report out.json`.',
    );
  }
  // Vorwärts-Kompatibilität: eine höhere reportVersion klar ablehnen statt
  // still falsch zu interpretieren.
  if (typeof report.reportVersion === 'number' && report.reportVersion > REPORT_VERSION) {
    throw new Error(
      `--retry-failed: report version ${report.reportVersion} is newer than supported (${REPORT_VERSION}). ` +
        'Update gitbulk.',
    );
  }

  const rus: string[] = [];
  for (const entry of report.results) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { ru?: unknown; outcome?: unknown };
    if (typeof e.ru === 'string' && typeof e.outcome === 'string' && RETRYABLE_OUTCOMES.has(e.outcome)) {
      rus.push(e.ru);
    }
  }
  return rus;
}

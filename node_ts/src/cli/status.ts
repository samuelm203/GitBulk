/**
 * `gitbulk status` — zeigt für die RUs einer Config den PR-Status an
 * (read-only). Nutzt dieselbe Config-Beschaffung, Token-Auflösung und
 * Adapter-Factory wie der Bulk-Flow, führt aber KEINE Git-/Schreib-Operationen
 * aus — nur API-Abfragen.
 *
 * Ausgabe: eine Tabelle (RU ▸ PR ▸ State ▸ URL) plus Summary, oder via `--json`
 * eine maschinenlesbare Struktur (für CI).
 */

import process from 'node:process';

import * as colors from '../utils/colors.js';
import { loadConfig, ConfigError } from '../config/loader.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import {
  collectPrStatus,
  adapterSupportsStatus,
  type PrStatusReport,
} from '../git/pr-status.js';
import { ensurePrToken } from './token-prompt.js';
import { filterRus } from './filter-rus.js';

/** Optionen für {@link runStatus}. */
export interface StatusOptions {
  /** Pfad zur Config-Datei. Fehlt er → interaktive Config-Beschaffung. */
  configPath?: string;
  /** Config-Modus (strict/hybrid). */
  mode?: 'strict' | 'hybrid';
  /** RU-Filter (komma-separierte Teilmenge), entspricht `--only`. */
  only?: string;
  /** JSON statt Tabelle ausgeben. */
  json?: boolean;
  /** Farben deaktivieren. */
  noColor?: boolean;
}

/** Liefert die Farbfunktion für ein State-Label. */
function stateColorFn(label: string): (s: string) => string {
  switch (label) {
    case 'open':
      return colors.cyan;
    case 'merged':
      return colors.green;
    case 'declined':
      return colors.yellow;
    case 'error':
      return colors.red;
    default:
      return colors.gray; // none
  }
}

/** Rechts mit Leerzeichen auf Breite `w` auffüllen (für Tabellen-Spalten). */
function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/**
 * Rendert den Report als menschen-lesbare Tabelle (mit optionaler Farbe).
 */
export function formatStatusReport(
  report: PrStatusReport,
  opts: { noColor?: boolean } = {},
): string {
  const useColor = opts.noColor !== true;
  const dim = (s: string): string => (useColor ? colors.dim(s) : s);

  const rows = report.results.map((r) => {
    const isError = r.error !== undefined;
    return {
      ru: r.ru,
      pr: r.id !== undefined ? `#${r.id}` : '-',
      stateLabel: isError ? 'error' : r.state,
      note: isError ? `(error: ${r.error ?? ''})` : (r.url ?? ''),
    };
  });

  const wRu = Math.max('RU'.length, ...rows.map((x) => x.ru.length));
  const wPr = Math.max('PR'.length, ...rows.map((x) => x.pr.length));
  const wState = Math.max('STATE'.length, ...rows.map((x) => x.stateLabel.length));

  const lines: string[] = [];
  lines.push(
    `Ticket ${report.ticket} · branch ${report.sourceBranch} · ${report.platform} · ${report.results.length} RUs`,
  );
  lines.push('');
  lines.push(dim(`${pad('RU', wRu)}  ${pad('PR', wPr)}  ${pad('STATE', wState)}  URL`));

  for (const x of rows) {
    const stateCellPlain = pad(x.stateLabel, wState);
    const stateCell = useColor ? stateColorFn(x.stateLabel)(stateCellPlain) : stateCellPlain;
    lines.push(`${pad(x.ru, wRu)}  ${pad(x.pr, wPr)}  ${stateCell}  ${x.note}`.trimEnd());
  }

  const t = report.totals;
  lines.push('');
  let summary = `Summary: ${t.merged} merged · ${t.open} open · ${t.declined} declined · ${t.none} none`;
  if (t.errored > 0) summary += ` · ${t.errored} error`;
  lines.push(summary);

  return `${lines.join('\n')}\n`;
}

/** Rendert den Report als JSON (für `--json`). */
export function formatStatusJson(report: PrStatusReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Führt das `status`-Subkommando aus.
 *
 * @returns Exit-Code (0 = ok, 3 = Setup-/Plattform-Fehler).
 */
export async function runStatus(opts: StatusOptions): Promise<number> {
  const useColor = opts.noColor !== true;
  const printErr = (msg: string): void => {
    const prefix = useColor ? colors.redBold('Error:') : 'Error:';
    process.stderr.write(`${prefix} ${msg}\n`);
  };

  // ── Config laden (Datei oder interaktiv) ───────────────────────
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    const loadOpts: { path?: string; mode?: 'strict' | 'hybrid' } = {};
    if (opts.configPath) loadOpts.path = opts.configPath;
    if (opts.mode) loadOpts.mode = opts.mode;
    config = await loadConfig(loadOpts);
  } catch (err) {
    printErr(err instanceof ConfigError ? err.format() : (err as Error).message);
    return 3;
  }

  // ── --only: RU-Teilmenge ───────────────────────────────────────
  try {
    config = filterRus(config, opts.only);
  } catch (err) {
    printErr((err as Error).message);
    return 3;
  }

  // ── Token sicherstellen (env > store > prompt) ─────────────────
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tokenCheck = await ensurePrToken(config.prPlatform, { interactive });
  if (!tokenCheck.ok) {
    printErr(tokenCheck.error);
    return 3;
  }

  // ── Adapter bauen ──────────────────────────────────────────────
  let adapter: Awaited<ReturnType<typeof createPrAdapter>>;
  try {
    adapter = await createPrAdapter(config);
  } catch (err) {
    printErr(err instanceof PrAdapterError ? err.message : (err as Error).message);
    return 3;
  }

  if (!adapterSupportsStatus(adapter)) {
    printErr(`\`gitbulk status\` is not supported for platform "${adapter.platformName}" yet.`);
    return 3;
  }

  // ── Status sammeln + ausgeben ──────────────────────────────────
  const report = await collectPrStatus(config, adapter);
  if (opts.json === true) {
    process.stdout.write(`${formatStatusJson(report)}\n`);
  } else {
    process.stdout.write(formatStatusReport(report, { noColor: !useColor }));
  }
  return 0;
}

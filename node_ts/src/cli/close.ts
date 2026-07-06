/**
 * `gitbulk close` — schließt die offenen PRs eines Ticket/Branch über alle RUs
 * und löscht die Remote-Feature-Branches (Aufräumen nach einem Fehl-Lauf).
 *
 * Destruktiv → ohne `--dry-run` wird im Terminal bestätigt (oder `--yes` für
 * CI). Nutzt dieselbe Config-Beschaffung, Token-Auflösung und Adapter-Factory
 * wie der Bulk-Flow.
 */

import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import * as colors from '../utils/colors.js';
import { loadConfig, ConfigError } from '../config/loader.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import { closePullRequests, adapterSupportsClose, type CloseReport } from '../git/pr-close.js';
import { detectGit } from '../git/executor.js';
import { ensurePrToken } from './token-prompt.js';
import { filterRus } from './filter-rus.js';

/** Optionen für {@link runClose}. */
export interface CloseOptions {
  /** Pfad zur Config-Datei. Fehlt er → interaktive Config-Beschaffung. */
  configPath?: string;
  /** Config-Modus (strict/hybrid). */
  mode?: 'strict' | 'hybrid';
  /** RU-Filter (komma-separierte Teilmenge), entspricht `--only`. */
  only?: string;
  /** Nur anzeigen, was passieren würde. */
  dryRun?: boolean;
  /** Bestätigung überspringen (für CI). */
  yes?: boolean;
  /** JSON statt Tabelle ausgeben. */
  json?: boolean;
  /** Farben deaktivieren. */
  noColor?: boolean;
}

/** Rechts mit Leerzeichen auf Breite `w` auffüllen. */
function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Rendert den Close-Report als menschen-lesbare Tabelle. */
export function formatCloseReport(report: CloseReport, opts: { noColor?: boolean } = {}): string {
  const useColor = opts.noColor !== true;
  const dim = (s: string): string => (useColor ? colors.dim(s) : s);
  const prColor = (label: string): ((s: string) => string) => {
    switch (label) {
      case 'closed':
      case 'would-close':
        return colors.green;
      case 'close-failed':
      case 'error':
        return colors.red;
      default:
        return colors.gray;
    }
  };

  const rows = report.results.map((r) => ({
    ru: r.ru,
    pr: r.prId !== undefined ? `#${r.prId}` : '-',
    prOutcome: r.pr,
    branch: r.branch,
    note: r.error !== undefined ? `(error: ${r.error})` : (r.prUrl ?? ''),
  }));

  const wRu = Math.max('RU'.length, ...rows.map((x) => x.ru.length));
  const wPr = Math.max('PR'.length, ...rows.map((x) => x.pr.length));
  const wOut = Math.max('PR-ACTION'.length, ...rows.map((x) => x.prOutcome.length));
  const wBr = Math.max('BRANCH'.length, ...rows.map((x) => x.branch.length));

  const lines: string[] = [];
  const mode = report.dryRun ? ' · DRY-RUN' : '';
  lines.push(
    `Ticket ${report.ticket} · branch ${report.sourceBranch} · ${report.platform} · ${report.results.length} RUs${mode}`,
  );
  lines.push('');
  lines.push(
    dim(`${pad('RU', wRu)}  ${pad('PR', wPr)}  ${pad('PR-ACTION', wOut)}  ${pad('BRANCH', wBr)}  URL`),
  );
  for (const x of rows) {
    const outPlain = pad(x.prOutcome, wOut);
    const outCell = useColor ? prColor(x.prOutcome)(outPlain) : outPlain;
    lines.push(
      `${pad(x.ru, wRu)}  ${pad(x.pr, wPr)}  ${outCell}  ${pad(x.branch, wBr)}  ${x.note}`.trimEnd(),
    );
  }

  const t = report.totals;
  lines.push('');
  const verb = report.dryRun ? 'would be closed' : 'closed';
  let summary = `Summary: ${t.prsClosed} PRs ${verb} · ${t.noOpenPr} without open PR · ${t.branchesDeleted} branches ${report.dryRun ? 'would be deleted' : 'deleted'}`;
  if (t.failed > 0) summary += ` · ${t.failed} failed`;
  lines.push(summary);

  return `${lines.join('\n')}\n`;
}

/** Fragt die Bestätigung im Terminal ab (y/yes → true). */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Führt das `close`-Subkommando aus.
 *
 * @returns Exit-Code (0 = ok, 1 = mind. ein Close/Delete schlug fehl,
 *          3 = Setup-Fehler/abgebrochen).
 */
export async function runClose(opts: CloseOptions): Promise<number> {
  const useColor = opts.noColor !== true;
  const printErr = (msg: string): void => {
    const prefix = useColor ? colors.redBold('Error:') : 'Error:';
    process.stderr.write(`${prefix} ${msg}\n`);
  };

  // Branch-Löschung braucht git (lokale Repos).
  const gitVersion = await detectGit();
  if (!gitVersion) {
    printErr('git is not installed or not in PATH. Please install git first.');
    return 3;
  }

  // ── Config laden ───────────────────────────────────────────────
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

  const dryRun = opts.dryRun === true || config.dryRun;

  // ── Bestätigung (destruktiv) ───────────────────────────────────
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!dryRun && opts.yes !== true) {
    if (!interactive) {
      printErr(
        '`gitbulk close` is destructive — pass --yes in non-interactive mode ' +
          '(or preview with --dry-run first).',
      );
      return 3;
    }
    const ok = await confirm(
      `Close all open PRs for ticket ${config.ticket} (${config.rus.length} RUs) ` +
        'and delete the remote feature branches? [y/N] ',
    );
    if (!ok) {
      process.stderr.write('Aborted — nothing was changed.\n');
      return 3;
    }
  }

  // ── Token sicherstellen ────────────────────────────────────────
  const tokenCheck = await ensurePrToken(config.prPlatform, { interactive });
  if (!tokenCheck.ok) {
    printErr(tokenCheck.error);
    return 3;
  }

  // ── Adapter bauen + Fähigkeit prüfen ───────────────────────────
  let adapter: Awaited<ReturnType<typeof createPrAdapter>>;
  try {
    adapter = await createPrAdapter(config);
  } catch (err) {
    printErr(err instanceof PrAdapterError ? err.message : (err as Error).message);
    return 3;
  }
  if (!adapterSupportsClose(adapter)) {
    printErr(`\`gitbulk close\` is not supported for platform "${adapter.platformName}" yet.`);
    return 3;
  }

  // ── Schließen + Report ─────────────────────────────────────────
  const report = await closePullRequests(config, adapter, { dryRun });
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatCloseReport(report, { noColor: !useColor }));
  }
  return report.totals.failed > 0 ? 1 : 0;
}

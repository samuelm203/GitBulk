/**
 * TUI-Orchestrierung (Zero-Dependency).
 *
 * Verbindet:
 *   1. Config-Beschaffung — Datei laden ODER interaktiv (via `loadConfig`,
 *      das beide Fälle abdeckt: mit `path` → Datei/Hybrid, ohne → interaktiv).
 *   2. PR-Adapter-Bau.
 *   3. Runner-Lauf mit `onProgress`-Callback, der den Live-Renderer speist.
 *   4. Abschluss-Report.
 *
 * Wichtig: Während die interaktiven Prompts laufen (readline), darf der
 * Live-Renderer NICHT aktiv sein — beide würden um stdout konkurrieren.
 * Deshalb ist die Reihenfolge strikt: erst Config (ggf. mit Prompts),
 * DANN Renderer starten.
 */

import process from 'node:process';

import { loadConfig, ConfigError } from '../config/loader.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import { runBulk, type RuProgressEvent } from '../core/runner.js';
import { printRunSummary } from '../core/reporter.js';
import { detectGit } from '../git/executor.js';
import { createLogger, setDefaultLogger } from '../utils/logger.js';
import { TuiRenderer, type TuiRuRow, type TuiRuStatus } from './render.js';
import { filterRus } from '../cli/filter-rus.js';

/**
 * Optionen für den TUI-Lauf.
 */
export interface TuiOptions {
  /** Pfad zur Config-Datei. Wenn weggelassen → rein interaktiv. */
  configPath?: string;
  /** Config-Modus (strict/hybrid). */
  mode?: 'strict' | 'hybrid';
  /** Dry-Run erzwingen (überschreibt Config). */
  dryRun?: boolean;
  /** Farben deaktivieren. */
  noColor?: boolean;
  /** RU-Filter (komma-separierte Teilmenge), entspricht `--only`. */
  only?: string;
  /** AbortSignal (z. B. Ctrl+C). */
  signal?: AbortSignal;
}

/**
 * Mappt einen Runner-Progress-Status auf einen TUI-Status.
 * (Die beiden Typen sind fast identisch, aber bewusst entkoppelt, damit
 * die TUI eigene Zustände wie `pending` haben kann, die der Runner nicht kennt.)
 */
function progressToTuiStatus(status: RuProgressEvent['status']): TuiRuStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
  }
}

/**
 * Detailtext für eine abgeschlossene RU (PR-Nummer oder Kurzfehler).
 * Wird erst im finalen Report ausführlich; hier nur knapp für die Live-Zeile.
 */
function detailForOutcome(event: RuProgressEvent): string | undefined {
  if (event.outcome === 'pr-created') return 'PR created';
  if (event.outcome === 'pr-failed') return 'PR failed';
  if (event.outcome === 'fatal-error') return 'error';
  return undefined;
}

/**
 * Startet die TUI: Config beschaffen, Lauf mit Live-Fortschritt, Report.
 *
 * @returns Exit-Code (0 = ok, 1 = PR-Fehler, 2 = fatal, 3 = Setup-Fehler)
 */
export async function runTui(options: TuiOptions = {}): Promise<number> {
  // Ist stdout ein echtes Terminal? In Pipes/Dateien/CI keine ANSI-Steuercodes
  // und keine Spinner-Animation ausgeben (würde nur Escape-Müll erzeugen).
  const isTty = process.stdout.isTTY === true;
  // Farben aus, wenn: explizit per Option, per NO_COLOR-Env (De-facto-Standard),
  // oder wenn kein TTY vorliegt.
  const noColorEnv = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
  const useColor = !options.noColor && !noColorEnv && isTty;
  // Spinner nur bei echtem TTY (sonst statisches Symbol, keine Live-Animation).
  const useSpinner = isTty;

  // WICHTIG: Im TUI-Modus MÜSSEN alle Logs nach stderr — sonst kollidieren sie
  // mit dem stdout-basierten Live-Renderer (cursor-up/clear-line), verschieben
  // dessen Frame und führen zu duplizierter/zerschossener Darstellung. stdout
  // gehört exklusiv dem Renderer + dem Abschluss-Report.
  const logger = createLogger({
    level: 'warn',
    noColor: !useColor,
    stdout: process.stderr,
    stderr: process.stderr,
  });
  setDefaultLogger(logger);

  const writeErr = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  // ── Git-Verfügbarkeit ──────────────────────────────────────────
  const gitVersion = await detectGit();
  if (!gitVersion) {
    writeErr('Error: git is not installed or not in PATH.');
    return 3;
  }

  // ── Config beschaffen (Datei ODER interaktiv) ──────────────────
  // WICHTIG: Das passiert VOR dem Renderer-Start, weil interaktive Prompts
  // und der Live-Renderer nicht gleichzeitig auf stdout schreiben dürfen.
  let config;
  try {
    const loadOpts: { path?: string; mode?: 'strict' | 'hybrid' } = {};
    if (options.configPath) loadOpts.path = options.configPath;
    if (options.mode) loadOpts.mode = options.mode;
    config = await loadConfig(loadOpts);
  } catch (err) {
    if (err instanceof ConfigError) {
      writeErr(`Error: ${err.format()}`);
    } else {
      writeErr(`Error: ${(err as Error).message}`);
    }
    return 3;
  }

  // Dry-Run-Override (Config ist frozen → flache Kopie).
  if (options.dryRun && !config.dryRun) {
    config = Object.freeze({ ...config, dryRun: true });
  }

  // --only: RU-Liste auf eine Teilmenge beschränken.
  try {
    config = filterRus(config, options.only);
  } catch (err) {
    writeErr(`Error: ${(err as Error).message}`);
    return 3;
  }

  // ── PR-Adapter ─────────────────────────────────────────────────
  let adapter;
  try {
    adapter = await createPrAdapter(config);
  } catch (err) {
    if (err instanceof PrAdapterError) {
      writeErr(`Error: ${err.message}`);
    } else {
      writeErr(`Error: ${(err as Error).message}`);
    }
    return 3;
  }

  // ── Renderer vorbereiten ───────────────────────────────────────
  const rows: TuiRuRow[] = config.rus.map((ru) => ({ ru, status: 'pending' as const }));
  const renderer = new TuiRenderer(rows, {
    noColor: !useColor,
    noSpinner: !useSpinner,
    plain: !isTty,
    title: `GitBulk — ${config.rus.length} RUs, concurrency ${config.concurrency}${config.dryRun ? ' [DRY-RUN]' : ''}`,
  });

  renderer.start();

  // ── Lauf mit Live-Progress ─────────────────────────────────────
  const runOpts: Parameters<typeof runBulk>[1] = {
    prAdapter: adapter,
    logger,
    onProgress: (event: RuProgressEvent) => {
      renderer.update(event.ru, progressToTuiStatus(event.status), detailForOutcome(event));
    },
  };
  if (options.signal) runOpts.signal = options.signal;

  let summary;
  try {
    summary = await runBulk(config, runOpts);
  } catch (err) {
    renderer.stop();
    writeErr(`Error during run: ${(err as Error).message}`);
    return 3;
  }

  renderer.stop();

  // ── Abschluss-Report (ausführlich, unter der Live-Liste) ───────
  printRunSummary(summary, { noColor: !useColor });

  if (summary.totals.fatalErrors > 0) return 2;
  if (summary.totals.prsFailed > 0) return 1;
  return 0;
}

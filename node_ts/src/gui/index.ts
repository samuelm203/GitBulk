/**
 * GUI-Orchestrierung (`gitbulk --gui`).
 *
 * Analog zur TUI (`src/tui/index.ts`) ein zweiter View-Layer über dem
 * unveränderten Runner:
 *   1. Config beschaffen (Datei ODER interaktiv) + Token-Guard im Terminal.
 *   2. Lokalen GUI-Server starten (127.0.0.1) und den Browser öffnen.
 *   3. Der Lauf startet per Button in der GUI (POST /start); Fortschritt,
 *      Logs und Summary streamen via SSE in die Seite.
 *   4. Nach Lauf-Ende: Summary zusätzlich im Terminal, kurze Flush-Grace,
 *      Server schließen, Exit-Code wie im CLI-Pfad.
 */

import process from 'node:process';

import open, { openApp, apps } from 'open';

import { loadConfig, ConfigError } from '../config/loader.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import { runBulk, type RuProgressEvent, type RunSummary } from '../core/runner.js';
import { printRunSummary } from '../core/reporter.js';
import { detectGit } from '../git/executor.js';
import { createLogger, setDefaultLogger, LogCapture } from '../utils/logger.js';
import { ensurePrToken } from '../cli/token-prompt.js';
import { writeDeepLogFile } from '../cli/deep-log.js';
import { filterRus } from '../cli/filter-rus.js';
import { startGuiServer } from './server.js';
import { GuiLogSink } from './log-stream.js';

/** Optionen für den GUI-Lauf (Pendant zu `TuiOptions`). */
export interface GuiOptions {
  /** Pfad zur Config-Datei. Wenn weggelassen → rein interaktiv (im Terminal). */
  configPath?: string;
  /** Config-Modus (strict/hybrid). */
  mode?: 'strict' | 'hybrid';
  /** Dry-Run erzwingen (überschreibt Config). */
  dryRun?: boolean;
  /** RU-Filter (komma-separierte Teilmenge), entspricht `--only`. */
  only?: string;
  /** Browser nicht automatisch öffnen (für Tests/Headless). */
  noOpen?: boolean;
  /** AbortSignal (z. B. Ctrl+C). */
  signal?: AbortSignal;
}

/**
 * Öffnet die GUI als EIGENES Fenster (Chromium-App-Modus: keine Tabs, keine
 * Adressleiste — wirkt wie eine native Anwendung). Reihenfolge: Edge (auf
 * Windows immer vorhanden) → Chrome → Fallback Standard-Browser.
 */
async function openGuiWindow(url: string): Promise<void> {
  const appArguments = [`--app=${url}`, '--window-size=1240,920'];
  for (const candidate of [apps.edge, apps.chrome]) {
    try {
      await openApp(candidate, { arguments: appArguments });
      return;
    } catch {
      // Kandidat nicht installiert → nächsten probieren.
    }
  }
  try {
    await open(url);
  } catch {
    process.stderr.write('Could not open a window automatically — open the URL manually.\n');
  }
}

/**
 * Startet den GUI-Modus: Server + App-Fenster, Lauf per Button, Live-Streaming.
 *
 * @returns Exit-Code (0 = ok, 1 = PR-Fehler, 2 = fatal, 3 = Setup-Fehler)
 */
export async function runGui(options: GuiOptions = {}): Promise<number> {
  const writeErr = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  // ── Git-Verfügbarkeit ──────────────────────────────────────────
  const gitVersion = await detectGit();
  if (!gitVersion) {
    writeErr('Error: git is not installed or not in PATH.');
    return 3;
  }

  // ── Config beschaffen (Datei ODER interaktiv im Terminal) ──────
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

  if (options.dryRun && !config.dryRun) {
    config = Object.freeze({ ...config, dryRun: true });
  }

  try {
    config = filterRus(config, options.only);
  } catch (err) {
    writeErr(`Error: ${(err as Error).message}`);
    return 3;
  }

  // ── Auth-Guard: Token VOR dem Serverstart (Prompt im Terminal) ──
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tokenCheck = await ensurePrToken(config.prPlatform, { interactive });
  if (!tokenCheck.ok) {
    writeErr(`Error: ${tokenCheck.error}`);
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

  // ── Server starten ─────────────────────────────────────────────
  // Der Logger wird NACH dem Serverstart gebaut (er braucht broadcast);
  // die Runner-Closure greift erst bei POST /start auf ihn zu.
  // Deep-Log läuft im GUI-Modus IMMER (keine Option): das granulare Protokoll
  // gehört zum GUI-Erlebnis und wird nach dem Lauf automatisch gespeichert.
  const deepCapture = new LogCapture();
  const frozenConfig = config;
  // Indirektion: der Server braucht den Runner-Callback schon jetzt, der echte
  // Runner entsteht aber erst nach dem Serverstart (Logger braucht broadcast).
  const runnerRef: { run?: () => Promise<RunSummary> } = {};

  const handle = await startGuiServer({
    model: {
      rus: [...frozenConfig.rus],
      dryRun: frozenConfig.dryRun,
      concurrency: frozenConfig.concurrency,
      platform: frozenConfig.prPlatform,
      ticket: frozenConfig.ticket,
      branch: frozenConfig.branch,
    },
    runRunner: () => runnerRef.run!(),
  });

  // Logger: Terminal (stderr) + GUI-Log-Panel. Level 'debug', damit das
  // Live-Log-Panel das volle Deep-Log von Anfang an zeigt (inkl. der
  // einzelnen Git-Schritte); die Capture-Senke sichert parallel jede Zeile.
  const guiSink = new GuiLogSink(process.stderr, handle.broadcast);
  const logger = createLogger({
    level: 'debug',
    noColor: true,
    stdout: guiSink,
    stderr: guiSink,
    capture: deepCapture,
  });
  setDefaultLogger(logger);

  runnerRef.run = () => {
    const runOpts: Parameters<typeof runBulk>[1] = {
      prAdapter: adapter,
      logger,
      onProgress: (event: RuProgressEvent) => {
        handle.broadcast('progress', event);
      },
    };
    if (options.signal) runOpts.signal = options.signal;
    return runBulk(frozenConfig, runOpts);
  };

  process.stderr.write(`GitBulk GUI: ${handle.url} (127.0.0.1 only — start the run in the window)\n`);
  if (options.noOpen !== true) {
    await openGuiWindow(handle.url);
  }

  // ── Auf Lauf-Ende ODER Abbruch warten ──────────────────────────
  const aborted = new Promise<'aborted'>((resolve) => {
    if (!options.signal) return;
    if (options.signal.aborted) resolve('aborted');
    else options.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  let summary: RunSummary;
  try {
    const outcome = await Promise.race([handle.runFinished, aborted]);
    if (outcome === 'aborted' && !handle.started()) {
      // Ctrl+C bevor der Lauf je gestartet wurde → einfach herunterfahren.
      await handle.close();
      return 0; // der CLI-Wrapper mappt aborted → 130
    }
    // Lauf lief (oder Abort während des Laufs: runBulk endet kooperativ selbst).
    summary = outcome === 'aborted' ? await handle.runFinished : outcome;
  } catch (err) {
    await handle.close();
    writeErr(`Error during run: ${(err as Error).message}`);
    return 3;
  }

  // ── Abschluss: Terminal-Report + Deep-Log-Datei + SSE-Grace ────
  printRunSummary(summary, { noColor: false });
  // Deep-Log automatisch speichern (kein Prompt — im GUI-Modus immer aktiv).
  if (deepCapture.size > 0) {
    const target = writeDeepLogFile(deepCapture);
    process.stderr.write(`Deep log written to ${target}\n`);
    handle.broadcast('log', { line: `[INFO] Deep log written to ${target}` });
  }
  await new Promise((r) => setTimeout(r, 1500));
  await handle.close();

  if (summary.totals.fatalErrors > 0) return 2;
  if (summary.totals.prsFailed > 0) return 1;
  return 0;
}

#!/usr/bin/env node
/**
 * GitBulk CLI — Einstiegspunkt.
 *
 * Verdrahtet alle Bausteine:
 *   1. Argument-Parsing via Commander
 *   2. Logger initialisieren (Level, Farbe)
 *   3. Git-Verfügbarkeit prüfen
 *   4. Config laden (Datei + Hybrid, oder rein interaktiv)
 *   5. PR-Adapter bauen
 *   6. Runner ausführen
 *   7. Summary drucken, Exit-Code setzen
 *
 * Exit-Codes:
 *   0 — Alle RUs erfolgreich verarbeitet (auch wenn manche skipped sind)
 *   1 — Mindestens ein PR ist fehlgeschlagen
 *   2 — Mindestens ein RU hatte einen fatalen Fehler
 *   3 — Setup-Fehler (Config, Git nicht gefunden, Token fehlt)
 *  130 — SIGINT (Ctrl+C)
 */

import process from 'node:process';

import { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig, ConfigError } from '../config/loader.js';
import { createLogger, setDefaultLogger, type LogLevel, LOG_LEVELS } from '../utils/logger.js';
import { detectGit } from '../git/executor.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import { runBulk } from '../core/runner.js';
import { printRunSummary } from '../core/reporter.js';
import { runTui } from '../tui/index.js';
import { runInitGenerator } from './init.js';
import { VERSION } from '../index.js';

/** Optionen des `init`-Subkommandos. */
interface InitCommandOptions {
  output?: string;
  force?: boolean;
}

/**
 * Baut die Commander-Program-Instanz inkl. `init`-Subkommando.
 *
 * @param onInit - Callback, der ausgeführt wird, wenn `gitbulk init` läuft.
 *                 Bekommt die Subkommando-Optionen und die globalen Optionen.
 */
function buildProgram(
  onInit: (cmdOpts: InitCommandOptions, globalOpts: { color: boolean }) => Promise<void>,
): Command {
  const program = new Command();

  program
    .name('gitbulk')
    .description('Configurable CLI tool for bulk operations on Git repositories.')
    .version(VERSION, '-v, --version', 'Print version and exit')
    .option('-c, --config <path>', 'Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)')
    .option(
      '-m, --mode <mode>',
      'Config mode: "strict" (file must be complete) or "hybrid" (prompt for missing fields)',
      'hybrid',
    )
    .option('--dry-run', 'Do not perform any write operations (push, PR API)', false)
    .option('--tui', 'Run with an interactive terminal UI showing live per-RU progress', false)
    .option(
      '-l, --log-level <level>',
      `Log level: ${LOG_LEVELS.join(' | ')}`,
      'info',
    )
    .option('--no-color', 'Disable colored output');

  program
    .command('init')
    .description('Interactively generate an operations config or a standalone .mjs code-change script')
    .option('-o, --output <path>', 'Output file path')
    .option('-f, --force', 'Overwrite the output file if it already exists', false)
    .action(async (cmdOpts: InitCommandOptions) => {
      await onInit(cmdOpts, program.opts<{ color: boolean }>());
    });

  return program;
}

/**
 * Validiert das `--log-level`-Argument und liefert es typisiert zurück.
 */
function parseLogLevel(value: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  throw new Error(`Invalid log level "${value}". Allowed: ${LOG_LEVELS.join(', ')}`);
}

/**
 * Druckt einen fett markierten Fehler nach stderr.
 */
function printError(message: string, useColor: boolean): void {
  const prefix = useColor ? chalk.red.bold('Error:') : 'Error:';
  process.stderr.write(`${prefix} ${message}\n`);
}

/**
 * Berechnet den passenden Exit-Code aus der RunSummary.
 */
function exitCodeFromSummary(summary: Awaited<ReturnType<typeof runBulk>>): number {
  if (summary.totals.fatalErrors > 0) return 2;
  if (summary.totals.prsFailed > 0) return 1;
  return 0;
}

/**
 * Hauptfunktion. Wirft NICHT — Fehler werden geloggt und Exit-Code wird gesetzt.
 */
async function main(): Promise<number> {
  // `init`-Subkommando: läuft während parseAsync. Das Ergebnis fangen wir ab,
  // damit der reguläre Bulk-Flow danach NICHT mehr ausgeführt wird.
  let initResult: number | undefined;
  const program = buildProgram(async (cmdOpts, globalOpts) => {
    const initOpts: Parameters<typeof runInitGenerator>[0] = { noColor: !globalOpts.color };
    if (cmdOpts.output !== undefined) initOpts.outputPath = cmdOpts.output;
    if (cmdOpts.force !== undefined) initOpts.force = cmdOpts.force;
    initResult = await runInitGenerator(initOpts);
  });
  await program.parseAsync(process.argv);
  if (initResult !== undefined) {
    return initResult;
  }

  const opts = program.opts<{
    config?: string;
    mode: string;
    dryRun: boolean;
    tui: boolean;
    logLevel: string;
    color: boolean;
  }>();

  // ── Logger initialisieren ──────────────────────────────────────
  let logLevel: LogLevel;
  try {
    logLevel = parseLogLevel(opts.logLevel);
  } catch (err) {
    printError((err as Error).message, opts.color);
    return 3;
  }

  const useColor = opts.color;
  const logger = createLogger({ level: logLevel, noColor: !useColor });
  setDefaultLogger(logger);

  // ── Mode validieren ────────────────────────────────────────────
  if (opts.mode !== 'strict' && opts.mode !== 'hybrid') {
    printError(`Invalid --mode "${opts.mode}". Allowed: strict, hybrid`, useColor);
    return 3;
  }

  // ── SIGINT (Ctrl+C) sauber abfangen ────────────────────────────
  const abortController = new AbortController();
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount === 1) {
      process.stderr.write('\nReceived SIGINT, attempting graceful shutdown (Ctrl+C again to force)…\n');
      abortController.abort();
    } else {
      process.stderr.write('\nForce-exit.\n');
      process.exit(130);
    }
  });

  // ── TUI-Modus: früh abzweigen ──────────────────────────────────
  // Wenn --tui gesetzt ist, übernimmt die TUI Config-Beschaffung, Lauf und
  // Report selbst. Sie nutzt denselben AbortController für Ctrl+C.
  if (opts.tui) {
    const tuiOpts: Parameters<typeof runTui>[0] = {
      mode: opts.mode,
      dryRun: opts.dryRun,
      noColor: !useColor,
      signal: abortController.signal,
    };
    if (opts.config) tuiOpts.configPath = opts.config;
    return runTui(tuiOpts);
  }

  // ── Git-Verfügbarkeit prüfen ───────────────────────────────────
  const gitVersion = await detectGit();
  if (!gitVersion) {
    printError('git is not installed or not in PATH. Please install git first.', useColor);
    return 3;
  }
  logger.debug(`Detected ${gitVersion}`);

  // ── Konfiguration laden ────────────────────────────────────────
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    const loadOpts: Parameters<typeof loadConfig>[0] = {
      mode: opts.mode as 'strict' | 'hybrid',
    };
    if (opts.config) loadOpts.path = opts.config;
    config = await loadConfig(loadOpts);
  } catch (err) {
    if (err instanceof ConfigError) {
      printError(err.format(), useColor);
    } else {
      printError((err as Error).message, useColor);
    }
    return 3;
  }

  // --dry-run überschreibt das Config-Feld
  if (opts.dryRun && !config.dryRun) {
    config = Object.freeze({ ...config, dryRun: true });
  }

  // ── PR-Adapter bauen ───────────────────────────────────────────
  let adapter: Awaited<ReturnType<typeof createPrAdapter>>;
  try {
    adapter = await createPrAdapter(config);
  } catch (err) {
    if (err instanceof PrAdapterError) {
      printError(err.message, useColor);
    } else {
      printError((err as Error).message, useColor);
    }
    return 3;
  }

  // ── Bulk-Lauf ──────────────────────────────────────────────────
  let summary: Awaited<ReturnType<typeof runBulk>>;
  try {
    summary = await runBulk(config, {
      prAdapter: adapter,
      logger,
      signal: abortController.signal,
    });
  } catch (err) {
    printError(`Unexpected error during bulk run: ${(err as Error).message}`, useColor);
    return 3;
  }

  // ── Summary drucken ────────────────────────────────────────────
  printRunSummary(summary, { noColor: !useColor });

  return exitCodeFromSummary(summary);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
    process.exit(3);
  });
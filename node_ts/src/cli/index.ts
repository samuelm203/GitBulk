#!/usr/bin/env node
/**
 * GitBulk CLI — Einstiegspunkt.
 *
 * Verdrahtet alle Bausteine:
 *   1. Argument-Parsing via node:util parseArgs (zero-dependency)
 *   2. Logger initialisieren (Level, Farbe)
 *   3. Git-Verfügbarkeit prüfen
 *   4. Config laden (Datei + Hybrid, oder rein interaktiv)
 *   5. PR-Adapter bauen
 *   6. Runner ausführen
 *   7. Summary drucken, Exit-Code setzen
 *
 * Subkommandos: `init`, `list-operations`. Alles andere ist der Bulk-Flow.
 *
 * Exit-Codes:
 *   0 — Alle RUs erfolgreich verarbeitet (auch wenn manche skipped sind)
 *   1 — Mindestens ein PR ist fehlgeschlagen
 *   2 — Mindestens ein RU hatte einen fatalen Fehler
 *   3 — Setup-Fehler (Config, Git nicht gefunden, Token fehlt)
 *  130 — SIGINT (Ctrl+C)
 */

import process from 'node:process';
import { parseArgs } from 'node:util';

import * as colors from '../utils/colors.js';

import { loadConfig, ConfigError } from '../config/loader.js';
import {
  createLogger,
  setDefaultLogger,
  LogCapture,
  type LogLevel,
  LOG_LEVELS,
} from '../utils/logger.js';
import { detectGit } from '../git/executor.js';
import { createPrAdapter, PrAdapterError } from '../git/pr-adapter.js';
import { ensurePrToken } from './token-prompt.js';
import { finishDeepLog } from './deep-log.js';
import { runBulk } from '../core/runner.js';
import { printRunSummary } from '../core/reporter.js';
import { runTui } from '../tui/index.js';
import { runInitGenerator } from './init.js';
import { runListOperations } from './list-operations.js';
import { filterRus } from './filter-rus.js';
import { VERSION } from '../index.js';

/** Allgemeiner Hilfetext (Pendant zur früheren Commander-Hilfe). */
const HELP = `gitbulk — Configurable CLI tool for bulk operations on Git repositories.

Usage:
  gitbulk [options]                  Run the bulk flow (config -> per-RU git + PR)
  gitbulk init [options]             Generate an operations config or a code-change script
  gitbulk list-operations [--json]   List the available declarative operations

Options:
  -c, --config <path>    Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)
  -m, --mode <mode>      Config mode: "strict" or "hybrid" (default: hybrid)
      --dry-run          Do not perform any write operations (push, PR API)
      --tui              Interactive terminal UI with live per-RU progress
      --deep-log         Record a granular step-by-step log; offer to save/print it at the end
      --only <rus>       Only process these RUs (comma-separated subset)
  -l, --log-level <lvl>  Log level: ${LOG_LEVELS.join(' | ')} (default: info)
      --no-color         Disable colored output
  -v, --version          Print version and exit
  -h, --help             Show this help and exit

init options:
  -o, --output <path>    Output file path
  -f, --force            Overwrite the output file instead of auto-incrementing the name

Exit codes: 0 ok | 1 a PR failed | 2 a fatal per-RU error | 3 setup error | 130 SIGINT
`;

/** Hilfetext für `gitbulk init`. */
const INIT_HELP = `gitbulk init — Generate an operations config or a standalone .mjs/.ts code-change script.

Options:
  -o, --output <path>   Output file path
  -f, --force           Overwrite the output file if it already exists
      --no-color        Disable colored output
`;

/** Hilfetext für `gitbulk list-operations`. */
const LIST_HELP = `gitbulk list-operations — List all available declarative operations and their parameters.

Options:
      --json   Output as JSON (machine-readable)
`;

/**
 * Parst die CLI-Argumente mit node:util parseArgs.
 *
 * Alle Optionen (global + Subkommando) sind in einem Spec definiert; das erste
 * Positional bestimmt das Subkommando. Wirft bei unbekannter Option / fehlendem
 * Wert (vom Aufrufer abgefangen → Exit 3).
 */
function parseCliArgs() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    tokens: true,
    options: {
      config: { type: 'string', short: 'c' },
      mode: { type: 'string', short: 'm', default: 'hybrid' },
      'dry-run': { type: 'boolean', default: false },
      tui: { type: 'boolean', default: false },
      'deep-log': { type: 'boolean', default: false },
      only: { type: 'string' },
      'log-level': { type: 'string', short: 'l', default: 'info' },
      'no-color': { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      output: { type: 'string', short: 'o' },
      force: { type: 'boolean', short: 'f', default: false },
      json: { type: 'boolean', default: false },
    },
  });
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
  const prefix = useColor ? colors.redBold('Error:') : 'Error:';
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
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 3;
  }
  const { values, positionals } = parsed;
  const useColor = !values['no-color'];
  const subcommand = positionals[0];

  // Tatsächlich übergebene Optionen (nicht nur Defaults), damit wir
  // Subkommando-Optionen im falschen Kontext als Fehler melden können statt sie
  // still zu ignorieren (entspricht dem strengen Commander-Verhalten von früher).
  const provided = new Set<string>(
    parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name),
  );
  const usageError = (msg: string): number => {
    printError(msg, useColor);
    return 3;
  };

  // ── Version / Hilfe ────────────────────────────────────────────
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help && subcommand === undefined) {
    process.stdout.write(HELP);
    return 0;
  }

  // ── Subkommando-Dispatch ───────────────────────────────────────
  if (subcommand === 'init') {
    if (values.help) {
      process.stdout.write(INIT_HELP);
      return 0;
    }
    if (provided.has('json')) return usageError('`--json` is not valid for `init`.');
    if (positionals.length > 1) return usageError(`Unexpected argument "${positionals[1]}" for init.`);
    const initOpts: Parameters<typeof runInitGenerator>[0] = { noColor: !useColor };
    if (values.output !== undefined) initOpts.outputPath = values.output;
    if (values.force) initOpts.force = values.force;
    return runInitGenerator(initOpts);
  }
  if (subcommand === 'list-operations') {
    if (values.help) {
      process.stdout.write(LIST_HELP);
      return 0;
    }
    if (provided.has('output') || provided.has('force')) {
      return usageError('`--output`/`--force` are only valid for `init`.');
    }
    if (positionals.length > 1) {
      return usageError(`Unexpected argument "${positionals[1]}" for list-operations.`);
    }
    return runListOperations({ json: values.json ?? false, noColor: !useColor });
  }
  if (subcommand !== undefined) {
    printError(`Unknown command "${subcommand}". Run "gitbulk --help" for usage.`, useColor);
    return 3;
  }

  // Subkommando-Optionen sind im Bulk-Flow ungültig (statt still ignoriert).
  const strayOpts = ['output', 'force', 'json'].filter((o) => provided.has(o));
  if (strayOpts.length > 0) {
    return usageError(
      `Option(s) ${strayOpts.map((o) => `--${o}`).join(', ')} are only valid for a subcommand (init / list-operations).`,
    );
  }

  // ── Globale Optionen für den Bulk-Flow ─────────────────────────
  const opts = {
    config: values.config,
    mode: values.mode ?? 'hybrid',
    dryRun: values['dry-run'] ?? false,
    tui: values.tui ?? false,
    deepLog: values['deep-log'] ?? false,
    only: values.only,
    logLevel: values['log-level'] ?? 'info',
    color: useColor,
  };

  // ── Logger initialisieren ──────────────────────────────────────
  let logLevel: LogLevel;
  try {
    logLevel = parseLogLevel(opts.logLevel);
  } catch (err) {
    printError((err as Error).message, opts.color);
    return 3;
  }

  // Deep-Log: optionaler In-Memory-Puffer, der JEDE Meldung erfasst.
  const deepCapture = opts.deepLog ? new LogCapture() : undefined;
  const logger = createLogger({
    level: logLevel,
    noColor: !useColor,
    ...(deepCapture ? { capture: deepCapture } : {}),
  });
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
    if (opts.only !== undefined) tuiOpts.only = opts.only;
    if (opts.deepLog) tuiOpts.deepLog = true;
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

  // --only: RU-Liste auf eine Teilmenge beschränken
  try {
    config = filterRus(config, opts.only);
  } catch (err) {
    printError((err as Error).message, useColor);
    return 3;
  }

  // ── Auth-Guard: Token sicherstellen (Prompt im TTY, sonst Fehler) ──
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tokenCheck = await ensurePrToken(config.prPlatform, { interactive });
  if (!tokenCheck.ok) {
    printError(tokenCheck.error, useColor);
    return 3;
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

  // ── Deep-Log abschließen (Datei/Print) ─────────────────────────
  if (deepCapture) {
    await finishDeepLog(deepCapture, { interactive });
  }

  return exitCodeFromSummary(summary);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
    process.exit(3);
  });

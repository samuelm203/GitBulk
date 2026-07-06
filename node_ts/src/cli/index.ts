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
 * Subkommandos: `init`, `template`, `status`, `auth`, `list-operations`. Alles andere ist der Bulk-Flow.
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
import { runGui } from '../gui/index.js';
import { runInitGenerator } from './init.js';
import { runListOperations } from './list-operations.js';
import { runAuth } from './auth.js';
import { runTemplate, TEMPLATE_PLATFORMS } from './template.js';
import { runStatus } from './status.js';
import { runClose } from './close.js';
import { filterRus } from './filter-rus.js';
import { readFailedRus } from './retry-failed.js';
import { buildRunReport, writeRunReport } from '../core/report-file.js';
import { handleSpecialFlags } from './special-flags.js';
import { VERSION } from '../index.js';

/** Allgemeiner Hilfetext (Pendant zur früheren Commander-Hilfe). */
const HELP = `gitbulk — Configurable CLI tool for bulk operations on Git repositories.

Usage:
  gitbulk [options]                  Run the bulk flow (config -> per-RU git + PR)
  gitbulk init [options]             Generate an operations config, a script, or both
  gitbulk template [--minimal]       Print a ready-to-edit config template (full by default)
  gitbulk status [--only ...] [--json]  Show the PR status of a config's RUs (read-only)
  gitbulk close [--dry-run] [--yes]  Close open PRs of a config + delete remote branches
  gitbulk auth <login|logout|status> Store/remove a PR token (~/.gitbulk/credentials.json)
  gitbulk list-operations [--json]   List the available declarative operations

Options:
  -c, --config <path>    Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)
  -m, --mode <mode>      Config mode: "strict" or "hybrid" (default: hybrid)
      --dry-run          Do not perform any write operations (push, PR API)
      --tui              Interactive terminal UI with live per-RU progress
      --gui              Browser dashboard (127.0.0.1): live process view, started via button
      --deep-log         Record a granular step-by-step log; offer to save/print it at the end
      --only <rus>       Only process these RUs (comma-separated subset)
      --report <path>    Write a machine-readable JSON run report (for CI)
      --retry-failed <report.json>  Re-run only the RUs that failed in a previous report
  -l, --log-level <lvl>  Log level: ${LOG_LEVELS.join(' | ')} (default: info)
      --no-color         Disable colored output
  -v, --version          Print version and exit
  -h, --help             Show this help and exit
      -fish, -fisch      Show a compact command/option matrix

init options:
  -o, --output <path>    Output file path
  -f, --force            Overwrite the output file instead of auto-incrementing the name

template options:
      --full             Emit the full template with every field + comments (default)
      --minimal          Emit only the required fields
      --platform <p>     Platform block: bitbucket | github | gitlab | azure-devops
  -o, --output <path>    Write to a file instead of stdout
  -f, --force            Overwrite the output file if it exists

auth options:
      --platform <p>     Platform: bitbucket | github | gitlab | azure-devops (required for login)

Exit codes: 0 ok | 1 a PR failed | 2 a fatal per-RU error | 3 setup error | 130 SIGINT
`;

/** Hilfetext für `gitbulk init`. */
const INIT_HELP = `gitbulk init — Generate an operations config, a standalone .mjs/.ts script, or both.

Interactively pick one of:
  1. a config with declarative operations (YAML)
  2. a standalone code-change script (.mjs/.ts)
  3. both — a script plus a config that runs it via "script:"

Options:
  -o, --output <path>   Output file path (in "both" mode this names the config; the
                        script is written next to it)
  -f, --force           Overwrite the output file instead of auto-incrementing the name
      --no-color        Disable colored output
`;

/** Hilfetext für `gitbulk list-operations`. */
const LIST_HELP = `gitbulk list-operations — List all available declarative operations and their parameters.

Options:
      --json   Output as JSON (machine-readable)
`;

/** Hilfetext für `gitbulk close`. */
const CLOSE_HELP = `gitbulk close — Close the open PRs of a config's RUs and delete the remote feature branches.

The cleanup counterpart to a bulk run (e.g. after a bad run): resolves the same
feature branch as a run (<ticket>-<branch>), closes/declines every open PR via the
platform API and deletes the remote feature branch from each local repo
(git push origin --delete). Destructive — asks for confirmation in a terminal.

Usage:
  gitbulk close --config gitbulk.yaml --dry-run   Preview what would be closed/deleted
  gitbulk close --config gitbulk.yaml             Close + delete (asks for confirmation)
  gitbulk close --config gitbulk.yaml --yes       No confirmation (for CI)

Options:
  -c, --config <path>    Path to a config file
  -m, --mode <mode>      Config mode: "strict" or "hybrid" (default: hybrid)
      --only <rus>       Only process these RUs (comma-separated subset)
      --dry-run          Show what would happen; no API calls, no pushes
      --yes              Skip the confirmation prompt (required in non-TTY mode)
      --json             Output the report as JSON (machine-readable)
      --no-color         Disable colored output

Exit codes: 0 ok | 1 a close/delete failed | 3 setup error or aborted
`;

/** Hilfetext für `gitbulk auth`. */
const AUTH_HELP = `gitbulk auth — Store or remove a PR platform token.

The token is saved OUTSIDE any repo in ~/.gitbulk/credentials.json (file mode 0600).
At run time the resolution order is: env var > stored token > interactive prompt.
Tokens are never printed or logged.

Usage:
  gitbulk auth login --platform <bitbucket|github|gitlab|azure-devops>   Prompt (hidden) and store a token
  gitbulk auth logout [--platform <p>]               Remove a stored token (omit = all)
  gitbulk auth status                                Show which tokens are available
`;

/** Hilfetext für `gitbulk template`. */
const TEMPLATE_HELP = `gitbulk template — Print a ready-to-edit GitBulk config template (no prompts).

Unlike \`gitbulk init\` (interactive), this just emits a schema-valid YAML config.
The default is the full template (every field + comments); --minimal emits only
the required fields. --platform picks the PR platform block (default: bitbucket).
Tokens are NEVER part of the template — they come from env vars.

Usage:
  gitbulk template                 Print the full template to stdout
  gitbulk template --minimal       Print only the required fields
  gitbulk template --platform gitlab   Emit a GitLab platform block instead
  gitbulk template -o gitbulk.yaml Write to a file (-f/--force to overwrite)

Options:
      --full             Emit the full template with every field + comments (default)
      --minimal          Emit only the required fields
      --platform <p>     Platform block: bitbucket | github | gitlab | azure-devops
  -o, --output <path>    Write to a file instead of stdout
  -f, --force            Overwrite the output file if it exists
      --no-color         Disable colored output
`;

/** Hilfetext für `gitbulk status`. */
const STATUS_HELP = `gitbulk status — Show the PR status for the RUs of a config (read-only).

Resolves the same feature branch as a run (<ticket>-<branch>) and looks up each
RU's pull request on the platform. Performs NO local git or write operations.
Token resolution is the same as a run: env var > stored token > interactive prompt.

Usage:
  gitbulk status --config gitbulk.yaml            Table of PR states for all RUs
  gitbulk status --config gitbulk.yaml --only a,b Restrict to a subset of RUs
  gitbulk status --config gitbulk.yaml --json     Machine-readable output (for CI)
  gitbulk status --config gitbulk.yaml --watch    Refresh until no PR is open

Options:
  -c, --config <path>    Path to a config file
  -m, --mode <mode>      Config mode: "strict" or "hybrid" (default: hybrid)
      --only <rus>       Only check these RUs (comma-separated subset)
      --json             Output as JSON (machine-readable)
      --watch            Poll and re-render the table until all PRs are merged/
                         declined (exit 0) — Ctrl+C stops with exit 130
      --interval <s>     Poll interval in seconds for --watch (default: 30)
      --no-color         Disable colored output
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
      gui: { type: 'boolean', default: false },
      'deep-log': { type: 'boolean', default: false },
      only: { type: 'string' },
      report: { type: 'string' },
      'retry-failed': { type: 'string' },
      'log-level': { type: 'string', short: 'l', default: 'info' },
      'no-color': { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      output: { type: 'string', short: 'o' },
      force: { type: 'boolean', short: 'f', default: false },
      json: { type: 'boolean', default: false },
      platform: { type: 'string' },
      full: { type: 'boolean', default: false },
      minimal: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string' },
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
  // Spezial-Flags VOR parseArgs abfangen: `node:util.parseArgs` würde `-fish`
  // als Kurzoptionen-Cluster fehldeuten. Beides sind reine Ausgabe-Flags.
  const rawArgs = process.argv.slice(2);
  const special = handleSpecialFlags(rawArgs, !rawArgs.includes('--no-color'));
  if (special !== undefined) {
    process.stdout.write(special);
    return 0;
  }

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

  // Bulk-Flow-Optionen, die in Subkommandos nichts bewirken — dort als Fehler
  // melden statt still zu ignorieren (Gegenstück zur strayOpts-Prüfung unten).
  const bulkOnly = [
    'config', 'mode', 'dry-run', 'tui', 'gui', 'deep-log', 'only', 'log-level',
    'report', 'retry-failed',
  ];
  const bulkOnlyError = (sub: string): number | undefined => {
    const stray = bulkOnly.filter((o) => provided.has(o));
    if (stray.length === 0) return undefined;
    return usageError(
      `Option(s) ${stray.map((o) => `--${o}`).join(', ')} are not valid for \`${sub}\` (bulk-flow only).`,
    );
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
    const initInvalid = ['json', 'platform', 'full', 'minimal', 'yes', 'watch', 'interval'].filter((o) => provided.has(o));
    if (initInvalid.length > 0) {
      return usageError(`Option(s) ${initInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`init\`.`);
    }
    const initStray = bulkOnlyError('init');
    if (initStray !== undefined) return initStray;
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
    const listInvalid = ['output', 'force', 'platform', 'full', 'minimal', 'yes', 'watch', 'interval'].filter((o) => provided.has(o));
    if (listInvalid.length > 0) {
      return usageError(
        `Option(s) ${listInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`list-operations\`.`,
      );
    }
    const listStray = bulkOnlyError('list-operations');
    if (listStray !== undefined) return listStray;
    if (positionals.length > 1) {
      return usageError(`Unexpected argument "${positionals[1]}" for list-operations.`);
    }
    return runListOperations({ json: values.json ?? false, noColor: !useColor });
  }
  if (subcommand === 'template') {
    if (values.help) {
      process.stdout.write(TEMPLATE_HELP);
      return 0;
    }
    const templateInvalid = ['json', 'yes', 'watch', 'interval'].filter((o) => provided.has(o));
    if (templateInvalid.length > 0) {
      return usageError(
        `Option(s) ${templateInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`template\`.`,
      );
    }
    const templateStray = bulkOnlyError('template');
    if (templateStray !== undefined) return templateStray;
    if (values.full && values.minimal) {
      return usageError('`--full` and `--minimal` are mutually exclusive.');
    }
    if (
      values.platform !== undefined &&
      !(TEMPLATE_PLATFORMS as readonly string[]).includes(values.platform)
    ) {
      return usageError(
        `Invalid --platform "${values.platform}". Allowed: ${TEMPLATE_PLATFORMS.join(', ')}.`,
      );
    }
    if (positionals.length > 1) {
      return usageError(`Unexpected argument "${positionals[1]}" for template.`);
    }
    const templateOpts: Parameters<typeof runTemplate>[0] = {
      kind: values.minimal ? 'minimal' : 'full',
      noColor: !useColor,
    };
    if (values.platform !== undefined) {
      templateOpts.platform = values.platform as (typeof TEMPLATE_PLATFORMS)[number];
    }
    if (values.output !== undefined) templateOpts.outputPath = values.output;
    if (values.force) templateOpts.force = true;
    return runTemplate(templateOpts);
  }
  if (subcommand === 'auth') {
    if (values.help) {
      process.stdout.write(AUTH_HELP);
      return 0;
    }
    const authInvalid = ['output', 'force', 'json', 'full', 'minimal', 'yes', 'watch', 'interval'].filter((o) => provided.has(o));
    if (authInvalid.length > 0) {
      return usageError(`Option(s) ${authInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`auth\`.`);
    }
    const authBulkStray = bulkOnlyError('auth');
    if (authBulkStray !== undefined) return authBulkStray;
    const action = positionals[1];
    if (action !== 'login' && action !== 'logout' && action !== 'status') {
      return usageError('`auth` requires an action: login | logout | status.');
    }
    if (positionals.length > 2) {
      return usageError(`Unexpected argument "${positionals[2]}" for auth.`);
    }
    if (
      values.platform !== undefined &&
      values.platform !== 'bitbucket' &&
      values.platform !== 'github' &&
      values.platform !== 'gitlab' &&
      values.platform !== 'azure-devops'
    ) {
      return usageError(
        `Invalid --platform "${values.platform}". Allowed: bitbucket, github, gitlab, azure-devops.`,
      );
    }
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const authOpts: Parameters<typeof runAuth>[0] = { action, interactive, noColor: !useColor };
    if (values.platform !== undefined) authOpts.platform = values.platform;
    return runAuth(authOpts);
  }
  if (subcommand === 'status') {
    if (values.help) {
      process.stdout.write(STATUS_HELP);
      return 0;
    }
    // `status` nutzt config/mode/only (read-only), aber nicht die Schreib-/View-
    // Optionen des Bulk-Flows oder die anderer Subkommandos.
    const statusInvalid = [
      'output', 'force', 'platform', 'full', 'minimal',
      'tui', 'gui', 'dry-run', 'deep-log', 'log-level', 'yes',
    ].filter((o) => provided.has(o));
    if (statusInvalid.length > 0) {
      return usageError(
        `Option(s) ${statusInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`status\`.`,
      );
    }
    if (positionals.length > 1) {
      return usageError(`Unexpected argument "${positionals[1]}" for status.`);
    }
    const statusMode = values.mode ?? 'hybrid';
    if (statusMode !== 'strict' && statusMode !== 'hybrid') {
      return usageError(`Invalid --mode "${statusMode}". Allowed: strict, hybrid`);
    }
    if (values.watch && values.json) {
      return usageError('`--watch` and `--json` are mutually exclusive.');
    }
    let intervalSeconds: number | undefined;
    if (values.interval !== undefined) {
      if (!values.watch) {
        return usageError('`--interval` requires `--watch`.');
      }
      intervalSeconds = Number(values.interval);
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
        return usageError(`Invalid --interval "${values.interval}". Use a positive integer (seconds).`);
      }
    }
    const statusOpts: Parameters<typeof runStatus>[0] = {
      mode: statusMode,
      json: values.json ?? false,
      noColor: !useColor,
    };
    if (values.config !== undefined) statusOpts.configPath = values.config;
    if (values.only !== undefined) statusOpts.only = values.only;
    if (values.watch) statusOpts.watch = true;
    if (intervalSeconds !== undefined) statusOpts.intervalSeconds = intervalSeconds;
    return runStatus(statusOpts);
  }
  if (subcommand === 'close') {
    if (values.help) {
      process.stdout.write(CLOSE_HELP);
      return 0;
    }
    const closeInvalid = [
      'output', 'force', 'platform', 'full', 'minimal',
      'tui', 'gui', 'deep-log', 'log-level', 'report', 'retry-failed', 'watch', 'interval',
    ].filter((o) => provided.has(o));
    if (closeInvalid.length > 0) {
      return usageError(
        `Option(s) ${closeInvalid.map((o) => `--${o}`).join(', ')} are not valid for \`close\`.`,
      );
    }
    if (positionals.length > 1) {
      return usageError(`Unexpected argument "${positionals[1]}" for close.`);
    }
    const closeMode = values.mode ?? 'hybrid';
    if (closeMode !== 'strict' && closeMode !== 'hybrid') {
      return usageError(`Invalid --mode "${closeMode}". Allowed: strict, hybrid`);
    }
    const closeOpts: Parameters<typeof runClose>[0] = {
      mode: closeMode,
      dryRun: values['dry-run'] ?? false,
      yes: values.yes ?? false,
      json: values.json ?? false,
      noColor: !useColor,
    };
    if (values.config !== undefined) closeOpts.configPath = values.config;
    if (values.only !== undefined) closeOpts.only = values.only;
    return runClose(closeOpts);
  }
  if (subcommand !== undefined) {
    printError(`Unknown command "${subcommand}". Run "gitbulk --help" for usage.`, useColor);
    return 3;
  }

  // Subkommando-Optionen sind im Bulk-Flow ungültig (statt still ignoriert).
  const strayOpts = ['output', 'force', 'json', 'platform', 'full', 'minimal', 'yes', 'watch', 'interval'].filter((o) =>
    provided.has(o),
  );
  if (strayOpts.length > 0) {
    return usageError(
      `Option(s) ${strayOpts.map((o) => `--${o}`).join(', ')} are only valid for a subcommand (init / template / status / close / auth / list-operations).`,
    );
  }

  // ── Globale Optionen für den Bulk-Flow ─────────────────────────
  const opts = {
    config: values.config,
    mode: values.mode ?? 'hybrid',
    dryRun: values['dry-run'] ?? false,
    tui: values.tui ?? false,
    gui: values.gui ?? false,
    deepLog: values['deep-log'] ?? false,
    only: values.only,
    report: values.report,
    retryFailed: values['retry-failed'],
    logLevel: values['log-level'] ?? 'info',
    color: useColor,
  };

  if (opts.tui && opts.gui) {
    return usageError('`--tui` and `--gui` are mutually exclusive — pick one view.');
  }
  // --report/--retry-failed gehören zum Plain-CLI-Lauf: TUI/GUI übernehmen den
  // Lauf selbst und liefern die Summary nicht hierher zurück.
  if ((opts.report !== undefined || opts.retryFailed !== undefined) && (opts.tui || opts.gui)) {
    return usageError('`--report`/`--retry-failed` cannot be combined with `--tui`/`--gui`.');
  }
  if (opts.retryFailed !== undefined && opts.only !== undefined) {
    return usageError('`--retry-failed` and `--only` are mutually exclusive.');
  }

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
    const tuiCode = await runTui(tuiOpts);
    // Abgebrochener Lauf (Ctrl+C) darf NICHT wie Erfolg aussehen → Exit 130.
    return abortController.signal.aborted ? 130 : tuiCode;
  }

  // ── GUI-Modus: Browser-Dashboard (lokal), Lauf startet per Button ──
  if (opts.gui) {
    const guiOpts: Parameters<typeof runGui>[0] = {
      mode: opts.mode as 'strict' | 'hybrid',
      dryRun: opts.dryRun,
      signal: abortController.signal,
    };
    if (opts.config) guiOpts.configPath = opts.config;
    if (opts.only !== undefined) guiOpts.only = opts.only;
    // Kein deepLog-Durchreichen: im GUI-Modus ist das Deep-Log IMMER aktiv.
    const guiCode = await runGui(guiOpts);
    return abortController.signal.aborted ? 130 : guiCode;
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

  // --retry-failed: nur die Fehlschläge eines vorherigen Report-Laufs erneut.
  if (opts.retryFailed !== undefined) {
    try {
      const failed = readFailedRus(opts.retryFailed);
      if (failed.length === 0) {
        process.stdout.write('Nothing to retry — the report contains no failed RUs.\n');
        return 0;
      }
      logger.info(`--retry-failed: retrying ${failed.length} RU(s): ${failed.join(', ')}`);
      config = filterRus(config, failed.join(','));
    } catch (err) {
      // filterRus meldet mit "--only:"-Präfix — hier stammt der Filter aber
      // aus dem Report, also den Flag-Namen in der Meldung geradeziehen.
      printError((err as Error).message.replace(/^--only:/, '--retry-failed:'), useColor);
      return 3;
    }
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

  // Abgebrochener Lauf (Ctrl+C): nicht verarbeitete RUs zählen nur als
  // "not processed" und würden Exit 0 ("Erfolg") liefern — für Skripte/CI
  // muss ein Abbruch aber als solcher erkennbar sein (dokumentiert: 130).
  const exitCode = abortController.signal.aborted ? 130 : exitCodeFromSummary(summary);

  // ── --report: maschinenlesbaren JSON-Report schreiben ──────────
  if (opts.report !== undefined) {
    try {
      writeRunReport(opts.report, buildRunReport(config, summary, exitCode));
      logger.info(`Run report written to ${opts.report}`);
    } catch (err) {
      // CI hat den Report explizit angefordert — ein Schreibfehler darf einen
      // sonst grünen Lauf nicht still passieren lassen. Echte Lauf-Fehler
      // (1/2/130) behalten aber Vorrang vor dem Setup-Fehler 3.
      printError(`--report: cannot write "${opts.report}": ${(err as Error).message}`, useColor);
      return exitCode !== 0 ? exitCode : 3;
    }
  }

  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
    process.exit(3);
  });

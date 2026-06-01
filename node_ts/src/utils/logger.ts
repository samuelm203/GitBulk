/**
 * Logger-Modul für GitBulk.
 *
 * Bietet strukturiertes, farbiges Logging mit optionalem RU-Kontext.
 * Die Log-Meldungen sind kompatibel zu den im Flowchart geforderten
 * Ausgaben (z. B. `Log: PR successful, RU`, `Log: Push Error after multiple Retries, RU`).
 *
 * @example
 * ```ts
 * import { createLogger } from './utils/logger.js';
 *
 * const log = createLogger();
 * log.info('Konfiguration geladen');
 *
 * const ruLog = log.withRu('repo-name');
 * ruLog.warn('Push fehlgeschlagen, retry...');
 * ```
 */

import * as colors from './colors.js';

/**
 * Verfügbare Log-Levels in aufsteigender Schwere.
 * Levels unterhalb des konfigurierten Minimums werden unterdrückt.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Numerische Gewichtung für Level-Vergleiche.
 */
const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Optionen für die Logger-Erstellung.
 */
export interface LoggerOptions {
  /** Minimales Log-Level. Standard: `'info'`. */
  level?: LogLevel;
  /** Wenn `true`, werden Zeitstempel ausgegeben. Standard: `true`. */
  timestamps?: boolean;
  /** Wenn `true`, wird Farbe deaktiviert (z. B. für CI-Logs). Standard: `false`. */
  noColor?: boolean;
}

/**
 * Logger-Interface — wird sowohl von der Root-Instanz als auch von
 * `withRu()`-Child-Loggern implementiert.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /**
   * Erzeugt einen Child-Logger, der jede Ausgabe mit dem RU-Namen
   * markiert. Entspricht den Flowchart-Logs der Form `..., RU`.
   */
  withRu(ru: string): Logger;
}

/**
 * Formatiert den aktuellen Zeitpunkt als ISO-8601 (Sekunden-genau).
 */
function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Erzeugt eine neue Logger-Instanz.
 *
 * @param options - Konfigurationsoptionen
 * @returns Logger-Instanz
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const showTimestamps = options.timestamps ?? true;
  const useColor = !options.noColor;

  /**
   * Internes Log-Helper. Prüft das Level, formatiert die Meldung
   * und schreibt nach stdout/stderr.
   */
  function log(
    msgLevel: LogLevel,
    ruContext: string | null,
    message: string,
    args: unknown[],
  ): void {
    if (LEVEL_WEIGHTS[msgLevel] < LEVEL_WEIGHTS[level]) {
      return;
    }

    const parts: string[] = [];

    if (showTimestamps) {
      const ts = `[${timestamp()}]`;
      parts.push(useColor ? colors.gray(ts) : ts);
    }

    const levelTag = `[${msgLevel.toUpperCase()}]`.padEnd(7);
    if (useColor) {
      const colored =
        msgLevel === 'error'
          ? colors.red(levelTag)
          : msgLevel === 'warn'
            ? colors.yellow(levelTag)
            : msgLevel === 'debug'
              ? colors.gray(levelTag)
              : colors.cyan(levelTag);
      parts.push(colored);
    } else {
      parts.push(levelTag);
    }

    if (ruContext) {
      const ruTag = `[${ruContext}]`;
      parts.push(useColor ? colors.magenta(ruTag) : ruTag);
    }

    parts.push(message);

    const line = parts.join(' ');
    const stream = msgLevel === 'error' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);

    // Zusätzliche strukturierte Argumente (z. B. Error-Objekte)
    // werden separat ausgegeben, damit sie nicht die Hauptzeile sprengen.
    for (const arg of args) {
      if (arg instanceof Error) {
        stream.write(`${arg.stack ?? arg.message}\n`);
      } else if (typeof arg === 'object' && arg !== null) {
        stream.write(`${JSON.stringify(arg, null, 2)}\n`);
      } else if (arg !== undefined) {
        stream.write(`${String(arg)}\n`);
      }
    }
  }

  /**
   * Erzeugt ein Logger-Objekt — entweder Root (ruContext = null)
   * oder Child mit RU-Kontext.
   */
  function buildLogger(ruContext: string | null): Logger {
    return {
      debug: (message, ...args) => log('debug', ruContext, message, args),
      info: (message, ...args) => log('info', ruContext, message, args),
      warn: (message, ...args) => log('warn', ruContext, message, args),
      error: (message, ...args) => log('error', ruContext, message, args),
      withRu: (ru: string) => buildLogger(ru),
    };
  }

  return buildLogger(null);
}

/**
 * Default-Logger-Instanz für Module, die keine eigene Instanz erzeugen wollen.
 * Kann via {@link setDefaultLogger} überschrieben werden (z. B. in Tests).
 */
let defaultLogger: Logger = createLogger();

export function getDefaultLogger(): Logger {
  return defaultLogger;
}

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

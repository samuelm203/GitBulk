/**
 * Git-Executor — sicherer Wrapper um `child_process.spawn` für Git-Befehle.
 *
 * Dieser Wrapper ist die Grundlage für ALLE Git-Operationen in Phase 3
 * des Flowcharts. Er liefert:
 *
 *   - **Sichere Argument-Übergabe**: keine Shell-Interpolation → kein
 *     Command-Injection-Risiko, auch wenn RU-Namen oder Branch-Namen
 *     unerwartete Zeichen enthalten.
 *   - **Timeouts pro Befehl**: hängende Auth-Prompts oder Netzwerk-Stalls
 *     werden nach `commandTimeoutMs` abgebrochen (siehe Schema).
 *   - **Exit-Code-Capture**: alle Flowchart-Rauten der Form
 *     "Exit-Code == 0?" und "Push successful?" werden aus `result.exitCode`
 *     abgeleitet — Exceptions werden NUR bei echten Spawn-Fehlern geworfen.
 *   - **stdout/stderr-Capture**: für Logs und für `git status --porcelain`,
 *     wo der Output ausgewertet wird ("Output empty?").
 *   - **Dry-Run-Mode**: schreibende Befehle werden geloggt, aber nicht
 *     ausgeführt (siehe `$config.dryRun`).
 *
 * Wichtig: Der Executor wirft NICHT bei Exit-Code != 0. Das ist Absicht.
 * Das Flowchart unterscheidet explizit zwischen "Exit-Code 0" und "!= 0"
 * (z. B. fehlerhaftes Code-Change-Skript → weiterhin commit/push).
 * Aufrufer entscheiden selbst, wie sie mit `result.exitCode != 0` umgehen.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { Logger } from '../utils/logger.js';
import { getDefaultLogger } from '../utils/logger.js';

/**
 * Ergebnis einer Git-Befehls-Ausführung.
 *
 * `exitCode` ist `null`, wenn der Prozess durch ein Signal beendet wurde
 * (z. B. Timeout-Kill via SIGTERM).
 */
export interface GitCommandResult {
  /** Exit-Code des Prozesses (0 = Erfolg). `null` bei Signal-Termination. */
  exitCode: number | null;
  /** Signal, mit dem der Prozess beendet wurde (z. B. `'SIGTERM'`). */
  signal: NodeJS.Signals | null;
  /** Komplette stdout-Ausgabe (UTF-8 dekodiert) */
  stdout: string;
  /** Komplette stderr-Ausgabe (UTF-8 dekodiert) */
  stderr: string;
  /** Ausführungsdauer in Millisekunden */
  durationMs: number;
  /** Wurde der Befehl wegen Timeout abgebrochen? */
  timedOut: boolean;
  /** Die ausgeführten Argumente (für Debug-Logging) */
  args: readonly string[];
  /** Arbeitsverzeichnis, in dem der Befehl ausgeführt wurde */
  cwd: string;
}

/**
 * Optionen für einen einzelnen Git-Befehl.
 */
export interface GitCommandOptions {
  /** Arbeitsverzeichnis (typischerweise der RU-Pfad) */
  cwd: string;
  /** Timeout in ms. Wenn überschritten, wird der Prozess gekillt. */
  timeoutMs: number;
  /**
   * Wenn `true`, wird der Befehl NICHT ausgeführt — Executor liefert ein
   * synthetisches Erfolgs-Ergebnis und loggt den Befehl. Für `$config.dryRun`.
   *
   * Read-Only-Befehle (`git status`, `git rev-parse` etc.) sollten den
   * Dry-Run-Modus ÜBERSPRINGEN, weil sie keine Seiteneffekte haben. Das
   * entscheidet der Aufrufer durch das Setzen dieses Flags.
   */
  dryRun?: boolean;
  /**
   * Wenn `true`, werden Git-Hooks deaktiviert, indem `core.hooksPath` auf
   * ein nicht existierendes Ziel umgebogen wird (`/dev/null` auf POSIX,
   * `NUL` auf Windows). Entspricht `$config.skipHooks`.
   */
  skipHooks?: boolean;
  /**
   * Zusätzliche Umgebungsvariablen. Werden mit `process.env` gemerged.
   * Nützlich für `GIT_TERMINAL_PROMPT=0` (verhindert Auth-Prompts).
   */
  env?: Record<string, string>;
  /** Optionaler Logger; Standard: Default-Logger */
  logger?: Logger;
  /**
   * Optionales AbortSignal zum kooperativen Abbruch (z. B. Ctrl+C).
   * Beim Abbruch wird der Prozess via SIGTERM beendet.
   */
  signal?: AbortSignal;
}

/**
 * Fehler-Klasse für strukturelle Probleme beim Spawn (z. B. `git` nicht im PATH).
 *
 * Wird NICHT bei Exit-Code != 0 geworfen — siehe Doc-Comment oben.
 */
export class GitExecutorError extends Error {
  public readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'GitExecutorError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Plattform-portabler Pfad, auf den `core.hooksPath` gesetzt wird, wenn
 * Hooks via `skipHooks` deaktiviert werden sollen. Beide Pfade existieren
 * NIE als reguläres Verzeichnis, sodass git keine Hooks findet.
 */
const HOOKS_DEVNULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Standard-Argumente, die jedem Git-Aufruf vorangestellt werden.
 *
 * - Über `GIT_TERMINAL_PROMPT=0` (siehe `buildEnv`) wird verhindert,
 *   dass git interaktiv nach Credentials fragt → Timeout statt Hänger.
 * - Hooks werden dynamisch via `-c core.hooksPath=...` deaktiviert,
 *   wenn `options.skipHooks === true` ist (siehe `buildArgs`).
 */
const GIT_GLOBAL_PREFIX: readonly string[] = [];

/**
 * Baut die finale Argument-Liste inklusive optionaler Hook-Deaktivierung.
 */
function buildArgs(args: readonly string[], skipHooks: boolean): string[] {
  const prefix = skipHooks
    ? [...GIT_GLOBAL_PREFIX, '-c', `core.hooksPath=${HOOKS_DEVNULL}`]
    : [...GIT_GLOBAL_PREFIX];
  return [...prefix, ...args];
}

/**
 * Setzt eine sichere Default-Umgebung zusammen.
 */
function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Verhindert interaktive Auth-Prompts; git scheitert dann statt zu hängen.
    GIT_TERMINAL_PROMPT: '0',
    // Konsistente Sprache für Output-Parsing.
    LC_ALL: 'C',
    LANG: 'C',
    ...extra,
  };
}

/**
 * Truncate für Log-Output langer Befehle.
 */
function previewArgs(args: readonly string[], max = 120): string {
  const joined = args.join(' ');
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

/**
 * Führt einen einzelnen Git-Befehl aus.
 *
 * @param args - Argumente NACH `git` (z. B. `['status', '--porcelain']`).
 *               Werden ohne Shell-Interpretation übergeben → sicher.
 * @param options - Ausführungsoptionen (cwd, timeout, dryRun, ...)
 * @returns Ergebnis mit Exit-Code, stdout/stderr, Dauer.
 * @throws {GitExecutorError} nur bei Spawn-Fehlern (kein Exit-Code-Fehler).
 */
export async function runGit(
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  const logger = options.logger ?? getDefaultLogger();
  const fullArgs = buildArgs(args, options.skipHooks ?? false);
  const startedAt = Date.now();

  // ── Dry-Run-Pfad ─────────────────────────────────────────────
  if (options.dryRun) {
    logger.info(`[dry-run] git ${previewArgs(fullArgs)} (cwd=${options.cwd})`);
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut: false,
      args: fullArgs,
      cwd: options.cwd,
    };
  }

  logger.debug(`git ${previewArgs(fullArgs)} (cwd=${options.cwd})`);

  // ── Echte Ausführung ─────────────────────────────────────────
  return new Promise<GitCommandResult>((resolve, reject) => {
    let child: ChildProcess;

    try {
      child = spawn('git', fullArgs, {
        cwd: options.cwd,
        env: buildEnv(options.env),
        // `shell: false` (Default) → keine Shell-Interpolation. Wichtig für Sicherheit.
        shell: false,
        windowsHide: true,
        // Auf POSIX in eigene Prozessgruppe, damit wir bei Timeout die GESAMTE
        // Gruppe killen können (inkl. Hooks, Editor, Credential-Helper).
        // Auf Windows ignoriert — dort reicht der direkte kill.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      // Fehler beim Spawn (z. B. git nicht installiert)
      reject(new GitExecutorError(`Failed to spawn git: ${(err as Error).message}`, err as Error));
      return;
    }

    /**
     * Killt git und alle Kinder. Auf POSIX via negative PID → Prozessgruppe.
     * Auf Windows via direktem child.kill().
     */
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.killed || settled) return;
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Prozess kann bereits beendet sein — ignorieren.
      }
    };

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Optionaler externer Abbruch
    const onAbort = (): void => {
      if (!settled && !child.killed) {
        logger.warn(`git ${previewArgs(fullArgs)} aborted via signal`);
        killTree('SIGTERM');
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // Timeout-Handling
    const timeoutHandle = setTimeout(() => {
      if (!settled && !child.killed) {
        timedOut = true;
        logger.warn(
          `git ${previewArgs(fullArgs)} timed out after ${options.timeoutMs}ms (cwd=${options.cwd})`,
        );
        // Erst SIGTERM für sauberen Shutdown, dann SIGKILL als Eskalation,
        // falls die Prozessgruppe SIGTERM ignoriert (z. B. hängende Sub-Prozesse).
        killTree('SIGTERM');
        setTimeout(() => {
          if (!settled && !child.killed) {
            killTree('SIGKILL');
          }
        }, 2000).unref();
      }
    }, options.timeoutMs);
    timeoutHandle.unref();

    // stdin schließen — verhindert, dass git/Sub-Prozesse auf Input warten.
    // Wichtig für `GIT_TERMINAL_PROMPT=0`-Wirksamkeit bei manchen Helpern.
    child.stdin?.end();

    // stdout / stderr sammeln
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // Stream-Fehler abfangen, damit Promise nicht hängenbleibt
    child.stdout?.on('error', (err) => {
      logger.debug(`stdout stream error: ${err.message}`);
    });
    child.stderr?.on('error', (err) => {
      logger.debug(`stderr stream error: ${err.message}`);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new GitExecutorError(`git process error: ${err.message}`, err));
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);

      const result: GitCommandResult = {
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        args: fullArgs,
        cwd: options.cwd,
      };

      if (timedOut) {
        logger.warn(
          `git ${previewArgs(fullArgs)} killed (timeout), exit=${exitCode ?? signal ?? 'n/a'}`,
        );
      } else if (exitCode !== 0) {
        logger.debug(
          `git ${previewArgs(fullArgs)} exited with ${exitCode ?? signal ?? 'n/a'} in ${result.durationMs}ms`,
        );
      }

      resolve(result);
    });
  });
}

/**
 * Convenience: wirft, wenn der Exit-Code nicht 0 ist.
 * Nutzbar für Befehle, bei denen ein Fehler immer fatal ist
 * (z. B. `git stash pop`, `git fetch origin`). Bei Befehlen, deren
 * Fehlerverhalten im Flowchart speziell behandelt wird (Push, Code-Change),
 * sollte das rohe `runGit`-Ergebnis ausgewertet werden.
 *
 * @throws {GitExecutorError} wenn `exitCode !== 0`
 */
export async function runGitChecked(
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  const result = await runGit(args, options);
  if (result.exitCode !== 0) {
    const reason = result.timedOut
      ? `timeout after ${options.timeoutMs}ms`
      : `exit code ${result.exitCode ?? result.signal}`;
    throw new GitExecutorError(
      `git ${previewArgs(result.args)} failed (${reason}): ${result.stderr.trim() || result.stdout.trim() || '<no output>'}`,
    );
  }
  return result;
}

/**
 * Prüft, ob `git` im PATH ist und liefert die Version zurück.
 * Sinnvoll als Startup-Check im CLI-Wiring.
 *
 * @returns Versions-String wie `git version 2.43.0` oder `null` wenn nicht gefunden
 */
export async function detectGit(timeoutMs = 5000): Promise<string | null> {
  try {
    const result = await runGit(['--version'], {
      cwd: process.cwd(),
      timeoutMs,
    });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

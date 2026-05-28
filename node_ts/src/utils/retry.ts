/**
 * Retry-Modul mit exponentiellem Backoff.
 *
 * Implementiert die Push-Retry-Logik aus Phase 3.6 des Flowcharts:
 *
 *   Push-Counter = 0
 *   loop:
 *     git push origin --force-with-lease
 *     Push successful?
 *       Yes → break (success path)
 *       No  → Counter < maxAttempts?
 *               Yes → Counter + 1 → Sleep (Backoff) → loop
 *               No  → Log 'Push Error after multiple Retries' → fail path
 *
 * Das Modul ist generisch: dieselbe Logik wird später für PR-API-Calls
 * in Phase 4 wiederverwendet, sodass wir uns nicht wiederholen.
 *
 * Backoff-Strategie:
 *   - Exponentiell: delay = backoffMs * 2^(attempt-1)
 *   - Cap bei `maxBackoffMs` (verhindert unrealistisch lange Waits)
 *   - Optionaler Jitter ±25% (verhindert "thundering herd" bei parallelen RUs)
 */

import type { Logger } from './logger.js';
import { getDefaultLogger } from './logger.js';

/**
 * Konfiguration für einen Retry-Lauf.
 */
export interface RetryOptions {
  /** Maximale Anzahl Versuche (Flowchart: 3). Muss >= 1 sein. */
  maxAttempts: number;
  /** Basis-Backoff in Millisekunden (erster Wait nach erstem Fehlversuch) */
  backoffMs: number;
  /** Maximaler Backoff in ms (Cap für exponentielles Wachstum) */
  maxBackoffMs: number;
  /**
   * Wenn `true` (Standard), wird zufällige Streuung ±25% auf den Backoff
   * angewendet. Verhindert Synchronisierungs-Effekte bei parallelen Retries.
   */
  jitter?: boolean;
  /** Optionaler Logger für Diagnose-Output */
  logger?: Logger;
  /** Optionaler AbortSignal für kooperativen Abbruch (z. B. Ctrl+C) */
  signal?: AbortSignal;
  /**
   * Optionale Beschreibung für Logs (z. B. `'git push for repo-a'`).
   * Sollte nicht das Wort "retry" enthalten — wird automatisch eingebaut.
   */
  description?: string;
}

/**
 * Ergebnis der Versuchs-Operation. Steuert, ob retried wird.
 *
 *   - `{ ok: true, value }`           → Erfolg, Retry-Schleife endet
 *   - `{ ok: false, retry: true }`    → retrybarer Fehler, Backoff & weiter
 *   - `{ ok: false, retry: false }`   → permanenter Fehler, sofort abbrechen
 *
 * Der Aufrufer entscheidet anhand der Domäne, ob ein Fehler retrybar ist.
 * Beispiel git push:
 *   - Exit-Code != 0 mit "rejected (fetch first)" → retrybar
 *   - Exit-Code != 0 mit "Authentication failed"  → nicht retrybar
 */
export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; retry: boolean; error: string };

/**
 * Ergebnis der gesamten Retry-Operation.
 */
export type RetryResult<T> =
  | {
      ok: true;
      value: T;
      attempts: number;
      totalDurationMs: number;
    }
  | {
      ok: false;
      error: string;
      attempts: number;
      totalDurationMs: number;
      /** `true`, wenn alle Versuche aufgebraucht wurden (vs. permanenter Fehler) */
      exhausted: boolean;
    };

/**
 * Berechnet die Wartezeit vor dem nächsten Versuch.
 * `attempt` ist die Nummer des bereits gemachten (fehlgeschlagenen) Versuchs,
 * d. h. bei `attempt=1` wartet man `backoffMs * 2^0 = backoffMs`.
 */
export function computeBackoff(
  attempt: number,
  backoffMs: number,
  maxBackoffMs: number,
  jitter = true,
): number {
  if (attempt < 1) return 0;
  const exponential = backoffMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxBackoffMs);
  if (!jitter) return Math.round(capped);

  // ±25% Jitter (multiplikativ in [0.75, 1.25))
  const factor = 0.75 + Math.random() * 0.5;
  return Math.round(capped * factor);
}

/**
 * Sleep-Helfer, der respektvoll auf AbortSignal reagiert.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Führt eine Operation mit Retry-Logik aus.
 *
 * Spiegelt die Push-Loop aus Phase 3.6 des Flowcharts wider. Statt
 * Booleans verwenden wir das `AttemptResult`-Pattern, weil git-Pushes
 * unterschiedliche Fehler-Modi haben (transient vs. permanent).
 *
 * @param operation - Die zu wiederholende Operation. Erhält die aktuelle
 *                    Versuchs-Nummer (1-basiert) für Logging-Zwecke.
 * @param options - Retry-Konfiguration
 * @returns Ergebnis (Erfolg oder erschöpfter Fehler)
 *
 * @example
 * ```ts
 * const result = await retry(
 *   async (attempt) => {
 *     const r = await runGit(['push', 'origin', '--force-with-lease'], cmdOpts);
 *     if (r.exitCode === 0) return { ok: true, value: r };
 *     // Auth-Fehler ist nicht retrybar
 *     if (r.stderr.includes('Authentication failed')) {
 *       return { ok: false, retry: false, error: 'auth failed' };
 *     }
 *     return { ok: false, retry: true, error: `exit ${r.exitCode}` };
 *   },
 *   { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 30_000 },
 * );
 * ```
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<AttemptResult<T>>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  if (options.maxAttempts < 1) {
    throw new Error(`maxAttempts must be >= 1, got ${options.maxAttempts}`);
  }
  if (options.backoffMs < 0) {
    throw new Error(`backoffMs must be >= 0, got ${options.backoffMs}`);
  }
  if (options.maxBackoffMs < options.backoffMs) {
    throw new Error(
      `maxBackoffMs (${options.maxBackoffMs}) must be >= backoffMs (${options.backoffMs})`,
    );
  }

  const logger = options.logger ?? getDefaultLogger();
  const jitter = options.jitter ?? true;
  const label = options.description ?? 'operation';
  const startedAt = Date.now();

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    // Abbruch-Check vor jedem Versuch (z. B. Ctrl+C zwischen Retries)
    if (options.signal?.aborted) {
      return {
        ok: false,
        error: 'aborted before attempt',
        attempts: attempt - 1,
        totalDurationMs: Date.now() - startedAt,
        exhausted: false,
      };
    }

    let attemptResult: AttemptResult<T>;
    try {
      attemptResult = await operation(attempt);
    } catch (err) {
      // Unerwartete Exception innerhalb der Operation → als retrybar behandeln,
      // damit eine zufällige Netzwerk-Exception nicht den Bulk-Lauf killt.
      // Wer permanenten Abbruch will, soll explizit `retry: false` zurückgeben.
      attemptResult = {
        ok: false,
        retry: true,
        error: `unexpected exception: ${(err as Error).message}`,
      };
    }

    if (attemptResult.ok) {
      if (attempt > 1) {
        logger.info(`${label} succeeded on attempt ${attempt}/${options.maxAttempts}`);
      }
      return {
        ok: true,
        value: attemptResult.value,
        attempts: attempt,
        totalDurationMs: Date.now() - startedAt,
      };
    }

    lastError = attemptResult.error;

    // Permanenter Fehler → keine weiteren Versuche
    if (!attemptResult.retry) {
      logger.warn(
        `${label} failed permanently on attempt ${attempt}/${options.maxAttempts}: ${lastError}`,
      );
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        totalDurationMs: Date.now() - startedAt,
        exhausted: false,
      };
    }

    // Letzter Versuch — kein Warten mehr, direkt scheitern
    if (attempt >= options.maxAttempts) {
      logger.warn(`${label} failed after ${options.maxAttempts} attempts: ${lastError}`);
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        totalDurationMs: Date.now() - startedAt,
        exhausted: true,
      };
    }

    // Backoff vor dem nächsten Versuch
    const waitMs = computeBackoff(attempt, options.backoffMs, options.maxBackoffMs, jitter);
    logger.info(
      `${label} attempt ${attempt}/${options.maxAttempts} failed (${lastError}), retrying in ${waitMs}ms`,
    );

    try {
      await sleep(waitMs, options.signal);
    } catch {
      // Abort während des Sleep
      return {
        ok: false,
        error: 'aborted during backoff',
        attempts: attempt,
        totalDurationMs: Date.now() - startedAt,
        exhausted: false,
      };
    }
  }

  // Unerreichbar, aber TypeScript braucht die Rückgabe
  return {
    ok: false,
    error: lastError,
    attempts: options.maxAttempts,
    totalDurationMs: Date.now() - startedAt,
    exhausted: true,
  };
}

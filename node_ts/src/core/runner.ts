/**
 * Runner — Phase 2 des Flowcharts ("Preparation" + Iterations-Loop).
 *
 * Entspricht dem Flowchart-Knoten `More RUs in list?` und der gesamten
 * Orchestrierung pro RU:
 *
 *   für jeden RU in $config.rus:
 *     1. Phase 3 ausführen (Git & Code)
 *     2. Phase 4 ausführen (PR erstellen, falls vorgesehen)
 *     3. Ergebnis sammeln
 *
 * Concurrency:
 *   - `$config.concurrency = 1` → strikt sequenziell (entspricht Flowchart)
 *   - `$config.concurrency > 1` → parallele Verarbeitung mit p-limit
 *
 * Reporting:
 *   Am Ende wird ein `RunSummary` zurückgegeben, der pro RU den Status
 *   und am Ende eine aggregierte Statistik enthält.
 */

import { createLimit } from '../utils/concurrency.js';

import type { GitBulkConfig } from '../config/schema.js';
import { runPhase3, type Phase3Result } from '../git/phase3.js';
import { runPhase4, type Phase4Result } from '../git/phase4.js';
import { createPrAdapter, type PullRequestAdapter } from '../git/pr-adapter.js';
import { getDefaultLogger, type Logger } from '../utils/logger.js';

/**
 * Ergebnis pro RU.
 */
export interface RuResult {
  ru: string;
  phase3: Phase3Result;
  phase4: Phase4Result;
  /** Gesamt-Status für Report-Zwecke */
  outcome: 'pr-created' | 'pr-skipped' | 'pr-failed' | 'not-processed' | 'fatal-error';
  /** Gesamt-Dauer der RU-Verarbeitung in ms */
  durationMs: number;
}

/**
 * Aggregiertes Endergebnis eines GitBulk-Laufs.
 */
export interface RunSummary {
  results: RuResult[];
  totals: {
    rus: number;
    prsCreated: number;
    prsSkipped: number;
    prsFailed: number;
    notProcessed: number;
    fatalErrors: number;
  };
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
}

/**
 * Status einer RU während der Verarbeitung — für Live-Fortschritt (TUI/CLI).
 *
 *   - `running`  → Verarbeitung hat begonnen (Phase 3 startet)
 *   - `done`     → erfolgreich abgeschlossen (Outcome steht fest, kein Fehler)
 *   - `failed`   → mit Fehler abgeschlossen (pr-failed oder fatal-error)
 *   - `skipped`  → übersprungen (not-processed oder pr-skipped)
 */
export type RuProgressStatus = 'running' | 'done' | 'failed' | 'skipped';

/**
 * Fortschritts-Event für eine einzelne RU.
 */
export interface RuProgressEvent {
  ru: string;
  status: RuProgressStatus;
  /** Bei `done`/`failed`/`skipped`: das finale Outcome. Bei `running`: undefined. */
  outcome?: RuResult['outcome'];
  /** Index der RU in der Gesamtliste (0-basiert) — für "3/10"-Anzeigen. */
  index: number;
  /** Gesamtanzahl RUs. */
  total: number;
}

/**
 * Optionen für den Runner.
 */
export interface RunOptions {
  /** Optional eigener Adapter (für Tests). Sonst wird `createPrAdapter()` genutzt. */
  prAdapter?: PullRequestAdapter;
  /** Optional eigener Logger (Default: getDefaultLogger). */
  logger?: Logger;
  /** Optionales AbortSignal für kooperativen Abbruch (z. B. Ctrl+C). */
  signal?: AbortSignal;
  /**
   * Optionaler Fortschritts-Callback. Wird pro RU mindestens zweimal
   * aufgerufen: einmal mit `running` beim Start, einmal mit dem finalen
   * Status (`done`/`failed`/`skipped`). Genutzt von der TUI und optional
   * vom CLI für Live-Anzeigen.
   *
   * Der Callback sollte NICHT werfen — Fehler darin werden vom Runner
   * abgefangen und ignoriert, damit die UI den Lauf nicht crashen kann.
   */
  onProgress?: (event: RuProgressEvent) => void;
}

/**
 * Mappt ein finales Outcome auf den gröberen Progress-Status.
 */
function outcomeToProgressStatus(outcome: RuResult['outcome']): RuProgressStatus {
  switch (outcome) {
    case 'pr-created':
      return 'done';
    case 'pr-failed':
    case 'fatal-error':
      return 'failed';
    case 'pr-skipped':
    case 'not-processed':
      return 'skipped';
  }
}

/**
 * Klassifiziert das RU-Ergebnis für den Report.
 */
function classifyOutcome(p3: Phase3Result, p4: Phase4Result): RuResult['outcome'] {
  if (!p3.processed) return 'not-processed';
  if (p3.fatalError !== undefined) return 'fatal-error';

  // Phase 3 hat keinen PR gewollt (empty oder Skip wegen errorPrOn=false)
  if (p3.prStatus === 'empty') return 'pr-skipped';
  if (!p4.apiCalled) return 'pr-skipped';

  return p4.success ? 'pr-created' : 'pr-failed';
}

/**
 * Verarbeitet eine einzelne RU: Phase 3 → Phase 4.
 */
async function processRu(
  ru: string,
  config: GitBulkConfig,
  adapter: PullRequestAdapter,
  logger: Logger,
  ctx: {
    index: number;
    total: number;
    signal?: AbortSignal;
    onProgress?: (event: RuProgressEvent) => void;
  },
): Promise<RuResult> {
  const ruLogger = logger.withRu(ru);
  const startedAt = Date.now();

  // Sicherer Event-Emitter: ein werfender Callback darf den Lauf nicht crashen.
  const emit = (status: RuProgressStatus, outcome?: RuResult['outcome']): void => {
    if (!ctx.onProgress) return;
    // outcome nur ins Event aufnehmen, wenn gesetzt (exactOptionalPropertyTypes).
    const event: RuProgressEvent =
      outcome === undefined
        ? { ru, status, index: ctx.index, total: ctx.total }
        : { ru, status, outcome, index: ctx.index, total: ctx.total };
    try {
      ctx.onProgress(event);
    } catch {
      /* UI-Fehler ignorieren */
    }
  };

  // Frühzeitiger Abbruch-Check
  if (ctx.signal?.aborted) {
    const phase3: Phase3Result = {
      ru,
      processed: false,
      prStatus: 'empty',
      featureBranch: '',
      notes: ['Aborted before processing'],
      cleanupOk: true,
    };
    const phase4: Phase4Result = { ru, apiCalled: false, success: false, notes: [] };
    emit('skipped', 'not-processed');
    return {
      ru,
      phase3,
      phase4,
      outcome: 'not-processed',
      durationMs: Date.now() - startedAt,
    };
  }

  emit('running');
  ruLogger.info(`Starting processing`);

  // Phase 3
  const phase3 = await runPhase3(ru, config);

  // Phase 4 (auch bei 'empty' aufrufen — die Phase loggt selbst korrekt)
  const phase4 = await runPhase4(phase3, config, adapter);

  const result: RuResult = {
    ru,
    phase3,
    phase4,
    outcome: classifyOutcome(phase3, phase4),
    durationMs: Date.now() - startedAt,
  };

  emit(outcomeToProgressStatus(result.outcome), result.outcome);
  ruLogger.info(`Done in ${result.durationMs}ms — outcome: ${result.outcome}`);
  return result;
}

/**
 * Aggregiert die Einzelergebnisse zu einer `RunSummary`.
 */
function buildSummary(
  results: RuResult[],
  startedAt: Date,
  finishedAt: Date,
): RunSummary {
  const totals = {
    rus: results.length,
    prsCreated: 0,
    prsSkipped: 0,
    prsFailed: 0,
    notProcessed: 0,
    fatalErrors: 0,
  };
  for (const r of results) {
    switch (r.outcome) {
      case 'pr-created':
        totals.prsCreated++;
        break;
      case 'pr-skipped':
        totals.prsSkipped++;
        break;
      case 'pr-failed':
        totals.prsFailed++;
        break;
      case 'not-processed':
        totals.notProcessed++;
        break;
      case 'fatal-error':
        totals.fatalErrors++;
        break;
    }
  }
  return {
    results,
    totals,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

/**
 * Hauptfunktion: führt einen GitBulk-Lauf durch.
 *
 * Reihenfolge:
 *   1. PR-Adapter bauen (außer der Aufrufer übergibt einen via options)
 *   2. Für jede RU: Phase 3 → Phase 4
 *   3. Summary aggregieren und zurückgeben
 *
 * Bei `concurrency > 1` werden RUs parallel verarbeitet. Trotzdem werden
 * alle Ergebnisse gesammelt, bevor zurückgegeben wird (keine Streaming-API).
 *
 * @param config - Validierte, gefreezte GitBulk-Konfiguration
 * @param options - Optionale Runner-Optionen (Adapter, Logger, Abort)
 * @returns Aggregiertes Ergebnis
 */
export async function runBulk(
  config: GitBulkConfig,
  options: RunOptions = {},
): Promise<RunSummary> {
  const logger = options.logger ?? getDefaultLogger();
  const startedAt = new Date();

  // PR-Adapter beschaffen (kann via options überschrieben werden, z. B. für Tests)
  const adapter = options.prAdapter ?? (await createPrAdapter(config));

  logger.info(
    `Starting GitBulk run: ${config.rus.length} RUs, platform=${adapter.platformName}, concurrency=${config.concurrency}${config.dryRun ? ' [DRY-RUN]' : ''}`,
  );

  const limit = createLimit(config.concurrency);
  const total = config.rus.length;

  // ctx-Basis; optionale Felder nur setzen wenn vorhanden (exactOptionalPropertyTypes).
  const baseCtx: {
    total: number;
    signal?: AbortSignal;
    onProgress?: (event: RuProgressEvent) => void;
  } = { total };
  if (options.signal) baseCtx.signal = options.signal;
  if (options.onProgress) baseCtx.onProgress = options.onProgress;

  // Pro RU eine Task, p-limit regelt die parallele Ausführung.
  const tasks = config.rus.map((ru, index) =>
    limit(() => processRu(ru, config, adapter, logger, { ...baseCtx, index })),
  );

  const results = await Promise.all(tasks);

  const finishedAt = new Date();
  const summary = buildSummary(results, startedAt, finishedAt);

  // Kurze Zusammenfassung loggen — der CLI macht die ausführliche Tabelle.
  logger.info(
    `Run complete: ${summary.totals.prsCreated} PRs, ${summary.totals.prsSkipped} skipped, ${summary.totals.prsFailed} failed, ${summary.totals.notProcessed} not processed, ${summary.totals.fatalErrors} fatal — ${summary.totalDurationMs}ms`,
  );

  return summary;
}

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

import pLimit from 'p-limit';

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
 * Optionen für den Runner.
 */
export interface RunOptions {
  /** Optional eigener Adapter (für Tests). Sonst wird `createPrAdapter()` genutzt. */
  prAdapter?: PullRequestAdapter;
  /** Optional eigener Logger (Default: getDefaultLogger). */
  logger?: Logger;
  /** Optionales AbortSignal für kooperativen Abbruch (z. B. Ctrl+C). */
  signal?: AbortSignal;
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
  signal?: AbortSignal,
): Promise<RuResult> {
  const ruLogger = logger.withRu(ru);
  const startedAt = Date.now();

  // Frühzeitiger Abbruch-Check
  if (signal?.aborted) {
    const phase3: Phase3Result = {
      ru,
      processed: false,
      prStatus: 'empty',
      featureBranch: '',
      notes: ['Aborted before processing'],
      cleanupOk: true,
    };
    const phase4: Phase4Result = { ru, apiCalled: false, success: false, notes: [] };
    return {
      ru,
      phase3,
      phase4,
      outcome: 'not-processed',
      durationMs: Date.now() - startedAt,
    };
  }

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

  ruLogger.info(`Done in ${result.durationMs}ms — outcome: ${result.outcome}`);
  return result;
}

/**
 * Aggregiert die Einzelergebnisse zu einer `RunSummary`.
 */
function buildSummary(results: RuResult[], startedAt: Date, finishedAt: Date): RunSummary {
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

  const limit = pLimit(config.concurrency);

  // Pro RU eine Task, p-limit regelt die parallele Ausführung.
  const tasks = config.rus.map((ru) =>
    limit(() => processRu(ru, config, adapter, logger, options.signal)),
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

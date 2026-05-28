/**
 * Phase 4 des Flowcharts — Pull Request anlegen.
 *
 * Diese Phase wird pro RU nach Phase 3 ausgeführt. Sie entscheidet basierend
 * auf `Phase3Result.prStatus`, ob und wie ein PR erstellt wird:
 *
 *   - `empty`                  → kein PR, Log `No PR [dev] RU`
 *   - `create_PR`              → PR via API erstellen
 *   - `create_PR_with_Error`   → PR erstellen NUR wenn `createPrOnError`,
 *                                sonst Log `PR Skip [Sys.], no Diff, Step / RU`
 *
 * Retry-Logik:
 *   API-Calls können transient scheitern (HTTP 5xx, Netzwerk-Glitches).
 *   Wir wenden dieselbe Retry-Logik wie beim Push an, aber unterscheiden
 *   zwischen permanenten Fehlern (4xx außer 429) und retrybaren (5xx, 429,
 *   Netzwerk).
 */

import type { GitBulkConfig } from '../config/schema.js';
import type { Phase3Result } from './phase3.js';
import type { CreatePrInput, CreatePrResult, PullRequestAdapter } from './pr-adapter.js';
import { retry, type AttemptResult, type RetryOptions, type RetryResult } from '../utils/retry.js';
import { getDefaultLogger } from '../utils/logger.js';

/**
 * Ergebnis der Phase-4-Verarbeitung für eine RU.
 */
export interface Phase4Result {
  /** Name der RU */
  ru: string;
  /** Wurde überhaupt ein API-Call gemacht? (false bei `empty` oder Skip) */
  apiCalled: boolean;
  /** War der Call erfolgreich? (nur sinnvoll wenn apiCalled=true) */
  success: boolean;
  /** PR-ID bei Erfolg */
  prId?: string | number;
  /** PR-URL bei Erfolg */
  prUrl?: string;
  /** HTTP-Statuscode (0 bei Netzwerkfehler) */
  statusCode?: number;
  /** Fehler-Meldung bei Fehlschlag */
  error?: string;
  /** Log-Meldungen, die im Flowchart vorgesehen sind */
  notes: string[];
}

/**
 * HTTP-Statuscodes, die als permanent gelten und keinen Retry rechtfertigen.
 * Alles andere (5xx, 429, 0 = Netzwerk) ist retrybar.
 */
function isPermanentHttpFailure(statusCode: number): boolean {
  if (statusCode === 429) return false; // Rate-Limit → retry mit Backoff
  if (statusCode >= 500) return false; // Server-Fehler → retry
  if (statusCode === 0) return false; // Netzwerkfehler → retry
  return statusCode >= 400; // 400-499 (außer 429) → permanent
}

/**
 * Führt Phase 4 für eine einzelne RU durch.
 *
 * @param phase3 - Ergebnis von Phase 3 (steuert via prStatus)
 * @param config - Validierte GitBulk-Config
 * @param adapter - PR-Plattform-Adapter (Bitbucket, Azure, …)
 * @returns Phase-4-Ergebnis mit Log-Meldungen
 */
export async function runPhase4(
  phase3: Phase3Result,
  config: GitBulkConfig,
  adapter: PullRequestAdapter,
): Promise<Phase4Result> {
  const logger = getDefaultLogger().withRu(phase3.ru);
  const result: Phase4Result = {
    ru: phase3.ru,
    apiCalled: false,
    success: false,
    notes: [],
  };

  // ── 4.1 PR-Status-Check ────────────────────────────────────────
  if (phase3.prStatus === 'empty') {
    const msg = `No PR [dev] ${phase3.ru}`;
    logger.info(msg);
    result.notes.push(msg);
    return result;
  }

  // Sonderfall: Fehler im Code-Change, aber createPrOnError = false → skip.
  if (phase3.prStatus === 'create_PR_with_Error' && !config.createPrOnError) {
    const msg = `PR Skip [Sys.], no Diff, Step / ${phase3.ru}`;
    logger.info(msg);
    result.notes.push(msg);
    return result;
  }

  // Welcher Target-Branch? Plattform-Settings haben das letzte Wort.
  const targetBranch = getTargetBranch(config);

  // PR-Titel: Bei Fehler-Pfad markieren, damit Reviewer den Status sehen.
  const titlePrefix = phase3.prStatus === 'create_PR_with_Error' ? '[ERROR] ' : '';
  const input: CreatePrInput = {
    ru: phase3.ru,
    sourceBranch: phase3.featureBranch,
    targetBranch,
    title: `${titlePrefix}${config.prSummary}`,
    description: config.prSummary,
    reviewers: getReviewers(config),
  };

  // ── 4.2 Im Dry-Run NICHT wirklich aufrufen ─────────────────────
  if (config.dryRun) {
    const msg = `[dry-run] would POST PR for ${phase3.ru} (${input.sourceBranch} → ${input.targetBranch})`;
    logger.info(msg);
    result.notes.push(msg);
    result.apiCalled = false;
    result.success = true; // im Dry-Run gilt das als Erfolg
    return result;
  }

  // ── 4.2 API-Call mit Retry ─────────────────────────────────────
  const retryOpts: RetryOptions = {
    maxAttempts: config.retry.maxAttempts,
    backoffMs: config.retry.backoffMs,
    maxBackoffMs: config.retry.maxBackoffMs,
    description: `create PR for ${phase3.ru}`,
    logger,
  };

  const retryResult: RetryResult<CreatePrResult> = await retry<CreatePrResult>(
    async (): Promise<AttemptResult<CreatePrResult>> => {
      result.apiCalled = true;
      const apiResult = await adapter.createPullRequest(input);

      if (apiResult.ok) {
        return { ok: true, value: apiResult };
      }

      // Permanenter Fehler? (4xx außer 429)
      if (isPermanentHttpFailure(apiResult.statusCode)) {
        return { ok: false, retry: false, error: apiResult.error };
      }
      return { ok: false, retry: true, error: apiResult.error };
    },
    retryOpts,
  );

  // ── 4.3 Ergebnis verarbeiten ───────────────────────────────────
  if (retryResult.ok) {
    const success = retryResult.value as Extract<CreatePrResult, { ok: true }>;
    result.success = true;
    result.prId = success.id;
    result.prUrl = success.url;
    result.statusCode = success.statusCode;
    const msg = `PR successful, ${phase3.ru} (#${success.id})`;
    logger.info(msg);
    result.notes.push(msg);
  } else {
    result.success = false;
    result.error = retryResult.error;
    const msg = `PR failed [API] ${phase3.ru} / ${retryResult.error}`;
    logger.warn(msg);
    result.notes.push(msg);
  }

  return result;
}

/**
 * Liest den Target-Branch aus der plattform-spezifischen Sub-Config.
 * Fallback ist `sourceBranch` aus dem Top-Level (gleiches Default-Verhalten).
 */
function getTargetBranch(config: GitBulkConfig): string {
  switch (config.prPlatform) {
    case 'bitbucket':
      return config.bitbucket?.targetBranch ?? config.sourceBranch;
    case 'azure-devops':
      return config.azureDevOps?.targetBranch ?? config.sourceBranch;
    default:
      return config.sourceBranch;
  }
}

/**
 * Liest die Reviewer-Liste aus der plattform-spezifischen Sub-Config.
 */
function getReviewers(config: GitBulkConfig): readonly string[] {
  switch (config.prPlatform) {
    case 'bitbucket':
      return config.bitbucket?.reviewers ?? [];
    case 'azure-devops':
      return config.azureDevOps?.reviewers ?? [];
    default:
      return [];
  }
}

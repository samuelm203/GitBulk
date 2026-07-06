/**
 * `gitbulk close` — schließt die offenen PRs eines Ticket/Branch über alle RUs
 * und löscht die Remote-Feature-Branches (Aufräumen nach einem Fehl-Lauf).
 *
 * Ablauf pro RU (parallel mit `config.concurrency`):
 *   1. PR-Status nachschlagen (wie `gitbulk status`).
 *   2. Offener PR → über den Adapter schließen/declinen.
 *   3. Remote-Feature-Branch löschen (`git push origin --delete <branch>`),
 *      ausgeführt aus dem lokalen RU-Repo — plattformunabhängig, keine
 *      zusätzliche API-Fläche. Fehlt das Repo lokal, wird das gemeldet.
 *
 * Dry-Run zeigt nur, WAS passieren würde (keine API-/Push-Aufrufe).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createLimit } from '../utils/concurrency.js';
import { buildFeatureBranchName } from './operations.js';
import { runGit } from './executor.js';
import { resolveRepoPath } from './phase3.js';
import type { GitBulkConfig } from '../config/schema.js';
import type { ClosePrInput, PrLookupInput, PullRequestAdapter } from './pr-adapter.js';

/** PR-Teil-Ergebnis einer RU. */
export type ClosePrOutcome = 'closed' | 'would-close' | 'no-open-pr' | 'close-failed' | 'error';

/** Branch-Teil-Ergebnis einer RU. */
export type CloseBranchOutcome =
  | 'deleted'
  | 'would-delete'
  | 'not-found'
  | 'repo-missing'
  | 'delete-failed';

/** Ergebnis einer RU beim `close`. */
export interface RuCloseResult {
  ru: string;
  pr: ClosePrOutcome;
  prId?: string | number;
  prUrl?: string;
  branch: CloseBranchOutcome;
  /** Fehlertext (Status-Lookup, Close-API oder Branch-Delete). */
  error?: string;
}

/** Aggregierter Report über alle RUs. */
export interface CloseReport {
  ticket: string;
  sourceBranch: string;
  platform: string;
  dryRun: boolean;
  results: RuCloseResult[];
  totals: {
    prsClosed: number;
    noOpenPr: number;
    branchesDeleted: number;
    failed: number;
  };
}

/** Adapter, der Status-Lookup UND Close kann (Aufrufer stellt das sicher). */
export type CloseCapableAdapter = PullRequestAdapter &
  Required<Pick<PullRequestAdapter, 'getPullRequestStatus' | 'closePullRequest'>>;

/** Type-Guard: unterstützt der Adapter `gitbulk close`? */
export function adapterSupportsClose(adapter: PullRequestAdapter): adapter is CloseCapableAdapter {
  return (
    typeof adapter.getPullRequestStatus === 'function' &&
    typeof adapter.closePullRequest === 'function'
  );
}

/** Optionen für {@link closePullRequests}. */
export interface ClosePrOptions {
  /** Nur anzeigen, was passieren würde (keine API-/Push-Aufrufe). */
  dryRun?: boolean;
  /** AbortSignal für kooperativen Abbruch (Ctrl+C). */
  signal?: AbortSignal;
}

/** Löscht den Remote-Feature-Branch aus dem lokalen RU-Repo heraus. */
async function deleteRemoteBranch(
  config: GitBulkConfig,
  ru: string,
  workspace: string | undefined,
  sourceBranch: string,
): Promise<{ outcome: CloseBranchOutcome; error?: string }> {
  const repoDir = resolveRepoPath(config.workspaceDir, ru, workspace);
  if (!existsSync(join(repoDir, '.git'))) {
    return { outcome: 'repo-missing' };
  }

  const result = await runGit(['push', 'origin', '--delete', sourceBranch], {
    cwd: repoDir,
    timeoutMs: config.commandTimeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.exitCode === 0) return { outcome: 'deleted' };
  // Branch existiert remote (schon) nicht — kein Fehler, Ziel ist erreicht.
  if (/remote ref does not exist/i.test(result.stderr)) {
    return { outcome: 'not-found' };
  }
  return { outcome: 'delete-failed', error: result.stderr.trim() || `exit ${result.exitCode}` };
}

/**
 * Schließt die offenen PRs aller RUs und löscht die Remote-Feature-Branches.
 */
export async function closePullRequests(
  config: GitBulkConfig,
  adapter: CloseCapableAdapter,
  options: ClosePrOptions = {},
): Promise<CloseReport> {
  const dryRun = options.dryRun === true || config.dryRun;
  const sourceBranch = buildFeatureBranchName(config.ticket, config.branch);
  const limit = createLimit(config.concurrency);

  const tasks = config.rus.map((spec) =>
    limit(async (): Promise<RuCloseResult> => {
      if (options.signal?.aborted) {
        return { ru: spec.repo, pr: 'error', branch: 'repo-missing', error: 'aborted' };
      }

      const lookup: PrLookupInput = { ru: spec.repo, sourceBranch };
      if (spec.workspace !== undefined) lookup.workspace = spec.workspace;

      // 1. Status nachschlagen.
      const info = await adapter.getPullRequestStatus(lookup);
      const result: RuCloseResult = { ru: spec.repo, pr: 'no-open-pr', branch: 'repo-missing' };
      if (info.id !== undefined) result.prId = info.id;
      if (info.url !== undefined) result.prUrl = info.url;

      if (info.error !== undefined) {
        result.pr = 'error';
        result.error = info.error;
        return result;
      }

      // 2. Offenen PR schließen.
      if (info.state === 'open' && info.id !== undefined) {
        if (dryRun) {
          result.pr = 'would-close';
        } else {
          const closeInput: ClosePrInput = { ...lookup, id: info.id };
          const closed = await adapter.closePullRequest(closeInput);
          if (closed.ok) {
            result.pr = 'closed';
          } else {
            result.pr = 'close-failed';
            result.error = closed.error;
          }
        }
      }

      // 3. Remote-Feature-Branch löschen (auch ohne offenen PR — Aufräumen).
      if (dryRun) {
        const repoDir = resolveRepoPath(config.workspaceDir, spec.repo, spec.workspace);
        result.branch = existsSync(join(repoDir, '.git')) ? 'would-delete' : 'repo-missing';
      } else {
        const del = await deleteRemoteBranch(config, spec.repo, spec.workspace, sourceBranch);
        result.branch = del.outcome;
        if (del.error !== undefined && result.error === undefined) result.error = del.error;
      }

      return result;
    }),
  );

  const results = await Promise.all(tasks);

  const totals = { prsClosed: 0, noOpenPr: 0, branchesDeleted: 0, failed: 0 };
  for (const r of results) {
    if (r.pr === 'closed' || r.pr === 'would-close') totals.prsClosed++;
    if (r.pr === 'no-open-pr') totals.noOpenPr++;
    if (r.branch === 'deleted' || r.branch === 'would-delete') totals.branchesDeleted++;
    if (r.pr === 'close-failed' || r.pr === 'error' || r.branch === 'delete-failed') totals.failed++;
  }

  return {
    ticket: config.ticket,
    sourceBranch,
    platform: adapter.platformName,
    dryRun,
    results,
    totals,
  };
}

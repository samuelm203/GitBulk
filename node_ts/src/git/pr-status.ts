/**
 * Sammelt den PR-Status für alle RUs einer Config (read-only, `gitbulk status`).
 *
 * Für jede RU wird aus Ticket + Branch derselbe Source-/Feature-Branch berechnet
 * wie im Bulk-Lauf (`buildFeatureBranchName`) und über den Plattform-Adapter
 * nachgeschlagen — parallel mit `config.concurrency`. Es werden NIE lokale
 * Git-Operationen ausgeführt; das ist eine reine API-Abfrage.
 */

import { createLimit } from '../utils/concurrency.js';
import { buildFeatureBranchName } from './operations.js';
import type { GitBulkConfig } from '../config/schema.js';
import type { PrLookupInput, PrStatusInfo, PullRequestAdapter } from './pr-adapter.js';

/** Status-Info einer einzelnen RU (Status-Felder + RU-Name). */
export interface RuPrStatus extends PrStatusInfo {
  ru: string;
}

/** Aggregierter Status-Report über alle RUs. */
export interface PrStatusReport {
  /** Ticket-ID aus der Config. */
  ticket: string;
  /** Berechneter Source-/Feature-Branch (`<ticket>-<branch>`). */
  sourceBranch: string;
  /** Plattform-Name (z. B. `'bitbucket'`). */
  platform: string;
  /** Pro RU ein Eintrag, in Config-Reihenfolge. */
  results: RuPrStatus[];
  /** Aggregierte Zähler. `errored` zählt RUs mit API-Fehler separat von `none`. */
  totals: {
    open: number;
    merged: number;
    declined: number;
    none: number;
    errored: number;
  };
}

/** Adapter, der den Status-Lookup zwingend kann (Aufrufer stellt das sicher). */
export type StatusCapableAdapter = PullRequestAdapter &
  Required<Pick<PullRequestAdapter, 'getPullRequestStatus'>>;

/** Type-Guard: unterstützt der Adapter überhaupt Status-Lookups? */
export function adapterSupportsStatus(
  adapter: PullRequestAdapter,
): adapter is StatusCapableAdapter {
  return typeof adapter.getPullRequestStatus === 'function';
}

/** Optionen für {@link collectPrStatus}. */
export interface CollectStatusOptions {
  /** AbortSignal für kooperativen Abbruch (z. B. Ctrl+C). */
  signal?: AbortSignal;
}

/**
 * Fragt den PR-Status für jede RU der Config ab und aggregiert das Ergebnis.
 *
 * @param config  - Validierte GitBulk-Config (liefert RUs, Ticket, Branch).
 * @param adapter - Status-fähiger Plattform-Adapter (siehe {@link adapterSupportsStatus}).
 * @param options - Optionales AbortSignal.
 */
export async function collectPrStatus(
  config: GitBulkConfig,
  adapter: StatusCapableAdapter,
  options: CollectStatusOptions = {},
): Promise<PrStatusReport> {
  const sourceBranch = buildFeatureBranchName(config.ticket, config.branch);
  const limit = createLimit(config.concurrency);

  const tasks = config.rus.map((spec) =>
    limit(async (): Promise<RuPrStatus> => {
      if (options.signal?.aborted) {
        return { ru: spec.repo, state: 'none', error: 'aborted' };
      }
      const input: PrLookupInput = { ru: spec.repo, sourceBranch };
      if (spec.workspace !== undefined) input.workspace = spec.workspace;
      const info = await adapter.getPullRequestStatus(input);
      return { ru: spec.repo, ...info };
    }),
  );

  const results = await Promise.all(tasks);

  const totals = { open: 0, merged: 0, declined: 0, none: 0, errored: 0 };
  for (const r of results) {
    if (r.error !== undefined) {
      totals.errored++;
      continue;
    }
    totals[r.state]++;
  }

  return { ticket: config.ticket, sourceBranch, platform: adapter.platformName, results, totals };
}

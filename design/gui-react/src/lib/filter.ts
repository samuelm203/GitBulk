import type { RepoState } from '../types';

/** Filter-Kategorien der RU-Tabelle (Stat-Kacheln + „Alle"). */
export type StatusFilter = 'all' | 'created' | 'updated' | 'failed' | 'skipped';

/**
 * Ordnet eine RU einer Filter-Kategorie zu. `pending`/`running` haben keine
 * Endkategorie → `null` (erscheinen nur unter „Alle").
 */
export function repoCategory(repo: RepoState): Exclude<StatusFilter, 'all'> | null {
  switch (repo.status) {
    case 'done':
      return repo.prUpdated ? 'updated' : 'created';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return null;
  }
}

/** Trifft eine RU den aktiven Status-Filter und die Textsuche? */
export function matchesFilter(repo: RepoState, filter: StatusFilter, query: string): boolean {
  if (filter !== 'all' && repoCategory(repo) !== filter) return false;
  const trimmed = query.trim().toLowerCase();
  if (trimmed !== '' && !repo.name.toLowerCase().includes(trimmed)) return false;
  return true;
}

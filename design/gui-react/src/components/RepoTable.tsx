import { ExternalLink, Search, X } from 'lucide-react';

import type { RepoState, RuStatus } from '../types';
import { matchesFilter, type StatusFilter } from '../lib/filter';
import { MiniPipeline } from './MiniPipeline';
import { formatDuration } from '../lib/format';

interface RepoTableProps {
  repos: readonly RepoState[];
  statusFilter: StatusFilter;
  query: string;
  onQueryChange: (query: string) => void;
}

const STATUS_TEXT: Record<RuStatus, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  done: 'PR erstellt',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

const STATUS_TONE: Record<RuStatus, string> = {
  pending: 'text-ink-faint',
  running: 'text-brand',
  done: 'text-ok',
  failed: 'text-err',
  skipped: 'text-warn',
};

function statusLabel(repo: RepoState): string {
  if (repo.status === 'running') return repo.stage === 'pr' ? 'PR erstellen' : 'Anpassen';
  if (repo.status === 'done' && repo.prUpdated) return 'PR aktualisiert';
  return STATUS_TEXT[repo.status];
}

function RepoDetail({ repo }: { repo: RepoState }) {
  if (repo.status === 'failed' && repo.error !== null) {
    return <span className="text-err">{repo.error}</span>;
  }
  if (repo.status === 'skipped' && repo.note !== null) {
    return <span className="text-ink-muted">{repo.note}</span>;
  }
  if (repo.status === 'done' && repo.prUrl !== null) {
    return (
      <span className="inline-flex items-center gap-2">
        <a
          href={repo.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
        >
          PR #{repo.prId}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
        {repo.prUpdated ? (
          <span className="rounded border border-line px-1.5 text-[11px] font-medium text-ink-muted">
            updated
          </span>
        ) : null}
      </span>
    );
  }
  return <span className="text-ink-faint">—</span>;
}

function RepoRow({ repo }: { repo: RepoState }) {
  return (
    <tr className="border-t border-line-soft transition-colors hover:bg-surface-2">
      <td className="py-3 pl-4 pr-3 align-middle sm:pl-6">
        <span className="font-medium text-ink">{repo.name}</span>
      </td>
      <td className="px-3 py-3 align-middle">
        <MiniPipeline repo={repo} />
      </td>
      <td className={`px-3 py-3 align-middle text-sm font-medium ${STATUS_TONE[repo.status]}`}>
        {statusLabel(repo)}
      </td>
      <td className="hidden px-3 py-3 align-middle text-sm tabular-nums text-ink-muted md:table-cell">
        {repo.durationMs !== null ? formatDuration(repo.durationMs) : '—'}
      </td>
      <td className="px-3 py-3 pr-4 align-middle text-sm sm:pr-6">
        <RepoDetail repo={repo} />
      </td>
    </tr>
  );
}

/** Datentabelle aller RUs — mit Live-Suche und Status-Filter. */
export function RepoTable({ repos, statusFilter, query, onQueryChange }: RepoTableProps) {
  const visible = repos.filter((repo) => matchesFilter(repo, statusFilter, query));
  const isFiltered = statusFilter !== 'all' || query.trim() !== '';

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface" aria-labelledby="repos-heading">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 sm:px-6">
        <h2 id="repos-heading" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Repositories
        </h2>
        <span className="text-[11px] font-medium tabular-nums text-ink-faint">
          {isFiltered ? `${visible.length} / ${repos.length}` : repos.length}
        </span>
        <div className="relative ml-auto">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <input
            id="ru-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Suchen…  (/)"
            aria-label="Repositories suchen"
            className="w-40 rounded-md border border-line bg-surface-2 py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-ink-faint focus-visible:border-brand focus-visible:outline-none sm:w-52"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-ink-faint">
              <th scope="col" className="py-2 pl-4 pr-3 font-medium sm:pl-6">
                Repository
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Pipeline
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                Dauer
              </th>
              <th scope="col" className="px-3 py-2 pr-4 font-medium sm:pr-6">
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center sm:px-6">
                  <p className="flex items-center justify-center gap-2 text-sm text-ink-faint">
                    <X className="h-4 w-4" aria-hidden="true" />
                    Keine Repositories für diesen Filter.
                  </p>
                </td>
              </tr>
            ) : (
              visible.map((repo) => <RepoRow key={repo.name} repo={repo} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

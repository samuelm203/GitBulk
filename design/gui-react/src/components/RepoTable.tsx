import { ExternalLink } from 'lucide-react';

import type { RepoState, RuStatus } from '../types';
import { MiniPipeline } from './MiniPipeline';
import { formatDuration } from '../lib/format';

const STATUS_TEXT: Record<RuStatus, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  done: 'PR erstellt',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

const STATUS_TONE: Record<RuStatus, string> = {
  pending: 'text-zinc-400',
  running: 'text-brand',
  done: 'text-emerald-600',
  failed: 'text-red-600',
  skipped: 'text-amber-600',
};

function statusLabel(repo: RepoState): string {
  if (repo.status === 'running') return repo.stage === 'pr' ? 'PR erstellen' : 'Anpassen';
  if (repo.status === 'done' && repo.prUpdated) return 'PR aktualisiert';
  return STATUS_TEXT[repo.status];
}

function RepoDetail({ repo }: { repo: RepoState }) {
  if (repo.status === 'failed' && repo.error !== null) {
    return <span className="text-red-600">{repo.error}</span>;
  }
  if (repo.status === 'skipped' && repo.note !== null) {
    return <span className="text-zinc-500">{repo.note}</span>;
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
          <span className="rounded border border-zinc-200 px-1.5 text-[11px] font-medium text-zinc-500">
            updated
          </span>
        ) : null}
      </span>
    );
  }
  return <span className="text-zinc-300">—</span>;
}

function RepoRow({ repo }: { repo: RepoState }) {
  return (
    <tr className="border-t border-zinc-100 transition-colors hover:bg-zinc-50">
      <td className="py-3 pl-4 pr-3 align-middle sm:pl-6">
        <span className="font-medium text-zinc-800">{repo.name}</span>
      </td>
      <td className="px-3 py-3 align-middle">
        <MiniPipeline repo={repo} />
      </td>
      <td className={`px-3 py-3 align-middle text-sm font-medium ${STATUS_TONE[repo.status]}`}>
        {statusLabel(repo)}
      </td>
      <td className="hidden px-3 py-3 align-middle text-sm tabular-nums text-zinc-500 md:table-cell">
        {repo.durationMs !== null ? formatDuration(repo.durationMs) : '—'}
      </td>
      <td className="px-3 py-3 pr-4 align-middle text-sm sm:pr-6">
        <RepoDetail repo={repo} />
      </td>
    </tr>
  );
}

/** Datentabelle aller RUs mit Mini-Pipeline, Status, Dauer und PR-Link. */
export function RepoTable({ repos }: { repos: readonly RepoState[] }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-zinc-200 bg-white"
      aria-labelledby="repos-heading"
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 sm:px-6">
        <h2 id="repos-heading" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Repositories
        </h2>
        <span className="text-[11px] font-medium tabular-nums text-zinc-400">{repos.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-zinc-400">
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
            {repos.map((repo) => (
              <RepoRow key={repo.name} repo={repo} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Maschinenlesbarer Lauf-Report (JSON-Export).
 *
 * Nimmt den auf der GitBulk-Roadmap genannten `--report out.json`-Gedanken
 * vorweg: ein kompaktes, stabiles JSON pro Lauf — ideal fuer CI-Auswertung.
 */

import type { Counts, RepoState, RunContext } from '../types';

export interface RepoReport {
  name: string;
  status: RepoState['status'];
  durationMs: number | null;
  pr?: { id: number; url: string; updated: boolean };
  error?: string;
  note?: string;
}

export interface RunReport {
  generatedAt: string;
  context: RunContext;
  totals: Counts & { total: number };
  repositories: RepoReport[];
}

function toRepoReport(repo: RepoState): RepoReport {
  const report: RepoReport = { name: repo.name, status: repo.status, durationMs: repo.durationMs };
  if (repo.status === 'done' && repo.prId !== null && repo.prUrl !== null) {
    report.pr = { id: repo.prId, url: repo.prUrl, updated: repo.prUpdated };
  }
  if (repo.error !== null) report.error = repo.error;
  if (repo.note !== null) report.note = repo.note;
  return report;
}

/** Baut den Report aus dem aktuellen Lauf-Zustand. */
export function buildReport(
  context: RunContext,
  repos: readonly RepoState[],
  counts: Counts,
): RunReport {
  return {
    generatedAt: new Date().toISOString(),
    context,
    totals: { ...counts, total: repos.length },
    repositories: repos.map(toRepoReport),
  };
}

/** Loest einen Datei-Download des uebergebenen JSON aus. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

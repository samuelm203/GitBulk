import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { RunContext } from './types';
import type { SimRepo } from './lib/simulation';
import type { StatusFilter } from './lib/filter';
import { useRunStream } from './hooks/useRunStream';
import { useTheme } from './hooks/useTheme';
import { buildReport, downloadJson } from './lib/report';
import { AppHeader } from './components/AppHeader';
import { ProcessFlow } from './components/ProcessFlow';
import { StatCluster } from './components/StatCluster';
import { RepoTable } from './components/RepoTable';
import { LogPanel } from './components/LogPanel';
import { SummaryBanner } from './components/SummaryBanner';

// Demodaten des Prototyps (unkritischer Kontext — keine Secrets).
const CONTEXT: RunContext = {
  platform: 'bitbucket',
  ticket: 'AKB-1611',
  branch: 'add-commons-lang3',
  concurrency: 4,
  dryRun: false,
};

// Geplante RUs + ihr (simuliertes) Ergebnis — bewusste Mischung aller Faelle.
const REPO_PLAN: readonly SimRepo[] = [
  { name: 'payments-service', outcome: 'created' },
  { name: 'billing-api', outcome: 'updated' },
  { name: 'web-frontend', outcome: 'created' },
  { name: 'auth-gateway', outcome: 'failed' },
  { name: 'notifications', outcome: 'created' },
  { name: 'reporting-worker', outcome: 'skipped' },
  { name: 'legacy-monolith', outcome: 'updated' },
];

export function App() {
  const repoPlan = useMemo(() => REPO_PLAN, []);
  const run = useRunStream(CONTEXT, repoPlan);
  const { theme, toggle: toggleTheme } = useTheme();
  const { start, phase } = run;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const hasFailures = run.counts.failed > 0;

  const handleFilter = useCallback((category: Exclude<StatusFilter, 'all'>) => {
    setStatusFilter((current) => (current === category ? 'all' : category));
  }, []);

  const handleExport = useCallback(() => {
    const report = buildReport(CONTEXT, run.repos, run.counts);
    downloadJson(`gitbulk-report-${CONTEXT.ticket}.json`, report);
  }, [run.repos, run.counts]);

  // Tastenkuerzel: R = Lauf/Neustart, / = Suche fokussieren, Esc = Filter weg.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || target?.isContentEditable === true;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        document.getElementById('ru-search')?.focus();
      } else if ((event.key === 'r' || event.key === 'R') && !typing && phase !== 'running') {
        start();
      } else if (event.key === 'Escape') {
        setStatusFilter('all');
        setQuery('');
        if (tag === 'input') target?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start, phase]);

  // Optionaler Demo-Autostart (?autostart) — einmalig, fuer Screenshots/Praesentation.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (new URLSearchParams(window.location.search).has('autostart')) start();
  }, [start]);

  return (
    <div className="min-h-full text-ink">
      <AppHeader
        context={CONTEXT}
        phase={run.phase}
        hasFailures={hasFailures}
        theme={theme}
        canExport={run.phase === 'done'}
        onStart={run.start}
        onToggleTheme={toggleTheme}
        onExport={handleExport}
      />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="space-y-5">
            <ProcessFlow repos={run.repos} active={run.phase === 'running'} />
            <StatCluster
              counts={run.counts}
              finished={run.finished}
              total={run.total}
              elapsedMs={run.elapsedMs}
              activeFilter={statusFilter}
              onFilter={handleFilter}
            />
          </div>

          <div className="space-y-5">
            {run.phase === 'done' && run.totalDurationMs !== null ? (
              <SummaryBanner counts={run.counts} totalDurationMs={run.totalDurationMs} />
            ) : null}
            <RepoTable
              repos={run.repos}
              statusFilter={statusFilter}
              query={query}
              onQueryChange={setQuery}
            />
            <LogPanel lines={run.log} />
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-ink-faint">
          GitBulk · Design-Prototyp (React + Tailwind) · Tastenkürzel: <kbd>R</kbd> Lauf ·{' '}
          <kbd>/</kbd> Suche · <kbd>Esc</kbd> Filter zurücksetzen
        </p>
      </main>
    </div>
  );
}

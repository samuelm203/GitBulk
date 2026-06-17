import { useEffect, useMemo, useRef } from 'react';

import type { RunContext } from './types';
import type { SimRepo } from './lib/simulation';
import { useRunStream } from './hooks/useRunStream';
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
  const hasFailures = run.counts.failed > 0;

  // Optionaler Demo-Autostart (?autostart) — einmalig, fuer Screenshots/Praesentation.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (new URLSearchParams(window.location.search).has('autostart')) run.start();
  }, [run]);

  return (
    <div className="min-h-full text-zinc-800">
      <AppHeader context={CONTEXT} phase={run.phase} hasFailures={hasFailures} onStart={run.start} />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="space-y-5">
            <ProcessFlow repos={run.repos} active={run.phase === 'running'} />
            <StatCluster
              counts={run.counts}
              finished={run.finished}
              total={run.total}
              elapsedMs={run.elapsedMs}
            />
          </div>

          <div className="space-y-5">
            {run.phase === 'done' && run.totalDurationMs !== null ? (
              <SummaryBanner counts={run.counts} totalDurationMs={run.totalDurationMs} />
            ) : null}
            <RepoTable repos={run.repos} />
            <LogPanel lines={run.log} />
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-zinc-400">
          GitBulk · Design-Prototyp (React + Tailwind) · lokal, simulierter Lauf
        </p>
      </main>
    </div>
  );
}

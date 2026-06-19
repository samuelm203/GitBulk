import { Download, Loader2, Moon, Play, RotateCcw, Sun } from 'lucide-react';

import type { RunContext, RunPhase } from '../types';
import type { Theme } from '../hooks/useTheme';
import { Badge } from './Badge';
import { StatusDot } from './StatusDot';

interface AppHeaderProps {
  context: RunContext;
  phase: RunPhase;
  hasFailures: boolean;
  theme: Theme;
  canExport: boolean;
  onStart: () => void;
  onToggleTheme: () => void;
  onExport: () => void;
}

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'Bereit',
  running: 'Läuft',
  done: 'Fertig',
};

/** Sticky-Kopfzeile: Wortmarke, Kontext-Chips, Status, Aktionen. */
export function AppHeader({
  context,
  phase,
  hasFailures,
  theme,
  canExport,
  onStart,
  onToggleTheme,
  onExport,
}: AppHeaderProps) {
  const running = phase === 'running';
  const startLabel = running ? 'Läuft…' : phase === 'done' ? 'Erneut' : 'Start';

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
        <h1 className="text-[17px] font-semibold tracking-tight text-ink">
          Git<span className="text-brand">Bulk</span>
        </h1>

        <div className="hidden items-center gap-2 sm:flex">
          <Badge>{context.platform}</Badge>
          <Badge>concurrency {context.concurrency}</Badge>
          <Badge>
            {context.ticket}-{context.branch}
          </Badge>
          {context.dryRun ? <Badge tone="warn">DRY-RUN</Badge> : null}
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="flex items-center gap-2 text-sm text-ink-muted" aria-live="polite">
            <StatusDot phase={phase} hasFailures={hasFailures} />
            <span className="hidden sm:inline">{PHASE_LABEL[phase]}</span>
          </span>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}
            title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={onExport}
            disabled={!canExport}
            title={canExport ? 'Lauf-Report als JSON' : 'Report nach Abschluss verfügbar'}
            className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Report</span>
          </button>

          <button
            type="button"
            onClick={onStart}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default disabled:opacity-60"
          >
            {running ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : phase === 'done' ? (
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {startLabel}
          </button>
        </div>
      </div>
    </header>
  );
}

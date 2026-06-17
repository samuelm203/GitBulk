import { Loader2, Play, RotateCcw } from 'lucide-react';

import type { RunContext, RunPhase } from '../types';
import { Badge } from './Badge';
import { StatusDot } from './StatusDot';

interface AppHeaderProps {
  context: RunContext;
  phase: RunPhase;
  hasFailures: boolean;
  onStart: () => void;
}

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'Bereit',
  running: 'Läuft',
  done: 'Fertig',
};

/** Sticky-Kopfzeile: Wortmarke, Kontext-Chips, Live-Status, Start-Button. */
export function AppHeader({ context, phase, hasFailures, onStart }: AppHeaderProps) {
  const running = phase === 'running';
  const buttonLabel = running ? 'Läuft…' : phase === 'done' ? 'Erneut' : 'Start';

  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
        <h1 className="text-[17px] font-semibold tracking-tight text-zinc-900">
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

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-zinc-500" aria-live="polite">
            <StatusDot phase={phase} hasFailures={hasFailures} />
            {PHASE_LABEL[phase]}
          </span>
          <button
            type="button"
            onClick={onStart}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default disabled:bg-zinc-300"
          >
            {running ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : phase === 'done' ? (
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {buttonLabel}
          </button>
        </div>
      </div>
    </header>
  );
}

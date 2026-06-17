import type { RunPhase } from '../types';

interface StatusDotProps {
  phase: RunPhase;
  hasFailures: boolean;
}

/** 8px-Statuspunkt: neutral → blau pulsierend → grün/rot. */
export function StatusDot({ phase, hasFailures }: StatusDotProps) {
  const tone =
    phase === 'running'
      ? 'bg-brand motion-safe:animate-pulse'
      : phase === 'done'
        ? hasFailures
          ? 'bg-red-500'
          : 'bg-emerald-500'
        : 'bg-zinc-300';
  return <span className={`inline-block h-2 w-2 rounded-full ${tone}`} aria-hidden="true" />;
}

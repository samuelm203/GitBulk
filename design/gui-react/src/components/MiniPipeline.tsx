import { Check, Loader2, Minus, X } from 'lucide-react';

import type { RepoState, StepKey, StepState } from '../types';

const STEPS: ReadonlyArray<{ readonly key: StepKey; readonly label: string }> = [
  { key: 'repo', label: 'Repo' },
  { key: 'change', label: 'Anpassen' },
  { key: 'pr', label: 'PR' },
];

/** Leitet die drei Stufen-Zustaende aus dem RU-Status + der Phase ab. */
function stepStates(repo: RepoState): Record<StepKey, StepState> {
  switch (repo.status) {
    case 'pending':
      return { repo: 'idle', change: 'idle', pr: 'idle' };
    case 'running':
      return repo.stage === 'pr'
        ? { repo: 'done', change: 'done', pr: 'active' }
        : { repo: 'done', change: 'active', pr: 'idle' };
    case 'done':
      return { repo: 'done', change: 'done', pr: 'done' };
    case 'skipped':
      return { repo: 'skipped', change: 'skipped', pr: 'skipped' };
    case 'failed':
      return { repo: 'done', change: 'done', pr: 'failed' };
  }
}

const CHIP: Record<StepState, string> = {
  idle: 'border-line text-ink-faint',
  active: 'border-brand text-brand',
  done: 'border-ok/40 text-ok',
  failed: 'border-err/40 text-err',
  skipped: 'border-warn/40 text-warn',
};

function StepIcon({ state }: { state: StepState }) {
  const cls = 'h-3 w-3 shrink-0';
  switch (state) {
    case 'done':
      return <Check className={cls} aria-hidden="true" />;
    case 'failed':
      return <X className={cls} aria-hidden="true" />;
    case 'skipped':
      return <Minus className={cls} aria-hidden="true" />;
    case 'active':
      return <Loader2 className={`${cls} motion-safe:animate-spin`} aria-hidden="true" />;
    case 'idle':
      return <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />;
  }
}

/** Kompakte Drei-Stufen-Pipeline (Repo ▸ Anpassen ▸ PR) pro RU. */
export function MiniPipeline({ repo }: { repo: RepoState }) {
  const states = stepStates(repo);
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Pipeline">
      {STEPS.map((step, index) => (
        <li key={step.key} className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${CHIP[states[step.key]]}`}
          >
            <StepIcon state={states[step.key]} />
            <span className="text-ink-muted">{step.label}</span>
          </span>
          {index < STEPS.length - 1 ? (
            <span className="text-ink-faint" aria-hidden="true">
              ›
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

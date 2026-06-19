import { Database, FilePen, GitPullRequestArrow, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { RepoState, RuStage } from '../types';

interface ProcessFlowProps {
  repos: readonly RepoState[];
  active: boolean;
}

interface FlowStep {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: LucideIcon;
  readonly stage: RuStage;
}

const STEPS: readonly FlowStep[] = [
  { key: 'repo', label: 'Repository', sub: 'klonen / aktualisieren', icon: Database, stage: 'git' },
  { key: 'change', label: 'Anpassen', sub: 'Skript / Operationen', icon: FilePen, stage: 'git' },
  { key: 'pr', label: 'Pull Request', sub: 'erstellen / aktualisieren', icon: GitPullRequestArrow, stage: 'pr' },
];

/** Welche Phasen sind ueber alle laufenden RUs gerade aktiv? */
function activeStages(repos: readonly RepoState[]): Record<RuStage, boolean> {
  const stages: Record<RuStage, boolean> = { git: false, pr: false };
  for (const repo of repos) {
    if (repo.status === 'running' && repo.stage !== null) stages[repo.stage] = true;
  }
  return stages;
}

/** Der vertikale Drei-Stufen-Prozess (das Mockup), aggregiert ueber alle RUs. */
export function ProcessFlow({ repos, active }: ProcessFlowProps) {
  const stages = activeStages(repos);
  return (
    <section className="rounded-lg border border-line bg-surface" aria-labelledby="flow-heading">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 id="flow-heading" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Prozess
        </h2>
      </div>
      <div className="px-4 py-5 sm:px-5">
        <ol className="space-y-2">
          {STEPS.map((step, index) => {
            const isActive = active && stages[step.stage];
            const Icon = step.icon;
            return (
              <li key={step.key}>
                <div
                  className={`flex items-center gap-3 rounded-lg border px-3 py-3 transition-colors ${
                    isActive ? 'border-brand bg-brand/5' : 'border-line bg-surface'
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${
                      isActive ? 'bg-brand text-white' : 'bg-line-soft text-ink-muted'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-sm font-medium ${isActive ? 'text-brand' : 'text-ink'}`}>
                      {step.label}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">{step.sub}</span>
                  </span>
                </div>
                {index < STEPS.length - 1 ? (
                  <div className="ml-[2.05rem] h-2 w-px bg-line" aria-hidden="true" />
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 flex items-center gap-1.5 pl-1 text-xs text-ink-faint">
          <RotateCcw className={`h-3.5 w-3.5 ${active ? 'text-brand' : ''}`} aria-hidden="true" />
          pro Repository wiederholt
        </p>
      </div>
    </section>
  );
}

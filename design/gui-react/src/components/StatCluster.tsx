import type { Counts } from '../types';
import { formatClock } from '../lib/format';

interface StatClusterProps {
  counts: Counts;
  finished: number;
  total: number;
  elapsedMs: number;
}

interface Stat {
  readonly label: string;
  readonly value: number;
  readonly tone: string;
}

/** Vier ueberschneidungsfreie Zaehler + Fortschrittsbalken + Laufzeit. */
export function StatCluster({ counts, finished, total, elapsedMs }: StatClusterProps) {
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  const stats: readonly Stat[] = [
    { label: 'Neu', value: counts.created, tone: 'text-emerald-600' },
    { label: 'Aktualisiert', value: counts.updated, tone: 'text-brand' },
    { label: 'Fehlgeschlagen', value: counts.failed, tone: 'text-red-600' },
    { label: 'Übersprungen', value: counts.skipped, tone: 'text-amber-600' },
  ];
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5" aria-label="Statistik">
      <div className="grid grid-cols-2 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md border border-zinc-100 bg-zinc-50/60 px-3 py-2.5">
            <div className={`text-2xl font-semibold tabular-nums ${stat.tone}`}>{stat.value}</div>
            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {stat.label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span className="tabular-nums">
            {finished} / {total} abgeschlossen
          </span>
          <span className="tabular-nums">{formatClock(elapsedMs)}</span>
        </div>
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Fortschritt"
        >
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </section>
  );
}

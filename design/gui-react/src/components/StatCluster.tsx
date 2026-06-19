import type { Counts } from '../types';
import type { StatusFilter } from '../lib/filter';
import { formatClock } from '../lib/format';

interface StatClusterProps {
  counts: Counts;
  finished: number;
  total: number;
  elapsedMs: number;
  activeFilter: StatusFilter;
  onFilter: (category: Exclude<StatusFilter, 'all'>) => void;
}

interface StatTile {
  readonly key: Exclude<StatusFilter, 'all'>;
  readonly label: string;
  readonly tone: string;
}

const TILES: readonly StatTile[] = [
  { key: 'created', label: 'Neu', tone: 'text-ok' },
  { key: 'updated', label: 'Aktualisiert', tone: 'text-brand' },
  { key: 'failed', label: 'Fehlgeschlagen', tone: 'text-err' },
  { key: 'skipped', label: 'Übersprungen', tone: 'text-warn' },
];

/**
 * Vier ueberschneidungsfreie Zaehler (zugleich Status-Filter) plus
 * Fortschrittsbalken und Laufzeit. Ein Klick auf eine Kachel filtert die
 * RU-Tabelle; erneuter Klick hebt den Filter wieder auf.
 */
export function StatCluster({ counts, finished, total, elapsedMs, activeFilter, onFilter }: StatClusterProps) {
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  return (
    <section className="rounded-lg border border-line bg-surface p-4 sm:p-5" aria-label="Statistik und Filter">
      <div className="grid grid-cols-2 gap-3">
        {TILES.map((tile) => {
          const isActive = activeFilter === tile.key;
          return (
            <button
              key={tile.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onFilter(tile.key)}
              title={isActive ? 'Filter aufheben' : `Nur „${tile.label}" anzeigen`}
              className={`rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                isActive ? 'border-brand bg-brand/5' : 'border-line-soft bg-surface-2 hover:border-line'
              }`}
            >
              <div className={`text-2xl font-semibold tabular-nums ${tile.tone}`}>{counts[tile.key]}</div>
              <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {tile.label}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span className="tabular-nums">
            {finished} / {total} abgeschlossen
          </span>
          <span className="tabular-nums">{formatClock(elapsedMs)}</span>
        </div>
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line-soft"
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

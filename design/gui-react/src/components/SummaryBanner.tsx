import { AlertCircle, CheckCircle2 } from 'lucide-react';

import type { Counts } from '../types';
import { formatClock } from '../lib/format';

interface SummaryBannerProps {
  counts: Counts;
  totalDurationMs: number;
}

/** Abschluss-Banner; Akzent links, grün bei sauberem Lauf, rot bei Fehlern. */
export function SummaryBanner({ counts, totalDurationMs }: SummaryBannerProps) {
  const hasFailures = counts.failed > 0;
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border border-l-4 px-4 py-3 ${
        hasFailures ? 'border-red-100 border-l-red-500 bg-red-50' : 'border-emerald-100 border-l-emerald-500 bg-emerald-50'
      }`}
    >
      {hasFailures ? (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
      )}
      <p className="text-sm text-zinc-700">
        <span className="font-medium text-zinc-900">Lauf beendet</span> · {counts.created} neu,{' '}
        {counts.updated} aktualisiert, {counts.skipped} übersprungen, {counts.failed} fehlgeschlagen
        <span className="text-zinc-500"> · {formatClock(totalDurationMs)}</span>
      </p>
    </div>
  );
}

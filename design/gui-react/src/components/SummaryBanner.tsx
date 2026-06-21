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
        hasFailures ? 'border-err/30 border-l-err bg-err/10' : 'border-ok/30 border-l-ok bg-ok/10'
      }`}
    >
      {hasFailures ? (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-err" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
      )}
      <p className="text-sm text-ink-muted">
        <span className="font-medium text-ink">Lauf beendet</span> · {counts.created} neu,{' '}
        {counts.updated} aktualisiert, {counts.skipped} übersprungen, {counts.failed} fehlgeschlagen
        <span className="text-ink-faint"> · {formatClock(totalDurationMs)}</span>
      </p>
    </div>
  );
}

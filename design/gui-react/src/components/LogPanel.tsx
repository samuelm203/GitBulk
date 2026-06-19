import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';

import type { LogLevel, LogLine } from '../types';

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
  warn: 'text-warn',
  error: 'text-err',
};

/** Einklappbares Live-Protokoll; Auto-Scroll nur, wenn man unten ist. */
export function LogPanel({ lines }: { lines: readonly LogLine[] }) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface" aria-labelledby="log-heading">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 border-b border-line px-4 py-3 text-left sm:px-6"
        aria-expanded={open}
      >
        <Terminal className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
        <h2 id="log-heading" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Protokoll
        </h2>
        <span className="text-[11px] tabular-nums text-ink-faint">{lines.length}</span>
        <ChevronDown
          className={`ml-auto h-4 w-4 text-ink-faint transition-transform ${open ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed sm:px-6"
          aria-live="polite"
        >
          {lines.length === 0 ? (
            <p className="text-ink-faint">Noch keine Ausgaben — Lauf starten.</p>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={LEVEL_TONE[line.level]}>
                <span className="select-none text-ink-faint">{line.level.toUpperCase().padEnd(6)}</span>
                {line.text}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

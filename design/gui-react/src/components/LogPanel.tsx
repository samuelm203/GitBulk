import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';

import type { LogLevel, LogLine } from '../types';

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-zinc-400',
  info: 'text-zinc-600',
  warn: 'text-amber-600',
  error: 'text-red-600',
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
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white" aria-labelledby="log-heading">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 border-b border-zinc-200 px-4 py-3 text-left sm:px-6"
        aria-expanded={open}
      >
        <Terminal className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
        <h2 id="log-heading" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Protokoll
        </h2>
        <span className="text-[11px] tabular-nums text-zinc-400">{lines.length}</span>
        <ChevronDown
          className={`ml-auto h-4 w-4 text-zinc-400 transition-transform ${open ? '' : '-rotate-90'}`}
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
            <p className="text-zinc-400">Noch keine Ausgaben — Lauf starten.</p>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={LEVEL_TONE[line.level]}>
                <span className="select-none text-zinc-300">{line.level.toUpperCase().padEnd(6)}</span>
                {line.text}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

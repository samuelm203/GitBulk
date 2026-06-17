import type { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  tone?: 'default' | 'warn';
}

const TONES: Record<NonNullable<BadgeProps['tone']>, string> = {
  default: 'border-zinc-200 bg-white text-zinc-500',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
};

/** Ruhiger Kontext-Chip im Header (Plattform, Concurrency, Ticket …). */
export function Badge({ children, tone = 'default' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

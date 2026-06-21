/**
 * Gemeinsame Typen des GitBulk-Dashboards.
 *
 * Die `StreamEvent`-Union bildet exakt die SSE-Events des echten GitBulk-
 * Servers nach (`started` | `log` | `progress` | `summary`). Dadurch ist der
 * Tausch "Simulation → echtes EventSource" ein reiner Daten-Quellen-Wechsel,
 * ohne die Reduktion in `useRunStream` anzufassen.
 */

export type RuStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type RuStage = 'git' | 'pr';
export type StepKey = 'repo' | 'change' | 'pr';
export type StepState = 'idle' | 'active' | 'done' | 'failed' | 'skipped';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RunPhase = 'idle' | 'running' | 'done';

/** Laufzeit-Zustand einer einzelnen Repository-Unit (RU). */
export interface RepoState {
  readonly name: string;
  status: RuStatus;
  /** Aktuelle Phase, solange `status === 'running'`, sonst `null`. */
  stage: RuStage | null;
  durationMs: number | null;
  prId: number | null;
  prUrl: string | null;
  prUpdated: boolean;
  error: string | null;
  note: string | null;
}

export interface LogLine {
  readonly id: number;
  readonly level: LogLevel;
  readonly text: string;
}

/** Aggregierte, ueberschneidungsfreie Zaehler (neu ≠ aktualisiert). */
export interface Counts {
  readonly created: number;
  readonly updated: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Unkritischer Lauf-Kontext fuer den Header (keine Secrets). */
export interface RunContext {
  readonly platform: string;
  readonly ticket: string;
  readonly branch: string;
  readonly concurrency: number;
  readonly dryRun: boolean;
}

/** Ein Stream-Event — deckungsgleich mit den GitBulk-SSE-Events. */
export type StreamEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'log'; readonly level: LogLevel; readonly text: string }
  | {
      readonly kind: 'progress';
      readonly ru: string;
      readonly status: 'running';
      readonly stage: RuStage;
    }
  | {
      readonly kind: 'progress';
      readonly ru: string;
      readonly status: 'done' | 'failed' | 'skipped';
      readonly durationMs: number;
      readonly prId?: number;
      readonly prUrl?: string;
      readonly prUpdated?: boolean;
      readonly error?: string;
      readonly note?: string;
    }
  | { readonly kind: 'summary'; readonly totalDurationMs: number };

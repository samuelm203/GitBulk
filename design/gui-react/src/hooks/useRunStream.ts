/**
 * `useRunStream` — kapselt den kompletten Lauf-Zustand.
 *
 * Konsumiert einen `StreamEvent`-Strom (hier aus der Simulation) und reduziert
 * ihn zu UI-Zustand: Phase, RU-Liste, ueberschneidungsfreie Zaehler, Log und
 * Laufzeit. Der Reducer ist quellenneutral — fuer den Produktivbetrieb wuerde
 * man die Simulation durch ein `EventSource('/events')` ersetzen und dessen
 * Events unveraendert hineingeben.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Counts, LogLine, RepoState, RunContext, RunPhase, StreamEvent } from '../types';
import { simulateRun, type AbortFlag, type SimRepo } from '../lib/simulation';

interface RunState {
  phase: RunPhase;
  repos: RepoState[];
  log: LogLine[];
  totalDurationMs: number | null;
}

type Action = { type: 'reset'; names: readonly string[] } | { type: 'event'; event: StreamEvent };

function initialRepos(names: readonly string[]): RepoState[] {
  return names.map((name) => ({
    name,
    status: 'pending',
    stage: null,
    durationMs: null,
    prId: null,
    prUrl: null,
    prUpdated: false,
    error: null,
    note: null,
  }));
}

function applyEvent(state: RunState, event: StreamEvent): RunState {
  switch (event.kind) {
    case 'started':
      return { ...state, phase: 'running' };
    case 'log':
      return {
        ...state,
        log: [...state.log, { id: state.log.length, level: event.level, text: event.text }],
      };
    case 'summary':
      return { ...state, phase: 'done', totalDurationMs: event.totalDurationMs };
    case 'progress': {
      const repos = state.repos.map((repo): RepoState => {
        if (repo.name !== event.ru) return repo;
        if (event.status === 'running') {
          return { ...repo, status: 'running', stage: event.stage };
        }
        return {
          ...repo,
          status: event.status,
          stage: null,
          durationMs: event.durationMs,
          prId: event.prId ?? null,
          prUrl: event.prUrl ?? null,
          prUpdated: event.prUpdated ?? false,
          error: event.error ?? null,
          note: event.note ?? null,
        };
      });
      return { ...state, repos };
    }
    default:
      return state;
  }
}

function reducer(state: RunState, action: Action): RunState {
  if (action.type === 'reset') {
    return { phase: 'idle', repos: initialRepos(action.names), log: [], totalDurationMs: null };
  }
  return applyEvent(state, action.event);
}

function deriveCounts(repos: readonly RepoState[]): Counts {
  let created = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const repo of repos) {
    if (repo.status === 'done') {
      if (repo.prUpdated) updated += 1;
      else created += 1;
    } else if (repo.status === 'failed') {
      failed += 1;
    } else if (repo.status === 'skipped') {
      skipped += 1;
    }
  }
  return { created, updated, failed, skipped };
}

function isFinished(status: RepoState['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped';
}

export interface RunStream {
  readonly phase: RunPhase;
  readonly repos: readonly RepoState[];
  readonly counts: Counts;
  readonly log: readonly LogLine[];
  readonly elapsedMs: number;
  readonly totalDurationMs: number | null;
  readonly finished: number;
  readonly total: number;
  readonly start: () => void;
}

export function useRunStream(context: RunContext, repoPlan: readonly SimRepo[]): RunStream {
  const [state, dispatch] = useReducer(reducer, repoPlan, (plan) => ({
    phase: 'idle' as const,
    repos: initialRepos(plan.map((repo) => repo.name)),
    log: [],
    totalDurationMs: null,
  }));

  const [elapsedMs, setElapsedMs] = useState(0);
  const flagRef = useRef<AbortFlag>({ aborted: false });
  const startTimeRef = useRef(0);

  const start = useCallback(() => {
    // Eventuellen Vorlauf kooperativ stoppen, dann frisch beginnen.
    flagRef.current.aborted = true;
    const flag: AbortFlag = { aborted: false };
    flagRef.current = flag;
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    dispatch({ type: 'reset', names: repoPlan.map((repo) => repo.name) });
    void simulateRun(repoPlan, context.concurrency, (event) => dispatch({ type: 'event', event }), flag);
  }, [repoPlan, context.concurrency]);

  // Laufzeit-Timer — nur waehrend `running`, friert danach am Endwert ein.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const id = window.setInterval(() => setElapsedMs(Date.now() - startTimeRef.current), 200);
    return () => window.clearInterval(id);
  }, [state.phase]);

  // Beim Unmount jeden laufenden Stream stoppen.
  useEffect(() => () => {
    flagRef.current.aborted = true;
  }, []);

  const counts = useMemo(() => deriveCounts(state.repos), [state.repos]);
  const finished = useMemo(() => state.repos.filter((repo) => isFinished(repo.status)).length, [state.repos]);

  return {
    phase: state.phase,
    repos: state.repos,
    counts,
    log: state.log,
    elapsedMs,
    totalDurationMs: state.totalDurationMs,
    finished,
    total: state.repos.length,
    start,
  };
}

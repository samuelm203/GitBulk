/**
 * Lauf-Simulation fuer den Design-Prototyp.
 *
 * Erzeugt denselben Event-Strom wie der echte GitBulk-Server (siehe
 * `StreamEvent`), nur ohne Backend. Respektiert die Concurrency (mehrere RUs
 * "gleichzeitig") und liefert eine realistische Mischung aus Ergebnissen.
 *
 * Produktiv ersetzt man `simulateRun(...)` durch ein `EventSource('/events')`
 * und mappt dessen Events auf `StreamEvent` — die Reduktion bleibt identisch.
 */

import type { LogLevel, StreamEvent } from '../types';

export type SimOutcome = 'created' | 'updated' | 'failed' | 'skipped';

export interface SimRepo {
  readonly name: string;
  readonly outcome: SimOutcome;
}

/** Veraenderbares Abbruch-Flag (kooperativer Stopp bei Neustart/Unmount). */
export interface AbortFlag {
  aborted: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

async function processOne(
  repo: SimRepo,
  emit: (event: StreamEvent) => void,
  flag: AbortFlag,
): Promise<void> {
  const startedAt = Date.now();
  const log = (level: LogLevel, text: string): void => emit({ kind: 'log', level, text });

  // Phase 3a: Repo vorbereiten + Code-Change
  emit({ kind: 'progress', ru: repo.name, status: 'running', stage: 'git' });
  log('info', `[${repo.name}] Starting processing`);
  await sleep(rand(550, 1250));
  if (flag.aborted) return;
  log('debug', `[${repo.name}] git fetch origin --prune`);
  log('debug', `[${repo.name}] checkout -B feature branch`);

  if (repo.outcome === 'skipped') {
    log('info', `[${repo.name}] No diff after code change — No PR [dev]`);
    emit({
      kind: 'progress',
      ru: repo.name,
      status: 'skipped',
      durationMs: Date.now() - startedAt,
      note: 'Keine Änderung nach Code-Change',
    });
    return;
  }

  // Phase 4: Pull Request
  emit({ kind: 'progress', ru: repo.name, status: 'running', stage: 'pr' });
  log('debug', `[${repo.name}] push origin (Versuch 1)`);
  await sleep(rand(420, 950));
  if (flag.aborted) return;

  if (repo.outcome === 'failed') {
    log('error', `[${repo.name}] PR failed [API] — HTTP 401 unauthorized`);
    emit({
      kind: 'progress',
      ru: repo.name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: 'HTTP 401: unauthorized',
    });
    return;
  }

  const prId = rand(100, 990);
  const updated = repo.outcome === 'updated';
  log('info', `[${repo.name}] PR ${updated ? 'updated' : 'successful'} (#${prId})`);
  emit({
    kind: 'progress',
    ru: repo.name,
    status: 'done',
    durationMs: Date.now() - startedAt,
    prId,
    prUrl: `https://bitbucket.org/acme/${repo.name}/pull-requests/${prId}`,
    prUpdated: updated,
  });
}

/**
 * Spielt einen kompletten Lauf ab und meldet jeden Schritt via `emit`.
 * Bricht kooperativ ab, sobald `flag.aborted` gesetzt ist.
 */
export async function simulateRun(
  repos: readonly SimRepo[],
  concurrency: number,
  emit: (event: StreamEvent) => void,
  flag: AbortFlag,
): Promise<void> {
  const startedAt = Date.now();
  emit({ kind: 'started' });
  emit({
    kind: 'log',
    level: 'info',
    text: `Starting GitBulk run: ${repos.length} RUs, platform=bitbucket, concurrency=${concurrency}`,
  });

  // Worker-Pool: `concurrency` Lanes ziehen RUs aus einer gemeinsamen Queue.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!flag.aborted) {
      const index = cursor;
      cursor += 1;
      const repo = repos[index];
      if (!repo) return;
      await processOne(repo, emit, flag);
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, repos.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  if (flag.aborted) return;

  const totalDurationMs = Date.now() - startedAt;
  emit({ kind: 'log', level: 'info', text: `Run complete in ${totalDurationMs}ms` });
  emit({ kind: 'summary', totalDurationMs });
}

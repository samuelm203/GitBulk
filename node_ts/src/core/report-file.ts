/**
 * Maschinenlesbarer Lauf-Report (`--report out.json`).
 *
 * Schreibt nach einem Bulk-Lauf einen JSON-Report für CI-Pipelines: pro RU das
 * Outcome inkl. PR-Link/Fehler, dazu Totals und Lauf-Metadaten. Das Format ist
 * über `reportVersion` versioniert, damit CI-Consumer und `--retry-failed`
 * spätere Änderungen erkennen können.
 *
 * Sicherheit: Der Report enthält NIEMALS Tokens — nur Daten aus der Summary
 * und unkritische Config-Felder (Plattform, Ticket, Branch).
 */

import { writeFileSync } from 'node:fs';

import type { GitBulkConfig } from '../config/schema.js';
import type { RuResult, RunSummary } from './runner.js';
import { VERSION } from '../index.js';

/** Aktuelle Format-Version des Reports. */
export const REPORT_VERSION = 1;

/** Ein RU-Eintrag im Report (flach, CI-freundlich). */
export interface RunReportEntry {
  ru: string;
  outcome: RuResult['outcome'];
  durationMs: number;
  prId?: string | number;
  prUrl?: string;
  prUpdated?: boolean;
  error?: string;
  notes: string[];
}

/** Wurzel-Objekt des JSON-Reports. */
export interface RunReport {
  reportVersion: number;
  gitbulkVersion: string;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  dryRun: boolean;
  prPlatform: GitBulkConfig['prPlatform'];
  ticket: string;
  branch: string;
  sourceBranch: string;
  exitCode: number;
  totals: RunSummary['totals'];
  results: RunReportEntry[];
}

/**
 * Baut den Report aus Config + Summary. `exitCode` ist der Code, den der
 * Aufrufer zurückgeben wird (inkl. 130 bei Abbruch) — so kann CI den Lauf
 * allein aus der Datei bewerten.
 */
export function buildRunReport(
  config: GitBulkConfig,
  summary: RunSummary,
  exitCode: number,
): RunReport {
  const results: RunReportEntry[] = summary.results.map((r) => {
    const entry: RunReportEntry = {
      ru: r.ru,
      outcome: r.outcome,
      durationMs: r.durationMs,
      notes: [...r.phase3.notes, ...r.phase4.notes],
    };
    if (r.phase4.prId !== undefined) entry.prId = r.phase4.prId;
    if (r.phase4.prUrl !== undefined) entry.prUrl = r.phase4.prUrl;
    if (r.phase4.prUpdated) entry.prUpdated = true;
    const error = r.phase4.error ?? r.phase3.fatalError;
    if (error !== undefined) entry.error = error;
    return entry;
  });

  return {
    reportVersion: REPORT_VERSION,
    gitbulkVersion: VERSION,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    totalDurationMs: summary.totalDurationMs,
    dryRun: config.dryRun,
    prPlatform: config.prPlatform,
    ticket: config.ticket,
    branch: config.branch,
    sourceBranch: config.sourceBranch,
    exitCode,
    totals: summary.totals,
    results,
  };
}

/** Schreibt den Report als pretty-printed JSON (mit abschließendem Newline). */
export function writeRunReport(path: string, report: RunReport): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/**
 * Validierungs-Funktionen für Benutzereingaben und Config-Werte.
 *
 * Wird sowohl von den interaktiven Prompts (`src/cli/prompts.ts`)
 * als auch vom Config-Loader (`src/config/loader.ts`) genutzt — beide
 * Modi müssen exakt dieselben Validierungsregeln anwenden, damit
 * eine YAML-/JSON-Config äquivalent zum interaktiven Eingabepfad ist.
 *
 * Die Regeln spiegeln die "Is X valid?"-Rauten des Flowcharts wider.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Ergebnis einer Validierung.
 * Bei Erfolg enthält `value` den normalisierten Wert (z. B. getrimmt),
 * bei Fehler enthält `error` die Meldung, die laut Flowchart angezeigt wird.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Validiert die RU-Liste (Flowchart: `Is [config.rus] empty?`).
 *
 * - Erwartet komma-separierte Strings ODER bereits ein Array.
 * - Whitespace wird gestrippt, leere Einträge entfernt.
 * - Resultat darf nicht leer sein.
 *
 * @param input - Roh-Eingabe (String aus Prompt oder Array aus Config)
 * @returns Bereinigtes Array der RU-Namen
 */
export function validateRuList(input: string | readonly string[]): ValidationResult<string[]> {
  const raw: readonly string[] = typeof input === 'string' ? input.split(',') : input;
  const cleaned = raw.map((s) => String(s).trim()).filter((s) => s.length > 0);

  if (cleaned.length === 0) {
    return { ok: false, error: 'Error: RU list is missing' };
  }

  return { ok: true, value: cleaned };
}

/**
 * Git-Branch-Name-Regeln (vereinfachte Umsetzung der `git check-ref-format`-Spec).
 *
 * Erlaubt: Buchstaben, Zahlen, `-`, `_`, `/`, `.`
 * Verboten u. a.: führende/schließende `/`, `..`, Leerzeichen, `~^:?*[\`
 * Maximale Länge: 255 Zeichen (Konvention).
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$|^[A-Za-z0-9]$/;
const BRANCH_FORBIDDEN_SEQUENCES = ['..', '@{', '//', '.lock'];

/**
 * Ersetzt im Branch-Namen Sonderzeichen, die git nicht erlaubt
 * (Flowchart: `Replace special characters [input_branch]`).
 *
 * - Whitespace → `-`
 * - Mehrfache `-` → ein `-`
 * - Verbotene Zeichen (`~^:?*[\`) werden entfernt
 *
 * @param input - Roh-Branchname
 * @returns Sanitisierter Branchname
 */
export function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\\]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validiert einen Branch-Namen (Flowchart: `Is branch name valid?`).
 *
 * @param input - Roh-Eingabe
 * @returns Validierter und sanitisierter Branch-Name
 */
export function validateBranchName(input: string): ValidationResult<string> {
  const sanitized = sanitizeBranchName(input);

  if (sanitized.length === 0 || sanitized.length > 255) {
    return { ok: false, error: 'Error: Invalid branch name' };
  }
  if (!BRANCH_NAME_PATTERN.test(sanitized)) {
    return { ok: false, error: 'Error: Invalid branch name' };
  }
  for (const seq of BRANCH_FORBIDDEN_SEQUENCES) {
    if (sanitized.includes(seq)) {
      return { ok: false, error: 'Error: Invalid branch name' };
    }
  }

  return { ok: true, value: sanitized };
}

/**
 * Validiert einen Ticket-Identifier (z. B. `AKB-1234`).
 *
 * Erlaubt: Buchstaben, Zahlen und Bindestriche.
 * Wird im Branch-Namen vorangestellt: `[ticket]-[branchName]`.
 *
 * @param input - Roh-Eingabe
 */
export function validateTicket(input: string): ValidationResult<string> {
  const trimmed = input.trim().toUpperCase();

  if (trimmed.length === 0) {
    return { ok: false, error: 'Error: Ticket is missing' };
  }
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(trimmed)) {
    return { ok: false, error: 'Error: Invalid ticket format' };
  }

  return { ok: true, value: trimmed };
}

/**
 * Validiert einen Pfad zu einer existierenden Datei
 * (Flowchart: `Print 'Error: File not found!'`).
 *
 * @param input - Pfad, absolut oder relativ zum CWD
 * @returns Absoluter Pfad bei Erfolg
 */
export function validateFilePath(input: string): ValidationResult<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Error: File path is missing' };
  }

  const absolute = resolve(trimmed);
  if (!existsSync(absolute)) {
    return { ok: false, error: 'Error: File not found!' };
  }

  try {
    if (!statSync(absolute).isFile()) {
      return { ok: false, error: 'Error: Path is not a file' };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Error: Could not access file (${(err as Error).message})`,
    };
  }

  return { ok: true, value: absolute };
}

/**
 * Validiert eine nicht-leere Commit-Message (Flowchart: `Is msg empty?`).
 */
export function validateMessage(input: string): ValidationResult<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Error: Message is empty' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validiert ein Y/N-Flag (Flowchart: `Is [userInput] Y or N?`).
 *
 * @returns `true` für Y/Yes, `false` für N/No
 */
export function validateYesNo(input: string): ValidationResult<boolean> {
  const normalized = input.trim().toUpperCase();
  if (normalized === 'Y' || normalized === 'YES') {
    return { ok: true, value: true };
  }
  if (normalized === 'N' || normalized === 'NO') {
    return { ok: true, value: false };
  }
  return { ok: false, error: 'Error: Only Y or N allowed' };
}

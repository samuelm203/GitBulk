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
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Erlaubtes Muster für einen RU-Namen.
 *
 * Sicherheit: Ein RU-Name wird sowohl als Verzeichnis-Segment
 * (`join(workspaceDir, ru)`) als auch als URL-Segment (`cloneBaseUrl/ru`) und
 * als `git clone`-Argument verwendet. Wir erlauben daher nur ein einzelnes,
 * harmloses Segment: beginnt alphanumerisch (kein führendes `-`, das git als
 * Option fehldeuten könnte; kein `.`/`..`), danach nur Buchstaben, Ziffern,
 * `.`, `_`, `-`. Das schließt Pfad-Separatoren (`/`, `\`), `..`-Traversal,
 * Whitespace und Steuerzeichen aus.
 */
const RU_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validiert die RU-Liste (Flowchart: `Is [config.rus] empty?`).
 *
 * - Erwartet komma-separierte Strings ODER bereits ein Array.
 * - Whitespace wird gestrippt, leere Einträge entfernt.
 * - Resultat darf nicht leer sein.
 * - Jeder Name muss `RU_NAME_PATTERN` erfüllen (Path-Traversal-/Injection-Schutz).
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

  for (const name of cleaned) {
    if (!RU_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `Error: invalid RU name "${name}" — allowed: letters, digits, '.', '_', '-' (must start alphanumeric; no '/', '\\' or '..')`,
      };
    }
  }

  return { ok: true, value: cleaned };
}

/**
 * Eine Repository-Unit mit optionalem Workspace-Override.
 *
 * `repo` ist der Repo-Slug (wie bisher), `workspace` überschreibt — wenn
 * gesetzt — den globalen `bitbucket.workspace` (bzw. GitHub-`owner`) für genau
 * diese RU. So lassen sich RUs aus mehreren Workspaces in EINEM Lauf
 * verarbeiten. Fehlt `workspace`, gilt der globale Default.
 */
export interface RuSpec {
  repo: string;
  workspace?: string;
}

/** Roh-Eingabeform für die RU-Liste (String, Namen-Array oder strukturierte Einträge). */
export type RuSpecInput = string | ReadonlyArray<string | { repo?: unknown; workspace?: unknown }>;

/**
 * Validiert und normalisiert die RU-Liste zu `RuSpec[]` — akzeptiert sowohl
 * reine Namen (rückwärtskompatibel) als auch `{ repo, workspace }`-Objekte.
 *
 * Der `workspace` wird mit demselben strengen Muster wie ein RU-Name geprüft,
 * weil er ebenfalls als Pfad- und URL-Segment verwendet wird
 * (Path-Traversal-/Injection-Schutz, kein `/`).
 */
export function validateRuSpecList(input: RuSpecInput): ValidationResult<RuSpec[]> {
  const raw: ReadonlyArray<string | { repo?: unknown; workspace?: unknown }> =
    typeof input === 'string' ? input.split(',') : input;

  const specs: RuSpec[] = [];
  for (const entry of raw) {
    let repo: string;
    let workspace: string | undefined;

    if (typeof entry === 'string') {
      repo = entry.trim();
    } else if (entry !== null && typeof entry === 'object') {
      repo = typeof entry.repo === 'string' ? entry.repo.trim() : '';
      if (typeof entry.workspace === 'string' && entry.workspace.trim().length > 0) {
        workspace = entry.workspace.trim();
      }
    } else {
      return { ok: false, error: 'Error: invalid RU entry (expected a name or { repo, workspace })' };
    }

    if (repo.length === 0) continue; // leere Einträge überspringen (wie validateRuList)

    if (!RU_NAME_PATTERN.test(repo)) {
      return {
        ok: false,
        error: `Error: invalid RU name "${repo}" — allowed: letters, digits, '.', '_', '-' (must start alphanumeric; no '/', '\\' or '..')`,
      };
    }
    if (workspace !== undefined && !RU_NAME_PATTERN.test(workspace)) {
      return {
        ok: false,
        error: `Error: invalid workspace "${workspace}" for RU "${repo}" — allowed: letters, digits, '.', '_', '-' (no '/', '\\')`,
      };
    }

    specs.push(workspace !== undefined ? { repo, workspace } : { repo });
  }

  if (specs.length === 0) {
    return { ok: false, error: 'Error: RU list is missing' };
  }

  return { ok: true, value: specs };
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
 * Erlaubt: alphanumerische Segmente, getrennt durch EINZELNE Bindestriche
 * (`ABC-123`, `ABC-123-DEF`, `1234`). Bewusst NICHT erlaubt: führende/anhängende
 * Bindestriche (`-ABC`, `ABC-`) und doppelte Bindestriche (`A--B`) — sie würden
 * im Branch-Namen (`<ticket>-<branch>`) und in der Commit-Message zu hässlichen
 * Doppel-Trennern führen.
 *
 * @param input - Roh-Eingabe
 */
export function validateTicket(input: string): ValidationResult<string> {
  const trimmed = input.trim().toUpperCase();

  if (trimmed.length === 0) {
    return { ok: false, error: 'Error: Ticket is missing' };
  }
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(trimmed)) {
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

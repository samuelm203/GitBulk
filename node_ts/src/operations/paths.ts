/**
 * Gemeinsamer Pfad-Helfer für datei-basierte Operationen.
 *
 * Operationen dürfen nur INNERHALB des Repo-Verzeichnisses schreiben/löschen.
 * `resolveInRepo` weist absolute Pfade und Pfade ab, die über `..` aus dem
 * Repo herausführen — so kann eine (fehlerhafte oder bösartige) Config nicht
 * versehentlich Dateien außerhalb des Ziel-Repos anfassen.
 */

import { resolve, isAbsolute, relative } from 'node:path';

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Löst einen relativen Pfad gegen das Repo-Verzeichnis auf und stellt sicher,
 * dass er das Repo nicht verlässt.
 *
 * @param repoDir - absolutes Wurzelverzeichnis des Repos
 * @param rel     - relativer Pfad aus der Config
 */
export function resolveInRepo(repoDir: string, rel: string): ResolveResult {
  if (isAbsolute(rel)) {
    return { ok: false, error: `path must be relative to the repo, got absolute "${rel}"` };
  }
  const abs = resolve(repoDir, rel);
  const relToRepo = relative(repoDir, abs);
  if (relToRepo === '..' || relToRepo.startsWith(`..`) || isAbsolute(relToRepo)) {
    return { ok: false, error: `path "${rel}" escapes the repo directory` };
  }
  return { ok: true, path: abs };
}

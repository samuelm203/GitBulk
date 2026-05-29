/**
 * Operation: add-file
 *
 * Legt eine Datei mit dem angegebenen Inhalt an (inkl. fehlender
 * Zwischenverzeichnisse).
 *
 * Verhalten:
 *   - Datei fehlt              → schreibt sie, changed: true.
 *   - Datei existiert, gleich  → changed: false (idempotent).
 *   - Datei existiert, anders  → nur überschreiben wenn `overwrite: true`,
 *                                sonst changed: false (kein Fehler, wird
 *                                übersprungen, um nichts zu zerstören).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Repo-relativer Zielpfad, z. B. "src/Foo.java". */
  path: z.string().min(1, 'path must not be empty'),
  /** Dateiinhalt (Default: leere Datei). */
  content: z.string().default(''),
  /** Vorhandene Datei mit abweichendem Inhalt überschreiben? */
  overwrite: z.boolean().default(false),
});

type AddFileParams = z.infer<typeof schema>;

const operation: Operation<AddFileParams> = {
  type: 'add-file',
  description: 'Create a file with given content (skips an existing file unless overwrite)',
  schema,

  apply(params: AddFileParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (existsSync(file)) {
      const current = readFileSync(file, 'utf8');
      if (current === params.content) {
        return { changed: false, message: `${params.path} already up to date — skipping.` };
      }
      if (!params.overwrite) {
        return {
          changed: false,
          message: `${params.path} already exists — skipping (set overwrite: true to replace).`,
        };
      }
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, params.content, 'utf8');
    return { changed: true, message: `Wrote ${params.path}` };
  },
};

registerOperation(operation);

export default operation;

/**
 * Operation: replace-file
 *
 * Ersetzt den gesamten Inhalt einer EXISTIERENDEN Datei.
 *
 * Verhalten:
 *   - Datei fehlt              → changed: false (kein Fehler; wird übersprungen).
 *   - Inhalt bereits identisch → changed: false (idempotent).
 *   - Sonst                    → schreibt neuen Inhalt, changed: true.
 *
 * Abgrenzung zu `add-file`: replace-file legt KEINE neue Datei an, sondern
 * aktualisiert nur eine vorhandene. Wer eine Datei erzeugen will, nutzt add-file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Repo-relativer Pfad der zu ersetzenden Datei. */
  path: z.string().min(1, 'path must not be empty'),
  /** Neuer, vollständiger Dateiinhalt. */
  content: z.string(),
});

type ReplaceFileParams = z.infer<typeof schema>;

const operation: Operation<ReplaceFileParams> = {
  type: 'replace-file',
  description: 'Replace the full content of an existing file (skips if missing)',
  schema,

  apply(params: ReplaceFileParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.path} found — skipping.` };
    }

    const current = readFileSync(file, 'utf8');
    if (current === params.content) {
      return { changed: false, message: `${params.path} already up to date — skipping.` };
    }

    writeFileSync(file, params.content, 'utf8');
    return { changed: true, message: `Replaced ${params.path}` };
  },

  generateScript(params: ReplaceFileParams): string {
    const path = JSON.stringify(params.path);
    const content = JSON.stringify(params.content);
    return [
      `const target = join(repoDir, ${path});`,
      `const content = ${content};`,
      `if (!existsSync(target)) log('no ' + ${path} + ' — skipping');`,
      `else if (readFileSync(target, 'utf8') === content) log(${path} + ' already up to date');`,
      `else { writeFileSync(target, content); log('replaced ' + ${path}); }`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

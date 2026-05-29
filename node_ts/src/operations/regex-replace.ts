/**
 * Operation: regex-replace
 *
 * Sucht in einer Datei per regulärem Ausdruck und ersetzt die Treffer.
 *
 * Verhalten:
 *   - Datei fehlt            → changed: false (kein Fehler; übersprungen).
 *   - Ungültiges Pattern     → error.
 *   - Kein Treffer           → changed: false (bzw. error, wenn requireMatch).
 *   - Ersetzung ohne Wirkung → changed: false (idempotent).
 *   - Sonst                  → schreibt das Ergebnis, changed: true.
 *
 * Das `replacement` unterstützt die JS-`String.replace`-Syntax ($1, $<name>, …).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Repo-relativer Pfad der zu bearbeitenden Datei. */
  path: z.string().min(1, 'path must not be empty'),
  /** Regulärer Ausdruck als String (wird zu `new RegExp` kompiliert). */
  pattern: z.string().min(1, 'pattern must not be empty'),
  /** Ersetzungs-String (String.replace-Syntax). */
  replacement: z.string(),
  /** RegExp-Flags. Default `g` (alle Treffer ersetzen). */
  flags: z.string().default('g'),
  /** Wenn true, gilt "kein Treffer" als Fehler. */
  requireMatch: z.boolean().default(false),
});

type RegexReplaceParams = z.infer<typeof schema>;

const operation: Operation<RegexReplaceParams> = {
  type: 'regex-replace',
  description: 'Search & replace in a file via a regular expression',
  schema,

  apply(params: RegexReplaceParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.path} found — skipping.` };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(params.pattern, params.flags);
    } catch (err) {
      const error = `invalid regex (/${params.pattern}/${params.flags}): ${(err as Error).message}`;
      return { changed: false, message: error, error };
    }

    const current = readFileSync(file, 'utf8');
    // `regex.test` rückt bei globalem Flag `lastIndex` vor — danach zurücksetzen,
    // damit das anschließende `replace` von vorn beginnt.
    const matched = regex.test(current);
    regex.lastIndex = 0;

    if (!matched) {
      if (params.requireMatch) {
        const error = `pattern /${params.pattern}/${params.flags} did not match in ${params.path}`;
        return { changed: false, message: error, error };
      }
      return { changed: false, message: `No match in ${params.path} — skipping.` };
    }

    const updated = current.replace(regex, params.replacement);
    if (updated === current) {
      return { changed: false, message: `${params.path} unchanged after replace — skipping.` };
    }

    writeFileSync(file, updated, 'utf8');
    return { changed: true, message: `Replaced pattern in ${params.path}` };
  },
};

registerOperation(operation);

export default operation;

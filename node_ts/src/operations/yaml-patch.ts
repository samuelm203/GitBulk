/**
 * Operation: yaml-patch
 *
 * Setzt einen Wert an einem Dot-Pfad (z. B. `image.tag`) in einer YAML-Datei.
 * Fehlende Zwischen-Maps werden angelegt. Die Datei wird über den Dokument-
 * Modus der `yaml`-Lib editiert — **Kommentare und Formatierung unveränderter
 * Teile bleiben erhalten** (kein komplettes Re-Serialisieren).
 *
 * Der `value` wird wie bei `json-patch` als JSON interpretiert, wenn möglich
 * (`true` → boolean, `42` → number), sonst als roher String verwendet.
 *
 * Verhalten:
 *   - Datei fehlt        → changed: false (übersprungen).
 *   - Wert schon gleich  → changed: false (idempotent).
 *   - Ungültiges YAML    → error (kein Teil-Schreiben).
 *   - Sonst              → setzt den Wert, changed: true.
 *
 * Bewusst KEIN `generateScript`: YAML lässt sich ohne Dependency nicht seriös
 * in einem eigenständigen Skript parsen — der init-Skriptmodus hinterlässt
 * dafür einen TODO-Kommentar (bestehendes Verhalten für Operationen ohne
 * Generator).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { parseDocument } from 'yaml';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';
import { coerceJsonValue, getByDotPath } from './json-util.js';

const schema = z.object({
  /** Repo-relativer Pfad der YAML-Datei. */
  path: z.string().min(1, 'path must not be empty'),
  /** Dot-Pfad des zu setzenden Feldes, z. B. "image.tag". */
  pointer: z.string().min(1, 'pointer must not be empty'),
  /** Zu setzender Wert (wird als JSON interpretiert, sonst roher String). */
  value: z.string(),
});

type YamlPatchParams = z.infer<typeof schema>;

const operation: Operation<YamlPatchParams> = {
  type: 'yaml-patch',
  description:
    'Set a value at a dot-path in a YAML file (comments preserved; value parsed as JSON if possible)',
  schema,

  apply(params: YamlPatchParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.path} found — skipping.` };
    }

    const text = readFileSync(file, 'utf8');
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      const error = `invalid YAML in ${params.path}: ${doc.errors[0]?.message ?? 'parse error'}`;
      return { changed: false, message: error, error };
    }

    const value = coerceJsonValue(params.value);
    const keys = params.pointer.split('.');

    // Idempotenz-Vergleich über die JS-Sicht des Dokuments (wie json-patch).
    const data = (doc.toJS() ?? {}) as Record<string, unknown>;
    const current = getByDotPath(data, params.pointer);
    if (JSON.stringify(current) === JSON.stringify(value)) {
      return { changed: false, message: `${params.path} ${params.pointer} already set — skipping.` };
    }

    doc.setIn(keys, value);
    writeFileSync(file, doc.toString(), 'utf8');

    return { changed: true, message: `Set ${params.pointer} in ${params.path}` };
  },
};

registerOperation(operation);

export default operation;

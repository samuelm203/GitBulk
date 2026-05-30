/**
 * Operation: json-patch
 *
 * Setzt einen Wert an einem Dot-Pfad (z. B. `scripts.build`) in einer
 * JSON-Datei. Fehlende Zwischenobjekte werden angelegt.
 *
 * Der `value` wird als JSON interpretiert, wenn möglich (`true` → boolean,
 * `42` → number, `"x"` → string), sonst als roher String verwendet. So lassen
 * sich auch nicht-String-Werte über eine einfache string-Eingabe setzen.
 *
 * Verhalten:
 *   - Datei fehlt        → changed: false (übersprungen).
 *   - Wert schon gleich  → changed: false (idempotent).
 *   - Sonst              → setzt den Wert, changed: true.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';
import { detectJsonIndent, coerceJsonValue, getByDotPath, setByDotPath } from './json-util.js';

const schema = z.object({
  /** Repo-relativer Pfad der JSON-Datei. */
  path: z.string().min(1, 'path must not be empty'),
  /** Dot-Pfad des zu setzenden Feldes, z. B. "scripts.build". */
  pointer: z.string().min(1, 'pointer must not be empty'),
  /** Zu setzender Wert (wird als JSON interpretiert, sonst roher String). */
  value: z.string(),
});

type JsonPatchParams = z.infer<typeof schema>;

const operation: Operation<JsonPatchParams> = {
  type: 'json-patch',
  description: 'Set a value at a dot-path in a JSON file (value parsed as JSON if possible)',
  schema,

  apply(params: JsonPatchParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.path} found — skipping.` };
    }

    const text = readFileSync(file, 'utf8');
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      const error = `invalid JSON in ${params.path}: ${(err as Error).message}`;
      return { changed: false, message: error, error };
    }

    const value = coerceJsonValue(params.value);
    const current = getByDotPath(data, params.pointer);
    if (JSON.stringify(current) === JSON.stringify(value)) {
      return { changed: false, message: `${params.path} ${params.pointer} already set — skipping.` };
    }

    setByDotPath(data, params.pointer, value);

    const indent = detectJsonIndent(text);
    const trailingNewline = text.endsWith('\n') ? '\n' : '';
    writeFileSync(file, JSON.stringify(data, null, indent) + trailingNewline, 'utf8');

    return { changed: true, message: `Set ${params.pointer} in ${params.path}` };
  },

  generateScript(params: JsonPatchParams): string {
    const path = JSON.stringify(params.path);
    const pointer = JSON.stringify(params.pointer);
    const rawValue = JSON.stringify(params.value);
    return [
      `const target = join(repoDir, ${path});`,
      `if (!existsSync(target)) { log('no ' + ${path} + ' — skipping'); }`,
      `else {`,
      `  const text = readFileSync(target, 'utf8');`,
      `  const data = JSON.parse(text);`,
      `  let value;`,
      `  try { value = JSON.parse(${rawValue}); } catch { value = ${rawValue}; }`,
      `  const keys = ${pointer}.split('.');`,
      `  let cur = data;`,
      `  for (let i = 0; i < keys.length - 1; i++) {`,
      `    const k = keys[i];`,
      `    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};`,
      `    cur = cur[k];`,
      `  }`,
      `  const last = keys[keys.length - 1];`,
      `  if (JSON.stringify(cur[last]) === JSON.stringify(value)) {`,
      `    log(${pointer} + ' already set — skipping');`,
      `  } else {`,
      `    cur[last] = value;`,
      `    const m = text.match(/\\n([ \\t]+)\\S/);`,
      `    const indent = m ? (m[1].includes('\\t') ? '\\t' : m[1].length) : 2;`,
      `    const nl = text.endsWith('\\n') ? '\\n' : '';`,
      `    writeFileSync(target, JSON.stringify(data, null, indent) + nl);`,
      `    log('set ' + ${pointer} + ' in ' + ${path});`,
      `  }`,
      `}`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

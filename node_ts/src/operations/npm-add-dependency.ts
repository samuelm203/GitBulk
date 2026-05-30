/**
 * Operation: npm-add-dependency
 *
 * Fügt eine Abhängigkeit in die `package.json` ein (dependencies /
 * devDependencies / peerDependencies).
 *
 * Verhalten:
 *   - Keine package.json   → changed: false (kein Fehler; übersprungen).
 *   - Bereits vorhanden    → changed: false (idempotent, egal welche Version).
 *   - Sonst                → fügt "name": "version" ein, changed: true.
 *
 * Die vorhandene Einrückung der Datei wird beibehalten.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';
import { detectJsonIndent } from './json-util.js';

const schema = z.object({
  /** Paketname, z. B. "lodash" oder "@scope/pkg". */
  name: z.string().min(1, 'name must not be empty'),
  /** Versions-Range, z. B. "^4.17.21". */
  version: z.string().min(1, 'version must not be empty'),
  /** Zielfeld in der package.json. */
  field: z
    .enum(['dependencies', 'devDependencies', 'peerDependencies'])
    .default('dependencies'),
  /** Relativer Pfad zur package.json. */
  packagePath: z.string().default('package.json'),
});

type NpmAddDependencyParams = z.infer<typeof schema>;

const operation: Operation<NpmAddDependencyParams> = {
  type: 'npm-add-dependency',
  description: 'Add a dependency to package.json (skips if already present)',
  schema,

  apply(params: NpmAddDependencyParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.packagePath);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.packagePath} found — skipping.` };
    }

    const text = readFileSync(file, 'utf8');
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      const error = `invalid JSON in ${params.packagePath}: ${(err as Error).message}`;
      return { changed: false, message: error, error };
    }

    const section = (pkg[params.field] as Record<string, string> | undefined) ?? {};
    if (Object.prototype.hasOwnProperty.call(section, params.name)) {
      return {
        changed: false,
        message: `${params.name} already in ${params.field} — skipping.`,
      };
    }

    section[params.name] = params.version;
    pkg[params.field] = section;

    const indent = detectJsonIndent(text);
    const trailingNewline = text.endsWith('\n') ? '\n' : '';
    writeFileSync(file, JSON.stringify(pkg, null, indent) + trailingNewline, 'utf8');

    return {
      changed: true,
      message: `Added ${params.name}@${params.version} to ${params.field}`,
    };
  },

  generateScript(params: NpmAddDependencyParams): string {
    const pkgPath = JSON.stringify(params.packagePath);
    const name = JSON.stringify(params.name);
    const version = JSON.stringify(params.version);
    const field = JSON.stringify(params.field);
    return [
      `const pkgFile = join(repoDir, ${pkgPath});`,
      `if (!existsSync(pkgFile)) { log('no ' + ${pkgPath} + ' — skipping'); }`,
      `else {`,
      `  const text = readFileSync(pkgFile, 'utf8');`,
      `  const pkg = JSON.parse(text);`,
      `  const section = pkg[${field}] || {};`,
      `  if (Object.prototype.hasOwnProperty.call(section, ${name})) {`,
      `    log(${name} + ' already in ' + ${field} + ' — skipping');`,
      `  } else {`,
      `    section[${name}] = ${version};`,
      `    pkg[${field}] = section;`,
      `    const m = text.match(/\\n([ \\t]+)\\S/);`,
      `    const indent = m ? (m[1].includes('\\t') ? '\\t' : m[1].length) : 2;`,
      `    const nl = text.endsWith('\\n') ? '\\n' : '';`,
      `    writeFileSync(pkgFile, JSON.stringify(pkg, null, indent) + nl);`,
      `    log('added ' + ${name} + '@' + ${version} + ' to ' + ${field});`,
      `  }`,
      `}`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

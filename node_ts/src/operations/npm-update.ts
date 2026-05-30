/**
 * Operation: npm-update
 *
 * Setzt die Version einer BEREITS vorhandenen Abhängigkeit in der package.json.
 * Sucht standardmäßig in dependencies, devDependencies und peerDependencies.
 *
 * Verhalten:
 *   - Keine package.json   → changed: false (übersprungen).
 *   - Name nicht vorhanden → changed: false (kein Fehler; nichts zu updaten).
 *   - Version schon gleich → changed: false (idempotent).
 *   - Sonst                → setzt die neue Version (in allen Fundstellen), changed: true.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';
import { detectJsonIndent } from './json-util.js';

const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

const schema = z.object({
  /** Paketname, z. B. "lodash". */
  name: z.string().min(1, 'name must not be empty'),
  /** Neue Version, z. B. "^4.17.21". */
  version: z.string().min(1, 'version must not be empty'),
  /** Relativer Pfad zur package.json. */
  packagePath: z.string().default('package.json'),
});

type NpmUpdateParams = z.infer<typeof schema>;

const operation: Operation<NpmUpdateParams> = {
  type: 'npm-update',
  description: 'Update the version of an existing dependency in package.json',
  schema,

  apply(params: NpmUpdateParams, ctx: OperationContext): OperationResult {
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

    let found = false;
    let changed = false;
    for (const field of FIELDS) {
      const section = pkg[field] as Record<string, string> | undefined;
      if (section && Object.prototype.hasOwnProperty.call(section, params.name)) {
        found = true;
        if (section[params.name] !== params.version) {
          section[params.name] = params.version;
          changed = true;
        }
      }
    }

    if (!found) {
      return { changed: false, message: `${params.name} not found in ${params.packagePath} — skipping.` };
    }
    if (!changed) {
      return { changed: false, message: `${params.name} already at ${params.version} — skipping.` };
    }

    const indent = detectJsonIndent(text);
    const trailingNewline = text.endsWith('\n') ? '\n' : '';
    writeFileSync(file, JSON.stringify(pkg, null, indent) + trailingNewline, 'utf8');

    return { changed: true, message: `Updated ${params.name} to ${params.version}` };
  },

  generateScript(params: NpmUpdateParams): string {
    const pkgPath = JSON.stringify(params.packagePath);
    const name = JSON.stringify(params.name);
    const version = JSON.stringify(params.version);
    return [
      `const pkgFile = join(repoDir, ${pkgPath});`,
      `if (!existsSync(pkgFile)) { log('no ' + ${pkgPath} + ' — skipping'); }`,
      `else {`,
      `  const text = readFileSync(pkgFile, 'utf8');`,
      `  const pkg = JSON.parse(text);`,
      `  let found = false, changed = false;`,
      `  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {`,
      `    const section = pkg[field];`,
      `    if (section && Object.prototype.hasOwnProperty.call(section, ${name})) {`,
      `      found = true;`,
      `      if (section[${name}] !== ${version}) { section[${name}] = ${version}; changed = true; }`,
      `    }`,
      `  }`,
      `  if (!found) log(${name} + ' not found — skipping');`,
      `  else if (!changed) log(${name} + ' already at ' + ${version} + ' — skipping');`,
      `  else {`,
      `    const m = text.match(/\\n([ \\t]+)\\S/);`,
      `    const indent = m ? (m[1].includes('\\t') ? '\\t' : m[1].length) : 2;`,
      `    const nl = text.endsWith('\\n') ? '\\n' : '';`,
      `    writeFileSync(pkgFile, JSON.stringify(pkg, null, indent) + nl);`,
      `    log('updated ' + ${name} + ' to ' + ${version});`,
      `  }`,
      `}`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

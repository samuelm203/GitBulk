/**
 * `gitbulk list-operations` — listet alle registrierten Operationen samt ihrer
 * Parameter auf (für den deklarativen `operations:`-Modus).
 *
 * Die Parameter werden aus dem Zod-Schema jeder Operation abgeleitet
 * (`describeOperationParams`), sodass neue Operationen automatisch korrekt
 * angezeigt werden — ohne separate Pflege.
 */

import chalk from 'chalk';

import { listOperations, getOperation } from '../operations/index.js';
import { describeOperationParams, type ParamSpec } from './operation-introspect.js';

export interface ListOperationsOptions {
  /** Maschinenlesbare JSON-Ausgabe statt der menschenlesbaren Liste. */
  json?: boolean;
  /** Farbausgabe deaktivieren. */
  noColor?: boolean;
}

export interface OperationInfo {
  type: string;
  description: string;
  params: ParamSpec[];
}

/** Sammelt Typ, Beschreibung und Parameter aller registrierten Operationen. */
export function collectOperationInfos(): OperationInfo[] {
  return listOperations().map(({ type, description }) => {
    const op = getOperation(type);
    const params = op ? describeOperationParams(op.schema) : [];
    return { type, description, params };
  });
}

/** Formatiert einen Parameter als kompakte Zeile, z. B. `flags (string, optional, default="g")`. */
function formatParam(p: ParamSpec): string {
  const attrs: string[] = [p.kind];
  attrs.push(p.required ? 'required' : 'optional');
  if (p.defaultValue !== undefined) attrs.push(`default=${JSON.stringify(p.defaultValue)}`);
  if (p.enumValues && p.enumValues.length > 0) attrs.push(`one of: ${p.enumValues.join(' | ')}`);
  return `${p.name} (${attrs.join(', ')})`;
}

/**
 * Gibt die Operationen aus und liefert den Exit-Code (0).
 */
export function runListOperations(options: ListOperationsOptions = {}): number {
  const infos = collectOperationInfos();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(infos, null, 2)}\n`);
    return 0;
  }

  const useColor = !options.noColor;
  const bold = (s: string): string => (useColor ? chalk.bold(s) : s);
  const dim = (s: string): string => (useColor ? chalk.gray(s) : s);
  const green = (s: string): string => (useColor ? chalk.green(s) : s);

  if (infos.length === 0) {
    process.stdout.write('No operations are registered.\n');
    return 0;
  }

  process.stdout.write(bold(`\nAvailable operations (${infos.length}):\n\n`));
  for (const info of infos) {
    process.stdout.write(`${green(info.type)} — ${info.description}\n`);
    if (info.params.length === 0) {
      process.stdout.write(dim('    (no parameters)\n'));
    } else {
      for (const p of info.params) {
        process.stdout.write(`    ${dim('-')} ${formatParam(p)}\n`);
      }
    }
    process.stdout.write('\n');
  }
  process.stdout.write(dim('Use these under `operations:` in your config, or via `gitbulk init`.\n'));
  return 0;
}

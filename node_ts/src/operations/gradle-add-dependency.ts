/**
 * Operation: gradle-add-dependency
 *
 * Fügt eine Gradle-Abhängigkeit in den TOP-LEVEL-`dependencies { … }`-Block der
 * Build-Datei ein (direkt nach der öffnenden Zeile). Der Block muss am
 * Zeilenanfang stehen — eingerückte Blöcke (z. B. in `buildscript { … }`)
 * werden bewusst ignoriert.
 *
 * DSL-Erkennung über die Dateiendung von `buildFilePath`:
 *   - `.kts`  → Kotlin-DSL:  implementation("group:name:version")
 *   - sonst   → Groovy-DSL:  implementation 'group:name:version'
 *
 * Verhalten:
 *   - Keine Build-Datei      → changed: false (übersprungen).
 *   - `group:name` vorhanden → changed: false (idempotent, Version egal).
 *   - Kein dependencies-Block→ error (im Report sichtbar).
 *   - Sonst                  → fügt ein, changed: true.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Gradle group, z. B. "org.apache.commons". */
  group: z.string().min(1, 'group must not be empty'),
  /** Artefakt-Name, z. B. "commons-lang3". */
  name: z.string().min(1, 'name must not be empty'),
  /** Version, z. B. "3.14.0". */
  version: z.string().min(1, 'version must not be empty'),
  /** Gradle-Configuration, z. B. "implementation" oder "testImplementation". */
  configuration: z.string().min(1).default('implementation'),
  /** Relativer Pfad zur Build-Datei (Default: "build.gradle"; `.kts` → Kotlin-DSL). */
  buildFilePath: z.string().default('build.gradle'),
});

type GradleAddDependencyParams = z.infer<typeof schema>;

/** Escaped einen String für die Verwendung in einer RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Baut die Dependency-Zeile passend zur DSL (ohne Einrückung). */
function dependencyLine(params: GradleAddDependencyParams, kotlinDsl: boolean): string {
  const notation = `${params.group}:${params.name}:${params.version}`;
  return kotlinDsl
    ? `${params.configuration}("${notation}")`
    : `${params.configuration} '${notation}'`;
}

const operation: Operation<GradleAddDependencyParams> = {
  type: 'gradle-add-dependency',
  description: 'Add a Gradle dependency to the top-level dependencies block (Groovy or Kotlin DSL)',
  schema,

  apply(params: GradleAddDependencyParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.buildFilePath);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `No ${params.buildFilePath} found — skipping.` };
    }

    const original = readFileSync(file, 'utf8');

    // Idempotenz: group:name bereits als Dependency-Notation vorhanden
    // (beliebige Version, beliebige Configuration)?
    const notationRegex = new RegExp(
      `['"]${escapeRegExp(params.group)}:${escapeRegExp(params.name)}(:[^'"]*)?['"]`,
    );
    if (notationRegex.test(original)) {
      return {
        changed: false,
        message: `Dependency ${params.group}:${params.name} already present — skipping.`,
      };
    }

    // Top-Level-Block: `dependencies {` am Zeilenanfang (Spalte 0) — schließt
    // eingerückte Blöcke wie buildscript.dependencies aus.
    const blockMatch = /^dependencies\s*\{[^\n]*\n/m.exec(original);
    if (blockMatch === null) {
      return {
        changed: false,
        message: 'no top-level dependencies block',
        error: `Could not find a top-level dependencies block in ${params.buildFilePath}.`,
      };
    }

    const insertPos = blockMatch.index + blockMatch[0].length;
    // Einrückung von der nächsten Inhalts-Zeile übernehmen, sonst 4 Spaces.
    const rest = original.slice(insertPos);
    const indent = /^([ \t]+)(?=\S)/.exec(rest)?.[1] ?? '    ';

    const kotlinDsl = params.buildFilePath.endsWith('.kts');
    const line = `${indent}${dependencyLine(params, kotlinDsl)}\n`;

    writeFileSync(file, original.slice(0, insertPos) + line + original.slice(insertPos), 'utf8');

    return {
      changed: true,
      message: `Added ${params.configuration} ${params.group}:${params.name}:${params.version}`,
    };
  },

  generateScript(params: GradleAddDependencyParams): string {
    const buildFilePath = JSON.stringify(params.buildFilePath);
    const group = JSON.stringify(params.group);
    const name = JSON.stringify(params.name);
    const version = JSON.stringify(params.version);
    const configuration = JSON.stringify(params.configuration);
    return [
      `const buildFile = join(repoDir, ${buildFilePath});`,
      `const group = ${group}, depName = ${name}, version = ${version}, configuration = ${configuration};`,
      `if (!existsSync(buildFile)) { log('no ' + ${buildFilePath} + ' — skipping'); }`,
      `else {`,
      `  const text = readFileSync(buildFile, 'utf8');`,
      `  const esc = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');`,
      `  if (new RegExp("['\\"]" + esc(group) + ':' + esc(depName) + "(:[^'\\"]*)?['\\"]").test(text)) {`,
      `    log(group + ':' + depName + ' already present — skipping');`,
      `  } else {`,
      `    const m = /^dependencies\\s*\\{[^\\n]*\\n/m.exec(text);`,
      `    if (m === null) throw new Error('no top-level dependencies block in ' + ${buildFilePath});`,
      `    const insertPos = m.index + m[0].length;`,
      `    const im = /^([ \\t]+)(?=\\S)/.exec(text.slice(insertPos));`,
      `    const indent = im ? im[1] : '    ';`,
      `    const notation = group + ':' + depName + ':' + version;`,
      `    const line = ${buildFilePath}.endsWith('.kts')`,
      `      ? configuration + '("' + notation + '")'`,
      `      : configuration + " '" + notation + "'";`,
      `    writeFileSync(buildFile, text.slice(0, insertPos) + indent + line + '\\n' + text.slice(insertPos));`,
      `    log('added ' + configuration + ' ' + notation);`,
      `  }`,
      `}`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

/**
 * Operation: maven-add-dependency
 *
 * Fügt eine Maven-Abhängigkeit in die `pom.xml` des Repos ein — direkt vor dem
 * schließenden `</dependencies>`-Tag des PROJEKT-Dependency-Blocks (nicht in
 * `<dependencyManagement>`).
 *
 * Verhalten:
 *   - Keine pom.xml      → changed: false (kein Fehler; Repo wird übersprungen).
 *   - Bereits vorhanden  → changed: false (idempotent).
 *   - Kein Projekt-Block → error (im Report sichtbar).
 *   - Sonst              → fügt ein, changed: true.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Maven groupId, z. B. "org.apache.commons". */
  groupId: z.string().min(1, 'groupId must not be empty'),
  /** Maven artifactId, z. B. "commons-lang3". */
  artifactId: z.string().min(1, 'artifactId must not be empty'),
  /** Version, z. B. "3.14.0". */
  version: z.string().min(1, 'version must not be empty'),
  /** Optionaler scope, z. B. "test" oder "provided". */
  scope: z.string().optional(),
  /** Relativer Pfad zur pom.xml (Default: "pom.xml" im Repo-Root). */
  pomPath: z.string().default('pom.xml'),
});

type MavenAddDependencyParams = z.infer<typeof schema>;

/**
 * Findet die Position des schließenden </dependencies>-Tags des
 * Projekt-Dependency-Blocks (nicht innerhalb von <dependencyManagement>).
 * Gibt -1 zurück, wenn keiner gefunden wird.
 */
function findProjectDependenciesClose(xml: string): number {
  const openRegex = /<dependencies\s*>/g;
  const closeTag = '</dependencies>';

  let match: RegExpExecArray | null;
  while ((match = openRegex.exec(xml)) !== null) {
    const openIdx = match.index;
    const closeIdx = xml.indexOf(closeTag, openIdx);
    if (closeIdx === -1) continue;

    // Steht direkt vor diesem <dependencies> ein noch offenes
    // <dependencyManagement>? Dann ist es der falsche Block.
    const before = xml.slice(0, openIdx);
    const lastMgmtOpen = before.lastIndexOf('<dependencyManagement>');
    const lastMgmtClose = before.lastIndexOf('</dependencyManagement>');
    const insideMgmt = lastMgmtOpen > lastMgmtClose;

    if (!insideMgmt) return closeIdx;
  }
  return -1;
}

const operation: Operation<MavenAddDependencyParams> = {
  type: 'maven-add-dependency',
  description: 'Add a Maven dependency to pom.xml (before </dependencies>)',
  schema,

  apply(params: MavenAddDependencyParams, ctx: OperationContext): OperationResult {
    // Pfad-Sicherheit: pomPath muss innerhalb des Repos liegen (kein Ausbruch
    // via absolutem Pfad oder `..`).
    const resolved = resolveInRepo(ctx.repoDir, params.pomPath);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const pomFile = resolved.path;

    if (!existsSync(pomFile)) {
      return { changed: false, message: `No ${params.pomPath} found — skipping.` };
    }

    const original = readFileSync(pomFile, 'utf8');

    // Idempotenz: groupId + artifactId zusammen bereits vorhanden?
    const alreadyPresent =
      original.includes(`<artifactId>${params.artifactId}</artifactId>`) &&
      original.includes(`<groupId>${params.groupId}</groupId>`);
    if (alreadyPresent) {
      return {
        changed: false,
        message: `Dependency ${params.groupId}:${params.artifactId} already present — skipping.`,
      };
    }

    const closeIdx = findProjectDependenciesClose(original);
    if (closeIdx === -1) {
      return {
        changed: false,
        message: 'no project-level <dependencies> block',
        error: `Could not find a project-level <dependencies> block in ${params.pomPath}.`,
      };
    }

    // Einrückung aus dem Zielblock ableiten.
    const lineStart = original.lastIndexOf('\n', closeIdx) + 1;
    const closeIndent = original.slice(lineStart, closeIdx).match(/^\s*/)?.[0] ?? '  ';

    const blockOpenIdx = original.lastIndexOf('<dependencies>', closeIdx);
    const blockContent = blockOpenIdx !== -1 ? original.slice(blockOpenIdx, closeIdx) : '';
    const existingDepMatch = blockContent.match(/\n([ \t]*)<dependency\s*>/);
    const existingDepIndent = existingDepMatch?.[1] ?? `${closeIndent}  `;
    const step =
      existingDepIndent.length > closeIndent.length
        ? existingDepIndent.slice(closeIndent.length)
        : '  ';

    const itemIndent = existingDepIndent;
    const fieldIndent = `${itemIndent}${step}`;

    const lines = [
      `${itemIndent}<dependency>`,
      `${fieldIndent}<groupId>${params.groupId}</groupId>`,
      `${fieldIndent}<artifactId>${params.artifactId}</artifactId>`,
      `${fieldIndent}<version>${params.version}</version>`,
    ];
    if (params.scope) {
      lines.push(`${fieldIndent}<scope>${params.scope}</scope>`);
    }
    lines.push(`${itemIndent}</dependency>`);
    const dependencyBlock = `${lines.join('\n')}\n`;

    const updated = original.slice(0, lineStart) + dependencyBlock + original.slice(lineStart);
    writeFileSync(pomFile, updated, 'utf8');

    return {
      changed: true,
      message: `Added ${params.groupId}:${params.artifactId}:${params.version}`,
    };
  },

  generateScript(params: MavenAddDependencyParams): string {
    const pomPath = JSON.stringify(params.pomPath);
    const groupId = JSON.stringify(params.groupId);
    const artifactId = JSON.stringify(params.artifactId);
    const version = JSON.stringify(params.version);
    const scope = params.scope !== undefined ? JSON.stringify(params.scope) : 'undefined';
    return [
      `const pomFile = join(repoDir, ${pomPath});`,
      `const groupId = ${groupId}, artifactId = ${artifactId}, version = ${version}, scope = ${scope};`,
      `if (!existsSync(pomFile)) { log('no ' + ${pomPath} + ' — skipping'); }`,
      `else {`,
      `  const xml = readFileSync(pomFile, 'utf8');`,
      `  if (xml.includes('<artifactId>' + artifactId + '</artifactId>') && xml.includes('<groupId>' + groupId + '</groupId>')) {`,
      `    log(groupId + ':' + artifactId + ' already present — skipping');`,
      `  } else {`,
      `    const openRe = /<dependencies\\s*>/g;`,
      `    let m, closeIdx = -1;`,
      `    while ((m = openRe.exec(xml)) !== null) {`,
      `      const ci = xml.indexOf('</dependencies>', m.index);`,
      `      if (ci === -1) continue;`,
      `      const before = xml.slice(0, m.index);`,
      `      if (before.lastIndexOf('<dependencyManagement>') <= before.lastIndexOf('</dependencyManagement>')) { closeIdx = ci; break; }`,
      `    }`,
      `    if (closeIdx === -1) throw new Error('no project-level <dependencies> block in ' + ${pomPath});`,
      `    const lineStart = xml.lastIndexOf('\\n', closeIdx) + 1;`,
      `    const closeIndent = (xml.slice(lineStart, closeIdx).match(/^\\s*/) || [''])[0];`,
      `    const itemIndent = closeIndent + '  ', fieldIndent = closeIndent + '    ';`,
      `    const lines = [itemIndent + '<dependency>', fieldIndent + '<groupId>' + groupId + '</groupId>', fieldIndent + '<artifactId>' + artifactId + '</artifactId>', fieldIndent + '<version>' + version + '</version>'];`,
      `    if (scope) lines.push(fieldIndent + '<scope>' + scope + '</scope>');`,
      `    lines.push(itemIndent + '</dependency>');`,
      `    writeFileSync(pomFile, xml.slice(0, lineStart) + lines.join('\\n') + '\\n' + xml.slice(lineStart));`,
      `    log('added ' + groupId + ':' + artifactId + ':' + version);`,
      `  }`,
      `}`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;

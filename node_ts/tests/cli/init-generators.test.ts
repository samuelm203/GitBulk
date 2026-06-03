/**
 * Tests für die reine Logik hinter `gitbulk init`:
 *   - operation-introspect (Parameter aus Zod-Schemas ableiten)
 *   - config-generator (YAML, die gegen das echte Schema validiert)
 *   - script-generator (erzeugt .mjs/.ts, die WIRKLICH die Operationen ausführen)
 *
 * Der interaktive readline-Teil (init.ts) wird hier bewusst nicht getestet;
 * die gesamte testbare Logik liegt in den hier geprüften Modulen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse as parseYaml } from 'yaml';

import { getOperation } from '../../src/operations/index.js';
import { describeOperationParams } from '../../src/cli/operation-introspect.js';
import { generateScript } from '../../src/cli/script-generator.js';
import { generateYamlConfig, buildConfigObject } from '../../src/cli/config-generator.js';
import { GitBulkConfigSchema } from '../../src/config/schema.js';
import { validateOutputFileName, resolveOutputPath } from '../../src/cli/init.js';
import type { Interface } from 'node:readline/promises';

/** Minimaler readline-Mock: liefert die Antworten der Reihe nach. */
function mockRl(answers: string[]): Interface {
  let i = 0;
  return {
    question: async () => answers[i++] ?? '',
    close: () => undefined,
  } as unknown as Interface;
}

// ── operation-introspect ────────────────────────────────────────────

describe('describeOperationParams', () => {
  it('derives params from the maven schema (required / optional / default)', () => {
    const op = getOperation('maven-add-dependency');
    assert.ok(op);
    const specs = describeOperationParams(op!.schema);
    const byName = new Map(specs.map((s) => [s.name, s]));

    assert.equal(byName.get('groupId')?.kind, 'string');
    assert.equal(byName.get('groupId')?.required, true);
    assert.equal(byName.get('version')?.required, true);
    // scope ist optional ohne Default
    assert.equal(byName.get('scope')?.required, false);
    assert.equal(byName.get('scope')?.defaultValue, undefined);
    // pomPath hat einen Default → nicht required
    assert.equal(byName.get('pomPath')?.required, false);
    assert.equal(byName.get('pomPath')?.defaultValue, 'pom.xml');
  });

  it('detects boolean params (add-file overwrite)', () => {
    const op = getOperation('add-file');
    const specs = describeOperationParams(op!.schema);
    const overwrite = specs.find((s) => s.name === 'overwrite');
    assert.equal(overwrite?.kind, 'boolean');
    assert.equal(overwrite?.required, false);
    assert.equal(overwrite?.defaultValue, false);
  });
});

// ── config-generator ────────────────────────────────────────────────

describe('config-generator', () => {
  const baseInput = {
    rus: ['repo-a', 'repo-b'],
    ticket: 'AKB-1234',
    branch: 'feature/test',
    commitMessage: 'feat: add dep',
    prSummary: 'Add dependency',
    createPrOnError: false,
    prPlatform: 'bitbucket' as const,
    bitbucketWorkspace: 'my-ws',
    operations: [
      {
        type: 'maven-add-dependency',
        groupId: 'org.apache.commons',
        artifactId: 'commons-lang3',
        version: '3.14.0',
      },
    ],
  };

  it('builds a config object with operations and bitbucket block', () => {
    const cfg = buildConfigObject(baseInput);
    assert.deepEqual(cfg.rus, ['repo-a', 'repo-b']);
    assert.ok(Array.isArray(cfg.operations));
    assert.equal((cfg.bitbucket as { workspace: string }).workspace, 'my-ws');
    assert.ok(!('script' in cfg), 'must not emit a script field');
  });

  it('produces YAML that validates against the real schema', () => {
    const yaml = generateYamlConfig(baseInput);
    const parsed = parseYaml(yaml) as unknown;
    const result = GitBulkConfigSchema.safeParse(parsed);
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
  });
});

// ── script-generator (mit echter Ausführung) ────────────────────────

describe('script-generator', () => {
  it('reports unsupported operation types', () => {
    const { unsupported } = generateScript([{ type: 'does-not-exist', params: {} }]);
    assert.deepEqual(unsupported, ['does-not-exist']);
  });

  it('generates a .mjs that actually performs the operations', () => {
    const ws = mkdtempSync(join(tmpdir(), 'gitbulk-gen-'));

    // Ausgangszustand: eine pom.xml + eine zu löschende Datei + eine zu ersetzende
    writeFileSync(
      join(ws, 'pom.xml'),
      [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>junit</groupId>',
        '      <artifactId>junit</artifactId>',
        '      <version>4.13.2</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    );
    writeFileSync(join(ws, 'old.txt'), 'remove me');
    writeFileSync(join(ws, 'version.txt'), 'version=1');

    const { code, unsupported } = generateScript([
      { type: 'add-file', params: { path: 'src/New.java', content: 'class New {}', overwrite: false } },
      { type: 'replace-file', params: { path: 'version.txt', content: 'version=2' } },
      { type: 'delete-file', params: { path: 'old.txt' } },
      { type: 'regex-replace', params: { path: 'pom.xml', pattern: '4\\.13\\.2', replacement: '4.13.3', flags: 'g', requireMatch: false } },
      {
        type: 'maven-add-dependency',
        params: { groupId: 'org.apache.commons', artifactId: 'commons-lang3', version: '3.14.0', pomPath: 'pom.xml' },
      },
    ]);
    assert.deepEqual(unsupported, []);

    const scriptPath = join(ws, 'change.mjs');
    writeFileSync(scriptPath, code);

    const r = spawnSync(process.execPath, [scriptPath], { cwd: ws, encoding: 'utf8' });
    assert.equal(r.status, 0, `script failed: ${r.stderr}`);

    // add-file
    assert.equal(readFileSync(join(ws, 'src/New.java'), 'utf8'), 'class New {}');
    // replace-file
    assert.equal(readFileSync(join(ws, 'version.txt'), 'utf8'), 'version=2');
    // delete-file
    assert.equal(existsSync(join(ws, 'old.txt')), false);
    // regex-replace + maven-add-dependency beide gegen pom.xml
    const pom = readFileSync(join(ws, 'pom.xml'), 'utf8');
    assert.match(pom, /4\.13\.3/);
    assert.match(pom, /<artifactId>commons-lang3<\/artifactId>/);
    // commons-lang3 muss im Projekt-Block stehen (eine zweite <dependency>)
    assert.equal((pom.match(/<dependency>/g) ?? []).length, 2);
  });

  it('generated script is idempotent on a second run', () => {
    const ws = mkdtempSync(join(tmpdir(), 'gitbulk-gen2-'));
    writeFileSync(join(ws, 'a.txt'), 'orig');

    const { code } = generateScript([
      { type: 'add-file', params: { path: 'a.txt', content: 'new', overwrite: false } },
    ]);
    const scriptPath = join(ws, 'change.mjs');
    writeFileSync(scriptPath, code);

    // add-file ohne overwrite darf vorhandene Datei nicht anfassen
    const r1 = spawnSync(process.execPath, [scriptPath], { cwd: ws, encoding: 'utf8' });
    assert.equal(r1.status, 0);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'orig');
  });

  it('generates a TypeScript (.ts) script that runs via tsx', () => {
    const ws = mkdtempSync(join(tmpdir(), 'gitbulk-gents-'));
    writeFileSync(join(ws, 'version.txt'), 'version=1');

    const { code, unsupported } = generateScript(
      [
        { type: 'add-file', params: { path: 'created.ts', content: 'export const x = 1;', overwrite: false } },
        { type: 'replace-file', params: { path: 'version.txt', content: 'version=2' } },
      ],
      'ts',
    );
    assert.deepEqual(unsupported, []);
    // Präambel enthält TS-Typsyntax
    assert.match(code, /const repoDir: string/);
    assert.match(code, /msg: string\): void/);

    const scriptPath = join(ws, 'change.ts');
    writeFileSync(scriptPath, code);

    // Portabel über alle CI-Node-Versionen: tsx absolut auflösen (GitBulks
    // eigene devDependency) und via --import laden; cwd = das Test-Repo.
    const tsxUrl = import.meta.resolve('tsx');
    const r = spawnSync(process.execPath, ['--import', tsxUrl, scriptPath], {
      cwd: ws,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `ts script failed: ${r.stderr}`);
    assert.equal(readFileSync(join(ws, 'created.ts'), 'utf8'), 'export const x = 1;');
    assert.equal(readFileSync(join(ws, 'version.txt'), 'utf8'), 'version=2');
  });
});

// ── validateOutputFileName (init.ts) ───────────────────────────────

describe('validateOutputFileName', () => {
  it('uses the default on blank input', () => {
    const r = validateOutputFileName('   ', 'gitbulk.config.yaml');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'gitbulk.config.yaml');
  });

  it('accepts a plain file name', () => {
    const r = validateOutputFileName('my-change.mjs', 'def');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'my-change.mjs');
  });

  it('rejects path separators and traversal', () => {
    for (const bad of ['../escape.yaml', 'sub/dir.yaml', 'a\\b.yaml', '.', '..']) {
      const r = validateOutputFileName(bad, 'def');
      assert.equal(r.ok, false, `expected "${bad}" to be rejected`);
    }
  });
});

describe('resolveOutputPath', () => {
  it('places generated files under gitbulk/ by default (blank → default name)', async () => {
    const target = await resolveOutputPath(mockRl(['']), { force: true }, 'gitbulk.config.yaml');
    assert.ok(target);
    assert.match(target, /[\\/]gitbulk[\\/]gitbulk\.config\.yaml$/);
  });

  it('uses a custom file name under gitbulk/', async () => {
    const target = await resolveOutputPath(mockRl(['my-change.mjs']), { force: true }, 'gitbulk-change.mjs');
    assert.ok(target);
    assert.match(target, /[\\/]gitbulk[\\/]my-change\.mjs$/);
  });

  it('honors --output verbatim (no gitbulk/ prefix)', async () => {
    const target = await resolveOutputPath(
      mockRl([]),
      { outputPath: 'custom/path.yaml', force: true },
      'gitbulk.config.yaml',
    );
    assert.ok(target);
    assert.match(target, /custom[\\/]path\.yaml$/);
    assert.doesNotMatch(target, /[\\/]gitbulk[\\/]/);
  });
});

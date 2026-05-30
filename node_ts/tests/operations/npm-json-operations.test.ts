/**
 * Tests für die npm-/json-Operationen (Paket C):
 *   npm-add-dependency, npm-update, json-patch.
 *
 * Geprüft werden das apply()-Verhalten (anlegen, idempotent, fehlende Datei,
 * ungültiges JSON) und — end-to-end — die generierten .mjs-Skripte.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import npmAddDependency from '../../src/operations/npm-add-dependency.js';
import npmUpdate from '../../src/operations/npm-update.js';
import jsonPatch from '../../src/operations/json-patch.js';
import type { Operation, OperationContext, OperationResult } from '../../src/operations/types.js';
import { generateScript } from '../../src/cli/script-generator.js';

function makeCtx(repoDir: string): OperationContext {
  return { repoDir, ru: 'test-repo', ticket: 'AKB-1', branch: 'AKB-1-x', sourceBranch: 'master' };
}

async function run<P>(
  op: Operation<P>,
  repoDir: string,
  params: Record<string, unknown>,
): Promise<OperationResult> {
  const parsed = op.schema.parse(params);
  return op.apply(parsed, makeCtx(repoDir));
}

function writePkg(dir: string, obj: unknown): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(obj, null, 2) + '\n');
}
function readPkg(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gitbulk-npmjson-'));
});

describe('npm-add-dependency', () => {
  it('adds a dependency to the chosen field', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0' });
    const r = await run(npmAddDependency, ws, { name: 'lodash', version: '^4.17.21' });
    assert.equal(r.changed, true);
    assert.equal((readPkg(ws).dependencies as Record<string, string>).lodash, '^4.17.21');
  });

  it('adds to devDependencies when field is set', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0' });
    await run(npmAddDependency, ws, { name: 'tsx', version: '^4', field: 'devDependencies' });
    assert.equal((readPkg(ws).devDependencies as Record<string, string>).tsx, '^4');
  });

  it('is idempotent when the dependency already exists', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0', dependencies: { lodash: '^4.0.0' } });
    const r = await run(npmAddDependency, ws, { name: 'lodash', version: '^4.17.21' });
    assert.equal(r.changed, false);
    // bestehende Version bleibt unangetastet
    assert.equal((readPkg(ws).dependencies as Record<string, string>).lodash, '^4.0.0');
  });

  it('skips when package.json is missing', async () => {
    const r = await run(npmAddDependency, ws, { name: 'lodash', version: '^4' });
    assert.equal(r.changed, false);
    assert.match(r.message, /No package\.json/);
  });

  it('reports an error on invalid JSON', async () => {
    writeFileSync(join(ws, 'package.json'), '{ not json');
    const r = await run(npmAddDependency, ws, { name: 'lodash', version: '^4' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
  });
});

describe('npm-update', () => {
  it('updates an existing dependency (any field)', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0', devDependencies: { tsx: '^4.0.0' } });
    const r = await run(npmUpdate, ws, { name: 'tsx', version: '^4.19.0' });
    assert.equal(r.changed, true);
    assert.equal((readPkg(ws).devDependencies as Record<string, string>).tsx, '^4.19.0');
  });

  it('skips when the dependency is not present', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0' });
    const r = await run(npmUpdate, ws, { name: 'ghost', version: '^1' });
    assert.equal(r.changed, false);
    assert.match(r.message, /not found/);
  });

  it('is idempotent when version already matches', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0', dependencies: { lodash: '^4.17.21' } });
    const r = await run(npmUpdate, ws, { name: 'lodash', version: '^4.17.21' });
    assert.equal(r.changed, false);
  });
});

describe('json-patch', () => {
  it('sets a value at a dot-path, creating intermediate objects', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0' });
    const r = await run(jsonPatch, ws, { path: 'package.json', pointer: 'scripts.build', value: 'tsc -p .' });
    assert.equal(r.changed, true);
    assert.equal((readPkg(ws).scripts as Record<string, string>).build, 'tsc -p .');
  });

  it('coerces JSON-looking values (boolean/number)', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0' });
    await run(jsonPatch, ws, { path: 'package.json', pointer: 'private', value: 'true' });
    await run(jsonPatch, ws, { path: 'package.json', pointer: 'config.retries', value: '3' });
    const pkg = readPkg(ws);
    assert.equal(pkg.private, true);
    assert.equal((pkg.config as Record<string, unknown>).retries, 3);
  });

  it('is idempotent when the value already matches', async () => {
    writePkg(ws, { name: 'x', version: '1.0.0', private: true });
    const r = await run(jsonPatch, ws, { path: 'package.json', pointer: 'private', value: 'true' });
    assert.equal(r.changed, false);
  });
});

describe('generated .mjs scripts (end-to-end)', () => {
  it('runs npm-add-dependency, npm-update and json-patch from generated code', () => {
    writePkg(ws, { name: 'x', version: '1.0.0', dependencies: { lodash: '^4.0.0' } });

    const { code, unsupported } = generateScript([
      { type: 'npm-add-dependency', params: { name: 'chalk', version: '^5', field: 'dependencies', packagePath: 'package.json' } },
      { type: 'npm-update', params: { name: 'lodash', version: '^4.17.21', packagePath: 'package.json' } },
      { type: 'json-patch', params: { path: 'package.json', pointer: 'scripts.test', value: 'node --test' } },
    ]);
    assert.deepEqual(unsupported, []);

    const scriptPath = join(ws, 'change.mjs');
    writeFileSync(scriptPath, code);
    const res = spawnSync(process.execPath, [scriptPath], { cwd: ws, encoding: 'utf8' });
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);

    const pkg = readPkg(ws);
    assert.equal((pkg.dependencies as Record<string, string>).chalk, '^5');
    assert.equal((pkg.dependencies as Record<string, string>).lodash, '^4.17.21');
    assert.equal((pkg.scripts as Record<string, string>).test, 'node --test');
  });
});

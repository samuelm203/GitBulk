/**
 * Tests für die yaml-patch-Operation: Dot-Pfad-Patch in YAML-Dateien,
 * Kommentar-Erhalt (Dokument-Modus der yaml-Lib), Idempotenz, Fehlerpfade.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse as parseYaml } from 'yaml';

import yamlPatch from '../../src/operations/yaml-patch.js';
import type { Operation, OperationContext, OperationResult } from '../../src/operations/types.js';

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

function writeYaml(dir: string, text: string): void {
  writeFileSync(join(dir, 'values.yaml'), text, 'utf8');
}
function readYaml(dir: string): Record<string, unknown> {
  return parseYaml(readFileSync(join(dir, 'values.yaml'), 'utf8')) as Record<string, unknown>;
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gitbulk-yamlpatch-'));
});

describe('yaml-patch', () => {
  it('sets a value at a dot-path, creating intermediate maps', async () => {
    writeYaml(ws, 'name: app\n');
    const r = await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'image.tag', value: '2.0' });
    assert.equal(r.changed, true);
    const data = readYaml(ws);
    assert.equal((data.image as Record<string, unknown>).tag, 2);
    // 2.0 wird als JSON-Zahl interpretiert (dokumentiertes coerce-Verhalten).
  });

  it('preserves comments and unrelated formatting', async () => {
    writeYaml(
      ws,
      '# Deployment-Werte\nimage:\n  repository: nginx # das Basis-Image\n  tag: "1.0"\nreplicas: 2\n',
    );
    const r = await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'image.tag', value: 'latest' });
    assert.equal(r.changed, true);

    const text = readFileSync(join(ws, 'values.yaml'), 'utf8');
    assert.match(text, /# Deployment-Werte/);
    assert.match(text, /# das Basis-Image/);
    const data = readYaml(ws);
    assert.equal((data.image as Record<string, unknown>).tag, 'latest');
    assert.equal(data.replicas, 2);
  });

  it('coerces JSON-looking values (boolean/number)', async () => {
    writeYaml(ws, 'name: app\n');
    await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'enabled', value: 'true' });
    await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'limits.retries', value: '3' });
    const data = readYaml(ws);
    assert.equal(data.enabled, true);
    assert.equal((data.limits as Record<string, unknown>).retries, 3);
  });

  it('is idempotent when the value already matches', async () => {
    writeYaml(ws, 'enabled: true\n');
    const r = await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'enabled', value: 'true' });
    assert.equal(r.changed, false);
    assert.match(r.message, /already set/);
  });

  it('skips when the file is missing', async () => {
    const r = await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'a', value: 'x' });
    assert.equal(r.changed, false);
    assert.match(r.message, /No values\.yaml/);
  });

  it('reports an error on invalid YAML without writing', async () => {
    writeYaml(ws, 'foo: [unclosed\n  bar: broken\n');
    const before = readFileSync(join(ws, 'values.yaml'), 'utf8');
    const r = await run(yamlPatch, ws, { path: 'values.yaml', pointer: 'a', value: 'x' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
    assert.equal(readFileSync(join(ws, 'values.yaml'), 'utf8'), before);
  });

  it('rejects a path escaping the repo', async () => {
    const r = await run(yamlPatch, ws, { path: '../outside.yaml', pointer: 'a', value: 'x' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
  });
});

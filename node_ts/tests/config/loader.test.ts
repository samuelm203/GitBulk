/**
 * Unit-Tests für config/loader.ts.
 *
 * Testet:
 *   - YAML-, JSON-, JS-Datei laden (TS skip wir, weil tsx-Runtime nötig)
 *   - Fehlende Felder → strict throws, hybrid → würde prompts triggern (skip)
 *   - Schema-Fehler werden als ConfigError gewrappt
 *   - Unsupported-Extension wird erkannt
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, ConfigError } from '../../src/config/loader.js';

let workspace: string;
let scriptPath: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gitbulk-loader-test-'));
  scriptPath = join(workspace, 'script.sh');
  writeFileSync(scriptPath, '#!/bin/sh\necho test\n', { mode: 0o755 });
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function fullYaml(): string {
  return `
rus: [repo-a, repo-b]
ticket: AKB-1
branch: feature/x
script: ${scriptPath}
commitMessage: "feat: x"
prSummary: "PR"
createPrOnError: false
sourceBranch: master
prPlatform: bitbucket
bitbucket:
  workspace: ws
  apiVariant: cloud
  targetBranch: master
`;
}

function fullJson(): string {
  return JSON.stringify({
    rus: ['repo-a'],
    ticket: 'AKB-1',
    branch: 'feature/x',
    script: scriptPath,
    commitMessage: 'feat: x',
    prSummary: 'PR',
    createPrOnError: false,
    sourceBranch: 'master',
    prPlatform: 'bitbucket',
    bitbucket: {
      workspace: 'ws',
      apiVariant: 'cloud',
      targetBranch: 'master',
    },
  });
}

describe('loadConfig - YAML', () => {
  it('loads a complete YAML config', async () => {
    const p = join(workspace, 'full.yaml');
    writeFileSync(p, fullYaml());
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(config.rus.length, 2);
    assert.equal(config.ticket, 'AKB-1');
    assert.equal(config.prPlatform, 'bitbucket');
  });

  it('also accepts .yml extension', async () => {
    const p = join(workspace, 'full.yml');
    writeFileSync(p, fullYaml());
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(config.rus[0], 'repo-a');
  });

  it('throws ConfigError for invalid YAML syntax', async () => {
    const p = join(workspace, 'broken.yaml');
    writeFileSync(p, 'rus: [a, b\n  not valid');
    await assert.rejects(loadConfig({ path: p, mode: 'strict' }), ConfigError);
  });
});

describe('loadConfig - JSON', () => {
  it('loads a complete JSON config', async () => {
    const p = join(workspace, 'full.json');
    writeFileSync(p, fullJson());
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(config.ticket, 'AKB-1');
  });

  it('throws ConfigError for invalid JSON', async () => {
    const p = join(workspace, 'broken.json');
    writeFileSync(p, '{not json}');
    await assert.rejects(loadConfig({ path: p, mode: 'strict' }), ConfigError);
  });
});

describe('loadConfig - JS', () => {
  it('loads a complete JS config (default export object)', async () => {
    const p = join(workspace, 'full.mjs');
    writeFileSync(
      p,
      `export default ${fullJson().replace(/"/g, '"')};`,
    );
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(config.ticket, 'AKB-1');
  });

  it('loads a JS config with function default export', async () => {
    const p = join(workspace, 'fn.mjs');
    writeFileSync(p, `export default () => (${fullJson()});`);
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(config.ticket, 'AKB-1');
  });

  it('rejects JS config without default export', async () => {
    const p = join(workspace, 'no-default.mjs');
    writeFileSync(p, `export const foo = 1;`);
    await assert.rejects(loadConfig({ path: p, mode: 'strict' }), /default export/i);
  });
});

describe('loadConfig - errors', () => {
  it('throws when path does not exist', async () => {
    await assert.rejects(loadConfig({ path: join(tmpdir(), 'no-such-file-xyz.yaml') }), /not found/i);
  });

  it('rejects unsupported file extensions', async () => {
    const p = join(workspace, 'config.xml');
    writeFileSync(p, '<config/>');
    await assert.rejects(loadConfig({ path: p, mode: 'strict' }), /Unsupported.*extension/i);
  });

  it('rejects directory path', async () => {
    const dir = join(workspace, 'as-dir');
    mkdirSync(dir);
    await assert.rejects(loadConfig({ path: dir }), /not a file/i);
  });

  it('throws in strict mode when fields are missing', async () => {
    const p = join(workspace, 'partial.yaml');
    writeFileSync(p, 'rus: [a]\nticket: AKB-1\n');
    await assert.rejects(loadConfig({ path: p, mode: 'strict' }), (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      return /Missing required field/.test(err.message) || err.details.some((d) => /Missing required field/.test(d));
    });
  });

  it('wraps schema violations in ConfigError with details', async () => {
    const p = join(workspace, 'invalid.json');
    writeFileSync(p, JSON.stringify({ rus: ['a'], ticket: 'not valid!' }));
    try {
      await loadConfig({ path: p, mode: 'strict' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok((err as ConfigError).details.length > 0);
      assert.match((err as ConfigError).format(), /ticket/i);
    }
  });
});

describe('loadConfig - frozen output', () => {
  it('returns a frozen config object', async () => {
    const p = join(workspace, 'full2.yaml');
    writeFileSync(p, fullYaml());
    const config = await loadConfig({ path: p, mode: 'strict' });
    assert.equal(Object.isFrozen(config), true);
  });
});

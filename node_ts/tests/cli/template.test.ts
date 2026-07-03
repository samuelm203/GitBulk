/**
 * Tests für `gitbulk template` (cli/template.ts).
 *
 * Kernzusicherung: BEIDE Vorlagen sind gültige GitBulk-Configs (durch das
 * echte Schema geparst) — damit kann man die Ausgabe direkt verwenden.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { generateTemplate, runTemplate } from '../../src/cli/template.js';
import { GitBulkConfigSchema } from '../../src/config/schema.js';

const workspace = mkdtempSync(join(tmpdir(), 'gitbulk-template-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('generateTemplate', () => {
  it('minimal template is a VALID GitBulk config', () => {
    const parsed: unknown = parseYaml(generateTemplate('minimal'));
    const result = GitBulkConfigSchema.safeParse(parsed);
    assert.equal(result.success, true, JSON.stringify(result.success ? {} : result.error.issues));
  });

  it('full template is a VALID GitBulk config', () => {
    const parsed: unknown = parseYaml(generateTemplate('full'));
    const result = GitBulkConfigSchema.safeParse(parsed);
    assert.equal(result.success, true, JSON.stringify(result.success ? {} : result.error.issues));
  });

  it('full contains optional fields that minimal omits', () => {
    const full = generateTemplate('full');
    const minimal = generateTemplate('minimal');
    for (const key of ['concurrency:', 'sourceBranch:', 'retry:', 'workspaceDir:']) {
      assert.ok(full.includes(key), `full should mention ${key}`);
      assert.ok(!minimal.includes(key), `minimal should NOT mention ${key}`);
    }
  });

  it('both templates carry the required fields', () => {
    for (const kind of ['full', 'minimal'] as const) {
      const text = generateTemplate(kind);
      for (const key of ['rus:', 'ticket:', 'branch:', 'commitMessage:', 'prSummary:', 'createPrOnError:', 'prPlatform:']) {
        assert.ok(text.includes(key), `${kind} should contain ${key}`);
      }
    }
  });

  it('never embeds a token field', () => {
    assert.doesNotMatch(generateTemplate('full'), /GITBULK_\w*TOKEN\s*:/);
  });

  it('every platform variant is a VALID GitBulk config (full + minimal)', () => {
    for (const platform of ['bitbucket', 'github', 'gitlab', 'azure-devops'] as const) {
      for (const kind of ['full', 'minimal'] as const) {
        const parsed: unknown = parseYaml(generateTemplate(kind, platform));
        const result = GitBulkConfigSchema.safeParse(parsed);
        assert.equal(
          result.success,
          true,
          `${kind}/${platform}: ${JSON.stringify(result.success ? {} : result.error.issues)}`,
        );
      }
    }
  });

  it('emits the matching platform block and token env var', () => {
    const gitlab = generateTemplate('full', 'gitlab');
    assert.match(gitlab, /prPlatform: gitlab/);
    assert.match(gitlab, /namespace: my-group/);
    assert.match(gitlab, /GITBULK_GITLAB_TOKEN/);
    assert.doesNotMatch(gitlab, /prPlatform: bitbucket/);

    const azure = generateTemplate('minimal', 'azure-devops');
    assert.match(azure, /prPlatform: azure-devops/);
    assert.match(azure, /organization: my-org/);
    assert.match(azure, /project: my-project/);
  });

  it('defaults to bitbucket when no platform is given', () => {
    assert.match(generateTemplate('full'), /prPlatform: bitbucket/);
  });
});

describe('runTemplate', () => {
  it('writes the template to a file and refuses to overwrite without --force', () => {
    const out = join(workspace, 'gitbulk.yaml');
    assert.equal(runTemplate({ kind: 'minimal', outputPath: out }), 0);
    assert.ok(existsSync(out));
    const first = readFileSync(out, 'utf8');
    assert.equal(first, generateTemplate('minimal'));

    // Zweiter Lauf ohne --force → Exit 3, Datei unverändert.
    assert.equal(runTemplate({ kind: 'full', outputPath: out }), 3);
    assert.equal(readFileSync(out, 'utf8'), first);

    // Mit --force → überschrieben.
    assert.equal(runTemplate({ kind: 'full', outputPath: out, force: true }), 0);
    assert.equal(readFileSync(out, 'utf8'), generateTemplate('full'));
  });
});

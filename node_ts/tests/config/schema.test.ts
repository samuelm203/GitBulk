/**
 * Unit-Tests für config/schema.ts.
 *
 * Testet das Schema mit gültigen und ungültigen Eingaben. Tests benötigen
 * ein existierendes Script-File (validateFilePath ist Teil des Schemas).
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitBulkConfigSchema, PartialGitBulkConfigSchema } from '../../src/config/schema.js';

const scriptPath = join(tmpdir(), `gitbulk-schema-test-${Date.now()}.sh`);

before(() => {
  writeFileSync(scriptPath, '#!/bin/sh\necho test\n', { mode: 0o755 });
});

after(() => {
  try {
    unlinkSync(scriptPath);
  } catch {
    /* schon weg */
  }
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rus: ['repo-a'],
    ticket: 'AKB-1234',
    branch: 'feature/test',
    script: scriptPath,
    commitMessage: 'feat: test',
    prSummary: 'Test PR',
    createPrOnError: false,
    prPlatform: 'bitbucket',
    bitbucket: {
      workspace: 'ws',
      apiVariant: 'cloud',
      targetBranch: 'master',
      reviewers: [],
    },
    ...overrides,
  };
}

describe('GitBulkConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig());
    assert.equal(result.success, true);
  });

  it('applies default values', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig());
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.sourceBranch, 'master');
      assert.equal(result.data.concurrency, 1);
      assert.equal(result.data.commandTimeoutMs, 120_000);
      assert.equal(result.data.dryRun, false);
      assert.equal(result.data.skipHooks, false);
      assert.equal(result.data.cloneIfMissing, false);
      assert.equal(result.data.retry.maxAttempts, 3);
      assert.equal(result.data.retry.backoffMs, 1000);
      assert.equal(result.data.retry.maxBackoffMs, 30_000);
    }
  });

  it('normalizes rus from comma-separated string to RuSpec[]', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ rus: 'a, b, c' }));
    assert.equal(result.success, true);
    if (result.success) assert.deepEqual(result.data.rus, [{ repo: 'a' }, { repo: 'b' }, { repo: 'c' }]);
  });

  it('normalizes mixed string + structured rus (per-RU workspace)', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ rus: ['repo-a', { repo: 'repo-b', workspace: 'other-ws' }] }),
    );
    assert.equal(result.success, true);
    if (result.success) {
      assert.deepEqual(result.data.rus, [
        { repo: 'repo-a' },
        { repo: 'repo-b', workspace: 'other-ws' },
      ]);
    }
  });

  it('rejects an invalid workspace name in a structured rus entry', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ rus: [{ repo: 'repo-a', workspace: 'bad/ws' }] }),
    );
    assert.equal(result.success, false);
  });

  it('rejects empty rus', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ rus: [] }));
    assert.equal(result.success, false);
  });

  it('rejects invalid ticket', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ ticket: 'invalid ticket!' }));
    assert.equal(result.success, false);
  });

  it('rejects invalid branch name', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ branch: '..bad' }));
    assert.equal(result.success, false);
  });

  it('rejects non-existent script file', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ script: join(tmpdir(), 'does-not-exist-xyz.sh') }),
    );
    assert.equal(result.success, false);
  });

  it('requires bitbucket config when prPlatform=bitbucket', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ bitbucket: undefined }));
    assert.equal(result.success, false);
    if (!result.success) {
      const hasBitbucketIssue = result.error.issues.some(
        (i) => i.path.includes('bitbucket') || i.message.includes('bitbucket'),
      );
      assert.ok(hasBitbucketIssue, 'expected an issue about missing bitbucket config');
    }
  });

  it('requires cloneBaseUrl when cloneIfMissing=true', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ cloneIfMissing: true }));
    assert.equal(result.success, false);
  });

  it('accepts cloneIfMissing with cloneBaseUrl', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({
        cloneIfMissing: true,
        cloneBaseUrl: 'https://bitbucket.org/my-ws',
      }),
    );
    assert.equal(result.success, true);
  });

  it('rejects concurrency out of bounds', () => {
    assert.equal(GitBulkConfigSchema.safeParse(validConfig({ concurrency: 0 })).success, false);
    assert.equal(GitBulkConfigSchema.safeParse(validConfig({ concurrency: 51 })).success, false);
  });

  it('rejects negative commandTimeoutMs', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ commandTimeoutMs: -1 }));
    assert.equal(result.success, false);
  });

  it('allows apiVariant: server', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({
        bitbucket: {
          workspace: 'PROJ',
          apiVariant: 'server',
          apiBaseUrl: 'https://bitbucket.company.com',
          targetBranch: 'master',
          reviewers: [],
        },
      }),
    );
    assert.equal(result.success, true);
  });

  it('rejects invalid apiVariant', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({
        bitbucket: {
          workspace: 'ws',
          apiVariant: 'github',
          targetBranch: 'master',
          reviewers: [],
        },
      }),
    );
    assert.equal(result.success, false);
  });

  it('returns frozen-safe object (no nested undefined)', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig());
    assert.equal(result.success, true);
    if (result.success) {
      // Schema should be assignable to JSON without surprises
      const json = JSON.stringify(result.data);
      assert.ok(json.length > 0);
    }
  });
});

describe('GitBulkConfigSchema - operations vs script', () => {
  const validMaven = {
    type: 'maven-add-dependency',
    groupId: 'org.apache.commons',
    artifactId: 'commons-lang3',
    version: '3.14.0',
  };

  it('accepts a config with operations instead of script', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ script: undefined, operations: [validMaven] }),
    );
    assert.equal(result.success, true);
  });

  it('rejects a config with neither script nor operations', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ script: undefined }));
    assert.equal(result.success, false);
  });

  it('rejects a config with an empty operations list (and no script)', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ script: undefined, operations: [] }),
    );
    assert.equal(result.success, false);
  });

  it('rejects a config with both script and operations', () => {
    const result = GitBulkConfigSchema.safeParse(validConfig({ operations: [validMaven] }));
    assert.equal(result.success, false);
  });

  it('rejects an unknown operation type', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({ script: undefined, operations: [{ type: 'does-not-exist' }] }),
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((i) => /unknown operation type/.test(i.message)));
    }
  });

  it('validates operation parameters against the registered schema', () => {
    const result = GitBulkConfigSchema.safeParse(
      validConfig({
        script: undefined,
        // groupId fehlt → maven-Schema schlägt fehl
        operations: [{ type: 'maven-add-dependency', artifactId: 'x', version: '1' }],
      }),
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((i) => i.path.includes('operations')));
    }
  });
});

describe('PartialGitBulkConfigSchema', () => {
  it('accepts a config with only some fields', () => {
    const result = PartialGitBulkConfigSchema.safeParse({
      ticket: 'AKB-1',
      branch: 'feature/x',
    });
    assert.equal(result.success, true);
  });

  it('accepts an empty object', () => {
    const result = PartialGitBulkConfigSchema.safeParse({});
    assert.equal(result.success, true);
  });

  it('still validates types of provided fields', () => {
    const result = PartialGitBulkConfigSchema.safeParse({ concurrency: 'not a number' });
    assert.equal(result.success, false);
  });
});

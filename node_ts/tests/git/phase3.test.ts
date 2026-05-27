/**
 * E2E-Tests für git/phase3.ts.
 *
 * Jeder Test setzt ein frisches Workspace mit Bare-Remote + Clone auf
 * und verifiziert das vollständige Verhalten gegen das echte Git.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPhase3 } from '../../src/git/phase3.js';
import { runGitChecked } from '../../src/git/executor.js';
import { setDefaultLogger, createLogger } from '../../src/utils/logger.js';
import type { GitBulkConfig } from '../../src/config/schema.js';
import {
  createWorkspace,
  cleanup,
  setupRu,
  writeShellScript,
} from '../helpers/git-fixtures.js';

before(() => {
  // Stille Logger für alle Phase-3-Tests
  setDefaultLogger(createLogger({ level: 'error', timestamps: false, noColor: true }));
});

function makeConfig(workspace: string, scriptPath: string, overrides: Partial<GitBulkConfig> = {}): GitBulkConfig {
  return {
    rus: ['repo-a'],
    ticket: 'AKB-1234',
    branch: 'feature/test',
    script: scriptPath,
    commitMessage: 'feat: test',
    prSummary: 'Test PR',
    createPrOnError: false,
    cloneIfMissing: false,
    sourceBranch: 'master',
    workspaceDir: workspace,
    retry: { maxAttempts: 2, backoffMs: 5, maxBackoffMs: 50 },
    concurrency: 1,
    commandTimeoutMs: 10_000,
    dryRun: false,
    skipHooks: false,
    prPlatform: 'bitbucket',
    bitbucket: { workspace: 'ws', apiVariant: 'cloud', targetBranch: 'master', reviewers: [] },
    ...overrides,
  } as GitBulkConfig;
}

describe('Phase 3 - 3.1 Existence check', () => {
  it('skips with empty prStatus when repo not found locally', async () => {
    const ws = createWorkspace();
    try {
      const config = makeConfig(ws, writeShellScript(ws, 'exit 0'), {
        rus: ['does-not-exist'],
      });
      const result = await runPhase3('does-not-exist', config);
      assert.equal(result.processed, false);
      assert.equal(result.prStatus, 'empty');
      assert.ok(result.notes.some((n) => n.includes('not found locally')));
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - 3.5a Code-Change with diff', () => {
  it('produces prStatus=create_PR and pushes feature branch', async () => {
    const ws = createWorkspace();
    try {
      const { remotePath, ruPath } = setupRu(ws, 'repo-a');
      const script = writeShellScript(ws, 'echo "modified" > new.txt');
      const config = makeConfig(ws, script);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.processed, true);
      assert.equal(result.prStatus, 'create_PR');
      assert.equal(result.cleanupOk, true);

      // Verify on remote
      const remoteBranches = await runGitChecked(['branch', '-a'], {
        cwd: remotePath,
        timeoutMs: 5000,
      });
      assert.match(remoteBranches.stdout, /AKB-1234-feature\/test/);

      // Verify local is back on master
      const localBranches = await runGitChecked(['branch'], { cwd: ruPath, timeoutMs: 5000 });
      assert.match(localBranches.stdout, /\* master/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - 3.5a Code-Change with no diff', () => {
  it('produces empty prStatus and deletes local feature branch', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      const script = writeShellScript(ws, 'exit 0');
      const config = makeConfig(ws, script);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'empty');
      assert.ok(result.notes.some((n) => n.includes('No Change')));

      // Feature branch should be deleted locally
      const branches = await runGitChecked(['branch'], { cwd: ruPath, timeoutMs: 5000 });
      assert.doesNotMatch(branches.stdout, /AKB-1234-feature\/test/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - 3.5b Code-Change fails with diff', () => {
  it('produces create_PR_with_Error and commits "ERROR WHILE CODE CHANGE"', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      // Script writes a file AND fails
      const script = writeShellScript(ws, 'echo "x" > broken.txt\nexit 1');
      const config = makeConfig(ws, script, { createPrOnError: true });

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'create_PR_with_Error');

      // Check commit message on remote
      const log = await runGitChecked(
        ['log', '-1', '--format=%s', 'origin/AKB-1234-feature/test'],
        { cwd: ruPath, timeoutMs: 5000 },
      );
      assert.match(log.stdout, /ERROR WHILE CODE CHANGE/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - 3.5b Code-Change fails with no diff', () => {
  it('produces empty prStatus with "No diff after failed" note', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'repo-a');
      const script = writeShellScript(ws, 'exit 1');
      const config = makeConfig(ws, script);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'empty');
      assert.ok(result.notes.some((n) => n.includes('No diff after failed')));
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - 3.2 Dirty working tree', () => {
  it('stashes uncommitted changes and restores them after run', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      writeFileSync(join(ruPath, 'dirty.txt'), 'uncommitted work');

      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const config = makeConfig(ws, script);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'create_PR');
      assert.equal(result.cleanupOk, true);
      assert.equal(existsSync(join(ruPath, 'dirty.txt')), true);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - Dry-run mode', () => {
  it('runs script but does not push to remote', async () => {
    const ws = createWorkspace();
    try {
      const { remotePath } = setupRu(ws, 'repo-a');
      const script = writeShellScript(ws, 'echo "x" > new.txt');
      const config = makeConfig(ws, script, { dryRun: true });

      const result = await runPhase3('repo-a', config);

      // Status is create_PR (dry-run pretends success)
      assert.equal(result.prStatus, 'create_PR');

      // Remote should NOT have the feature branch
      const remoteBranches = await runGitChecked(['branch'], {
        cwd: remotePath,
        timeoutMs: 5000,
      });
      assert.doesNotMatch(remoteBranches.stdout, /AKB-1234-feature\/test/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 - skipHooks', () => {
  it('bypasses pre-push hook when skipHooks=true', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');

      // Install pre-push hook that always blocks
      const hookPath = join(ruPath, '.git', 'hooks', 'pre-push');
      writeFileSync(hookPath, '#!/bin/sh\necho "BLOCKED" >&2\nexit 1\n', { mode: 0o755 });

      const script = writeShellScript(ws, 'echo "x" > new.txt');

      // Without skipHooks → push fails
      const r1 = await runPhase3('repo-a', makeConfig(ws, script));
      assert.notEqual(r1.prStatus, 'create_PR');

      // With skipHooks → push succeeds
      const r2 = await runPhase3('repo-a', makeConfig(ws, script, { skipHooks: true }));
      assert.equal(r2.prStatus, 'create_PR');
    } finally {
      cleanup(ws);
    }
  });
});

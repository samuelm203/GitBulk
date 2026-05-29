/**
 * E2E-Tests für den Operations-Pfad in git/phase3.ts (Schritt 2).
 *
 * Verifiziert die Verkettung deklarativer Operationen gegen echtes Git:
 *   - mehrere Operationen nacheinander (alle changed → create_PR)
 *   - gemischt changed/noop
 *   - Fehler in einer Operation → wie Exit-Code != 0 (ERROR WHILE CODE CHANGE)
 *   - kein Diff → empty prStatus, Branch gelöscht
 *   - echte Operation (maven-add-dependency) im Zusammenspiel
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { runPhase3 } from '../../src/git/phase3.js';
import { runGitChecked } from '../../src/git/executor.js';
import { setDefaultLogger, createLogger } from '../../src/utils/logger.js';
import type { GitBulkConfig } from '../../src/config/schema.js';
import {
  registerOperation,
  getOperation,
  type Operation,
} from '../../src/operations/types.js';
// Stellt sicher, dass die echte maven-add-dependency-Operation registriert ist.
import '../../src/operations/index.js';
import { createWorkspace, cleanup, setupRu } from '../helpers/git-fixtures.js';

before(() => {
  setDefaultLogger(createLogger({ level: 'error', timestamps: false, noColor: true }));
  registerTestOperations();
});

/**
 * Registriert ein paar minimal-invasive Test-Operationen in der globalen
 * Registry (idempotent, damit mehrfaches Laden nicht wirft).
 */
function registerTestOperations(): void {
  const register = <P>(op: Operation<P>): void => {
    if (!getOperation(op.type)) {
      registerOperation(op);
    }
  };

  // Schreibt eine Datei ins Repo → changed: true.
  register<{ fileName: string; content: string }>({
    type: 'test-write-file',
    description: 'writes a file (test only)',
    schema: z.object({ fileName: z.string(), content: z.string().default('x') }),
    apply: (params, ctx) => {
      writeFileSync(join(ctx.repoDir, params.fileName), params.content, 'utf8');
      return { changed: true, message: `wrote ${params.fileName}` };
    },
  });

  // Tut nichts → changed: false, kein Fehler.
  register<Record<string, never>>({
    type: 'test-noop',
    description: 'does nothing (test only)',
    schema: z.object({}),
    apply: () => ({ changed: false, message: 'noop' }),
  });

  // Liefert einen Fehler (optional mit vorheriger Datei-Änderung).
  register<{ writeFirst?: string | undefined }>({
    type: 'test-fail',
    description: 'reports an error (test only)',
    schema: z.object({ writeFirst: z.string().optional() }),
    apply: (params, ctx) => {
      let changed = false;
      if (params.writeFirst !== undefined) {
        writeFileSync(join(ctx.repoDir, params.writeFirst), 'broken', 'utf8');
        changed = true;
      }
      return { changed, message: 'failed', error: 'intentional test failure' };
    },
  });
}

/**
 * Wie das `makeConfig` der phase3-Tests, aber mit `operations` statt `script`.
 */
function makeOpConfig(
  workspace: string,
  operations: Array<{ type: string } & Record<string, unknown>>,
  overrides: Partial<GitBulkConfig> = {},
): GitBulkConfig {
  return {
    rus: ['repo-a'],
    ticket: 'AKB-1234',
    branch: 'feature/test',
    operations,
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

describe('Phase 3 operations - chaining (all changed)', () => {
  it('runs multiple operations in order and pushes the feature branch', async () => {
    const ws = createWorkspace();
    try {
      const { remotePath } = setupRu(ws, 'repo-a');
      const config = makeOpConfig(ws, [
        { type: 'test-write-file', fileName: 'a.txt', content: 'A' },
        { type: 'test-write-file', fileName: 'b.txt', content: 'B' },
      ]);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.processed, true);
      assert.equal(result.prStatus, 'create_PR');
      assert.equal(result.cleanupOk, true);

      const branches = await runGitChecked(['branch', '-a'], {
        cwd: remotePath,
        timeoutMs: 5000,
      });
      assert.match(branches.stdout, /AKB-1234-feature\/test/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 operations - mixed changed/noop', () => {
  it('treats the chain as a successful code change when at least one changes', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'repo-a');
      const config = makeOpConfig(ws, [
        { type: 'test-noop' },
        { type: 'test-write-file', fileName: 'c.txt', content: 'C' },
      ]);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'create_PR');
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 operations - error with diff', () => {
  it('commits "ERROR WHILE CODE CHANGE" when an operation reports an error', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      const config = makeOpConfig(
        ws,
        [
          { type: 'test-write-file', fileName: 'ok.txt', content: 'ok' },
          { type: 'test-fail' },
        ],
        { createPrOnError: true },
      );

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'create_PR_with_Error');
      assert.ok(result.notes.some((n) => n.includes('intentional test failure')));

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

describe('Phase 3 operations - no diff', () => {
  it('produces empty prStatus and deletes the branch when nothing changes', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath } = setupRu(ws, 'repo-a');
      const config = makeOpConfig(ws, [{ type: 'test-noop' }, { type: 'test-noop' }]);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'empty');
      assert.ok(result.notes.some((n) => n.includes('No Change')));

      const branches = await runGitChecked(['branch'], { cwd: ruPath, timeoutMs: 5000 });
      assert.doesNotMatch(branches.stdout, /AKB-1234-feature\/test/);
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 operations - error without diff', () => {
  it('produces empty prStatus with "No diff after failed" note', async () => {
    const ws = createWorkspace();
    try {
      setupRu(ws, 'repo-a');
      const config = makeOpConfig(ws, [{ type: 'test-fail' }]);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'empty');
      assert.ok(result.notes.some((n) => n.includes('No diff after failed')));
    } finally {
      cleanup(ws);
    }
  });
});

describe('Phase 3 operations - real maven-add-dependency', () => {
  it('adds a dependency to pom.xml and pushes the branch', async () => {
    const ws = createWorkspace();
    try {
      const { ruPath, remotePath } = setupRu(ws, 'repo-a');
      // pom.xml committen, damit der Source-Branch sauber ist.
      const pom = [
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
      ].join('\n');
      writeFileSync(join(ruPath, 'pom.xml'), pom, 'utf8');
      await runGitChecked(['add', '.'], { cwd: ruPath, timeoutMs: 5000 });
      await runGitChecked(['commit', '-m', 'add pom'], { cwd: ruPath, timeoutMs: 5000 });
      await runGitChecked(['push', 'origin', 'master'], { cwd: ruPath, timeoutMs: 5000 });

      const config = makeOpConfig(ws, [
        {
          type: 'maven-add-dependency',
          groupId: 'org.apache.commons',
          artifactId: 'commons-lang3',
          version: '3.14.0',
        },
      ]);

      const result = await runPhase3('repo-a', config);

      assert.equal(result.prStatus, 'create_PR');

      // pom.xml im Working Tree ist nach Cleanup wieder auf master-Stand
      // (ohne commons-lang3), die Änderung steckt im gepushten Branch.
      const onMaster = readFileSync(join(ruPath, 'pom.xml'), 'utf8');
      assert.ok(!onMaster.includes('commons-lang3'));

      const branches = await runGitChecked(['branch', '-a'], {
        cwd: remotePath,
        timeoutMs: 5000,
      });
      assert.match(branches.stdout, /AKB-1234-feature\/test/);
    } finally {
      cleanup(ws);
    }
  });
});

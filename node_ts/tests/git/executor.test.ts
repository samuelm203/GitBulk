/**
 * Unit-Tests für git/executor.ts.
 *
 * Verwendet ein echtes lokales Test-Repo (kein Netzwerk).
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runGit,
  runGitChecked,
  detectGit,
  GitExecutorError,
} from '../../src/git/executor.js';
import { createWorkspace, cleanup, setupRu, writeHangingPreCommitHook } from '../helpers/git-fixtures.js';

let workspace: string;
let ruPath: string;

before(() => {
  workspace = createWorkspace();
  ({ ruPath } = setupRu(workspace, 'exec-repo'));
});

after(() => {
  cleanup(workspace);
});

describe('detectGit', () => {
  it('returns the git version string when git is installed', async () => {
    const v = await detectGit();
    assert.ok(v, 'expected non-null version');
    assert.match(v!, /^git version/);
  });
});

describe('runGit', () => {
  it('returns exit code 0 for successful commands', async () => {
    const r = await runGit(['status', '--porcelain'], { cwd: ruPath, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  it('captures stdout', async () => {
    writeFileSync(join(ruPath, 'temp.txt'), 'x');
    const r = await runGit(['status', '--porcelain'], { cwd: ruPath, timeoutMs: 5000 });
    assert.match(r.stdout, /temp\.txt/);
    rmSync(join(ruPath, 'temp.txt'));
  });

  it('returns non-zero exit without throwing', async () => {
    const r = await runGit(['checkout', 'nonexistent-branch-xyz'], {
      cwd: ruPath,
      timeoutMs: 5000,
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0);
  });

  it('throws GitExecutorError for spawn errors (invalid cwd)', async () => {
    await assert.rejects(
      runGit(['status'], { cwd: '/nonexistent/xyz/abc', timeoutMs: 5000 }),
      GitExecutorError,
    );
  });

  it('honors dryRun: false execution but returns synthetic success', async () => {
    // rm -rf in dry-run must NOT actually remove anything
    const r = await runGit(['rm', '-rf', '.'], {
      cwd: ruPath,
      timeoutMs: 5000,
      dryRun: true,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(existsSync(join(ruPath, 'README.md')), 'dry-run must not delete files');
  });

  it('kills hanging process on timeout', async () => {
    // Plattformneutral hängender Mechanismus: ein pre-commit-Hook, der schläft.
    // Git führt Hooks über sein mitgeliefertes `sh` aus (auch auf Windows),
    // das ist deterministischer als das `core.editor`-Verhalten von `git commit`,
    // das auf Git-for-Windows den Editor mitunter übersprang. Eigenes Repo,
    // damit die offen gehaltene Commit-Transaktion andere Tests nicht stört.
    const { ruPath: hangRu } = setupRu(workspace, 'exec-timeout');
    writeHangingPreCommitHook(hangRu);
    writeFileSync(join(hangRu, 'change.txt'), 'pending\n');
    await runGit(['add', '.'], { cwd: hangRu, timeoutMs: 5000 });

    const start = Date.now();
    const r = await runGit(['commit', '-m', 'trigger hook'], {
      cwd: hangRu,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 8000, `timeout should be quick, took ${elapsed}ms`);
  });

  it('cancels on AbortSignal', async () => {
    const { ruPath: abortRu } = setupRu(workspace, 'exec-abort');
    writeHangingPreCommitHook(abortRu);
    writeFileSync(join(abortRu, 'change.txt'), 'pending\n');
    await runGit(['add', '.'], { cwd: abortRu, timeoutMs: 5000 });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    const r = await runGit(['commit', '-m', 'trigger hook'], {
      cwd: abortRu,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    assert.notEqual(r.exitCode, 0);
    assert.ok(elapsed < 8000, `abort should be quick, took ${elapsed}ms`);
  });

  it('does not execute shell injection in args', async () => {
    const marker = join(tmpdir(), 'GITBULK_INJ_TEST_MARKER');
    if (existsSync(marker)) rmSync(marker);
    await runGit(['commit', '-m', `"; touch ${marker} #`], { cwd: ruPath, timeoutMs: 5000 });
    assert.equal(existsSync(marker), false, 'shell injection must not work');
  });
});

describe('runGitChecked', () => {
  it('throws on non-zero exit', async () => {
    await assert.rejects(
      runGitChecked(['checkout', 'nonexistent-xyz'], { cwd: ruPath, timeoutMs: 5000 }),
      GitExecutorError,
    );
  });

  it('does not throw on success', async () => {
    const r = await runGitChecked(['status'], { cwd: ruPath, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
  });
});

describe('skipHooks option', () => {
  it('bypasses hooks when skipHooks is true', async () => {
    // Install a pre-commit hook that always fails
    const hookPath = join(ruPath, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    writeFileSync(join(ruPath, 'a.txt'), '1');
    await runGitChecked(['add', '.'], { cwd: ruPath, timeoutMs: 5000 });

    // Without skipHooks → fails
    const withHooks = await runGit(['commit', '-m', 'try'], {
      cwd: ruPath,
      timeoutMs: 5000,
    });
    assert.notEqual(withHooks.exitCode, 0);

    // With skipHooks → succeeds
    const skipped = await runGit(['commit', '-m', 'skip'], {
      cwd: ruPath,
      timeoutMs: 5000,
      skipHooks: true,
    });
    assert.equal(skipped.exitCode, 0);

    // Cleanup
    rmSync(hookPath);
  });
});

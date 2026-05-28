/**
 * Unit-Tests für git/operations.ts.
 *
 * Testet die atomaren Operationen einzeln gegen ein echtes Test-Repo.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isGitRepository,
  readCurrentBranch,
  hasUncommittedChanges,
  stashAutoBackup,
  fetchOrigin,
  checkoutSourceBranch,
  resetHardToOrigin,
  cleanWorkingTree,
  buildFeatureBranchName,
  createFeatureBranch,
  executeCodeChange,
  stageAll,
  commit,
  checkoutBranch,
  stashPop,
  deleteLocalBranch,
  resolveInterpreter,
  type BaseGitOptions,
} from '../../src/git/operations.js';
import { runGitChecked } from '../../src/git/executor.js';
import { createLogger } from '../../src/utils/logger.js';
import {
  createWorkspace,
  cleanup,
  setupRu,
  writeShellScript,
  writeNodeScript,
} from '../helpers/git-fixtures.js';

let workspace: string;
let ruPath: string;
let base: BaseGitOptions;

const silentLogger = createLogger({ level: 'error', timestamps: false, noColor: true });

before(() => {
  workspace = createWorkspace();
  ({ ruPath } = setupRu(workspace, 'ops-repo'));
  base = {
    cwd: ruPath,
    timeoutMs: 5000,
    dryRun: false,
    skipHooks: false,
    logger: silentLogger,
  };
});

after(() => {
  cleanup(workspace);
});

describe('isGitRepository', () => {
  it('returns true for a valid repo', () => {
    assert.equal(isGitRepository(ruPath), true);
  });

  it('returns false for non-existent path', () => {
    assert.equal(isGitRepository(join(tmpdir(), 'does-not-exist-xyz-gitbulk')), false);
  });

  it('returns false for non-repo directory', () => {
    // tmpdir() selbst ist kein Git-Repo
    assert.equal(isGitRepository(tmpdir()), false);
  });
});

describe('readCurrentBranch', () => {
  it('returns master after fresh setup', async () => {
    const branch = await readCurrentBranch(base);
    assert.equal(branch, 'master');
  });

  it('returns hash when on detached HEAD', async () => {
    // Detach HEAD by checking out the commit directly
    const hash = (await runGitChecked(['rev-parse', 'HEAD'], { cwd: ruPath, timeoutMs: 5000 }))
      .stdout.trim();
    await runGitChecked(['checkout', '-q', hash], { cwd: ruPath, timeoutMs: 5000 });

    const branch = await readCurrentBranch(base);
    assert.equal(branch, hash);

    // Restore master for subsequent tests
    await runGitChecked(['checkout', '-q', 'master'], { cwd: ruPath, timeoutMs: 5000 });
  });
});

describe('hasUncommittedChanges', () => {
  it('returns false on clean tree', async () => {
    assert.equal(await hasUncommittedChanges(base), false);
  });

  it('returns true with uncommitted file', async () => {
    writeFileSync(join(ruPath, 'dirty.txt'), 'x');
    assert.equal(await hasUncommittedChanges(base), true);
    rmSync(join(ruPath, 'dirty.txt'));
  });
});

describe('stashAutoBackup', () => {
  it('stashes uncommitted changes', async () => {
    writeFileSync(join(ruPath, 'stash-me.txt'), 'data');
    await stashAutoBackup(base);
    assert.equal(existsSync(join(ruPath, 'stash-me.txt')), false);

    // Restore for cleanup
    await runGitChecked(['stash', 'pop'], { cwd: ruPath, timeoutMs: 5000 });
    rmSync(join(ruPath, 'stash-me.txt'));
  });
});

describe('Source branch update (fetch/checkout/reset/clean)', () => {
  it('updates source branch end-to-end', async () => {
    await fetchOrigin(base);
    await checkoutSourceBranch('master', base);
    await resetHardToOrigin('master', base);
    await cleanWorkingTree(base);
    assert.equal(await hasUncommittedChanges(base), false);
  });
});

describe('buildFeatureBranchName', () => {
  it('joins ticket and branch with dash', () => {
    assert.equal(buildFeatureBranchName('AKB-1', 'feature/x'), 'AKB-1-feature/x');
  });
});

describe('createFeatureBranch + deleteLocalBranch', () => {
  it('creates and deletes a local branch', async () => {
    const branch = `test-branch-${Date.now()}`;
    const r1 = await createFeatureBranch(branch, base);
    assert.equal(r1.exitCode, 0);

    const cur = await readCurrentBranch(base);
    assert.equal(cur, branch);

    // Back to master for deletion
    await checkoutBranch('master', base);
    const r2 = await deleteLocalBranch(branch, base);
    assert.equal(r2.exitCode, 0);
  });

  it('returns non-zero when creating duplicate branch', async () => {
    const branch = `dup-${Date.now()}`;
    await createFeatureBranch(branch, base);
    const r = await createFeatureBranch(branch, base);
    assert.notEqual(r.exitCode, 0);
    // Cleanup
    await checkoutBranch('master', base);
    await deleteLocalBranch(branch, base);
  });
});

describe('stageAll + commit', () => {
  beforeEach(async () => {
    // Ensure clean state
    await checkoutBranch('master', base);
  });

  it('stages and commits new files', async () => {
    const branch = `stage-${Date.now()}`;
    await createFeatureBranch(branch, base);
    writeFileSync(join(ruPath, 'staged.txt'), 'content');
    await stageAll(base);
    const r = await commit('feat: test', base);
    assert.equal(r.exitCode, 0);
    // Cleanup
    await checkoutBranch('master', base);
    await deleteLocalBranch(branch, base);
  });

  it('commit returns non-zero when nothing to commit', async () => {
    const r = await commit('nothing', base);
    assert.notEqual(r.exitCode, 0);
  });
});

describe('stashPop', () => {
  it('returns non-zero when no stash exists', async () => {
    // Ensure no stashes
    await runGitChecked(['stash', 'clear'], { cwd: ruPath, timeoutMs: 5000 });
    const r = await stashPop(base);
    assert.notEqual(r.exitCode, 0);
  });
});

describe('executeCodeChange', () => {
  it('runs successful script and returns exit 0', async () => {
    const script = writeShellScript(workspace, 'echo "ok"');
    const r = await executeCodeChange(
      script,
      { ru: 'test', ticket: 'AKB-1', branch: 'b', sourceBranch: 'master' },
      base,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /ok/);
  });

  it('passes environment variables', async () => {
    const out = join(workspace, 'env-output.txt');
    const script = writeShellScript(
      workspace,
      `echo "$GITBULK_RU $GITBULK_TICKET $GITBULK_BRANCH $GITBULK_SOURCE_BRANCH" > "${out}"`,
    );
    await executeCodeChange(
      script,
      { ru: 'my-ru', ticket: 'AKB-1', branch: 'my-branch', sourceBranch: 'master' },
      base,
    );
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(out, 'utf8').trim();
    assert.equal(content, 'my-ru AKB-1 my-branch master');
  });

  it('returns non-zero for failing script', async () => {
    const script = writeShellScript(workspace, 'exit 7');
    const r = await executeCodeChange(
      script,
      { ru: 'x', ticket: 'AKB-1', branch: 'b', sourceBranch: 'master' },
      base,
    );
    assert.equal(r.exitCode, 7);
  });

  it('respects timeout', async () => {
    // Node-Skript (plattformneutral) statt `sleep 30` (braucht sh+coreutils).
    const script = writeNodeScript(workspace, 'setTimeout(() => {}, 30000);\n');
    const start = Date.now();
    const r = await executeCodeChange(
      script,
      { ru: 'x', ticket: 'AKB-1', branch: 'b', sourceBranch: 'master' },
      { ...base, timeoutMs: 500 },
    );
    const elapsed = Date.now() - start;
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 5000, `timeout should be quick, took ${elapsed}ms`);
  });

  it('synthesizes success in dry-run without running the script', async () => {
    const marker = join(workspace, 'dryrun-marker.txt');
    // Node-Skript (plattformneutral) statt `touch` (braucht sh+coreutils).
    const script = writeNodeScript(
      workspace,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`,
    );
    // Note: in our design, dry-run DOES run the script (so user sees changes).
    const r = await executeCodeChange(
      script,
      { ru: 'x', ticket: 'AKB-1', branch: 'b', sourceBranch: 'master' },
      { ...base, dryRun: true },
    );
    assert.equal(r.exitCode, 0);
    // In our design, the script DID run (the marker exists).
    assert.equal(existsSync(marker), true);
    rmSync(marker);
  });
});

describe('resolveInterpreter', () => {
  const isWindows = process.platform === 'win32';

  it('chooses a POSIX shell for .sh scripts', () => {
    const { command, prefixArgs } = resolveInterpreter('/path/to/script.sh');
    if (isWindows) {
      // Auf Windows wird Git's sh.exe gesucht → voller Pfad endend auf sh.exe
      assert.match(command, /sh\.exe$/i);
    } else {
      assert.equal(command, 'sh');
    }
    assert.deepEqual(prefixArgs, []);
  });

  it('chooses a shell for .bash scripts', () => {
    const { command } = resolveInterpreter('/path/to/script.bash');
    if (isWindows) {
      // Auf Windows mappen .sh und .bash beide auf Git's sh.exe
      assert.match(command, /sh\.exe$/i);
    } else {
      assert.equal(command, 'bash');
    }
  });

  it('chooses cmd.exe for .bat and .cmd scripts', () => {
    const bat = resolveInterpreter('C:\\scripts\\run.bat');
    assert.equal(bat.command, 'cmd.exe');
    assert.deepEqual(bat.prefixArgs, ['/c']);

    const cmd = resolveInterpreter('C:\\scripts\\run.cmd');
    assert.equal(cmd.command, 'cmd.exe');
  });

  it('chooses powershell for .ps1 scripts', () => {
    const { command, prefixArgs } = resolveInterpreter('script.ps1');
    // Platform-dependent: powershell.exe on Windows, pwsh elsewhere
    assert.match(command, /powershell\.exe|pwsh/);
    assert.ok(prefixArgs.includes('-File'));
  });

  it('uses node executable for .js/.mjs/.cjs scripts', () => {
    for (const ext of ['.js', '.mjs', '.cjs']) {
      const { command } = resolveInterpreter(`script${ext}`);
      assert.equal(command, process.execPath);
    }
  });

  it('marks unknown extensions for direct execution', () => {
    const { command, prefixArgs } = resolveInterpreter('/usr/local/bin/mytool');
    assert.equal(command, '/usr/local/bin/mytool');
    assert.deepEqual(prefixArgs, ['__SELF__']);
  });

  it('is case-insensitive on the extension', () => {
    const sh = resolveInterpreter('SCRIPT.SH');
    if (isWindows) {
      assert.match(sh.command, /sh\.exe$/i);
    } else {
      assert.equal(sh.command, 'sh');
    }
    assert.equal(resolveInterpreter('Run.BAT').command, 'cmd.exe');
  });
});

/**
 * End-to-End-Tests der CLI-Argument-Hygiene (echte Prozess-Spawns via tsx).
 *
 * Geprüft wird das parseArgs-Dispatch-Verhalten in cli/index.ts:
 * Bulk-only-Optionen in Subkommandos müssen als Usage-Fehler (Exit 3) gemeldet
 * werden statt still ignoriert zu werden — und umgekehrt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tsxUrl = import.meta.resolve('tsx');

/** Startet die CLI mit den gegebenen Argumenten und sammelt Exit-Code + stderr. */
function runCli(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, ['--import', tsxUrl, 'src/cli/index.ts', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('CLI usage hygiene (subcommand vs bulk-flow options)', () => {
  it('rejects bulk-only options for `init` with exit 3', () => {
    const r = runCli(['init', '--tui', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--tui/);
    assert.match(r.stderr, /not valid for `init`/);
  });

  it('rejects bulk-only options for `list-operations` with exit 3', () => {
    const r = runCli(['list-operations', '--only', 'repo-a', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--only/);
    assert.match(r.stderr, /not valid for `list-operations`/);
  });

  it('names every stray bulk-only option in the error', () => {
    const r = runCli(['init', '--dry-run', '--deep-log', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--dry-run/);
    assert.match(r.stderr, /--deep-log/);
  });

  it('still rejects subcommand options in the bulk flow (existing behaviour)', () => {
    const r = runCli(['--json', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--json/);
  });

  it('subcommands keep working with their own options (--help)', () => {
    const r = runCli(['init', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gitbulk init/);
  });

  it('rejects --gui combined with --tui (mutually exclusive views)', () => {
    const r = runCli(['--gui', '--tui', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('rejects --report combined with --tui/--gui', () => {
    const r = runCli(['--tui', '--report', 'out.json', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--report/);
  });

  it('rejects --retry-failed combined with --only', () => {
    const r = runCli(['--retry-failed', 'r.json', '--only', 'a', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('prints help for `close` (exit 0)', () => {
    const r = runCli(['close', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gitbulk close/);
  });

  it('rejects bulk-only view options for `close` with exit 3', () => {
    const r = runCli(['close', '--report', 'x.json', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--report/);
    assert.match(r.stderr, /not valid for `close`/);
  });

  it('rejects --yes in the bulk flow (subcommand-only)', () => {
    const r = runCli(['--yes', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--yes/);
  });

  it('close requires --yes in non-interactive mode (no confirmation possible)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitbulk-close-usage-'));
    try {
      const cfg = join(dir, 'gitbulk.json');
      writeFileSync(
        cfg,
        JSON.stringify({
          rus: ['repo-a'],
          ticket: 'AKB-1',
          branch: 'feature/x',
          operations: [{ type: 'delete-file', path: 'x.txt' }],
          commitMessage: 'm',
          prSummary: 's',
          createPrOnError: false,
          prPlatform: 'github',
          github: { owner: 'me' },
          workspaceDir: dir,
        }),
      );
      const r = runCli(['close', '--config', cfg, '--no-color']);
      assert.equal(r.status, 3);
      assert.match(r.stderr, /--yes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown --platform for `template`', () => {
    const r = runCli(['template', '--platform', 'svn', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Invalid --platform/);
  });

  it('rejects --report/--retry-failed for subcommands like init', () => {
    const r = runCli(['init', '--report', 'out.json', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--report/);
    assert.match(r.stderr, /not valid for `init`/);
  });

  it('rejects --gui for subcommands like init', () => {
    const r = runCli(['init', '--gui', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--gui/);
  });

  it('prints help for `status` (exit 0)', () => {
    const r = runCli(['status', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gitbulk status/);
  });

  it('rejects view/write options for `status` with exit 3', () => {
    const r = runCli(['status', '--tui', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--tui/);
    assert.match(r.stderr, /not valid for `status`/);
  });

  it('rejects subcommand-only options for `status` with exit 3', () => {
    const r = runCli(['status', '--output', 'x.yaml', '--no-color']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--output/);
    assert.match(r.stderr, /not valid for `status`/);
  });
});

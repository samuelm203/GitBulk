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

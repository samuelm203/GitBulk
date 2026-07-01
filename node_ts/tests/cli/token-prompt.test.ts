/**
 * Unit-Tests für den Auth-Guard (cli/token-prompt.ts).
 *
 * Der maskierte readline-Prompt selbst ist terminal-only und wird hier über
 * die injizierbare `prompt`-Funktion umgangen (kein echtes TTY nötig).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prTokenEnvVar, ensurePrToken } from '../../src/cli/token-prompt.js';

describe('prTokenEnvVar', () => {
  it('maps platforms to their env var', () => {
    assert.equal(prTokenEnvVar('bitbucket'), 'GITBULK_BITBUCKET_TOKEN');
    assert.equal(prTokenEnvVar('github'), 'GITBULK_GITHUB_TOKEN');
    assert.equal(prTokenEnvVar('gitlab'), 'GITBULK_GITLAB_TOKEN');
    assert.equal(prTokenEnvVar('azure-devops'), 'GITBULK_AZURE_DEVOPS_TOKEN');
  });

  it('azure-devops prompts like any other platform and sets the env var', async () => {
    const env: NodeJS.ProcessEnv = {};
    let prompted = false;
    const res = await ensurePrToken('azure-devops', {
      interactive: true,
      env,
      readStored: () => undefined,
      prompt: () => {
        prompted = true;
        return Promise.resolve('pat-entered');
      },
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(prompted, true, 'the adapter is implemented → the guard must prompt');
    assert.equal(env.GITBULK_AZURE_DEVOPS_TOKEN, 'pat-entered');
  });
});

describe('ensurePrToken', () => {
  // `readStored: () => undefined` macht die env/prompt-Tests hermetisch —
  // unabhängig davon, ob auf dem Rechner echte Credentials gespeichert sind.
  const noStored = (): undefined => undefined;

  it('is ok when the token env var is already set', async () => {
    const env = { GITBULK_GITHUB_TOKEN: 'gh-xyz' };
    const res = await ensurePrToken('github', { interactive: false, env, readStored: noStored });
    assert.deepEqual(res, { ok: true });
  });

  it('treats a blank env var as missing', async () => {
    const env = { GITBULK_GITHUB_TOKEN: '   ' };
    const res = await ensurePrToken('github', { interactive: false, env, readStored: noStored });
    assert.equal(res.ok, false);
  });

  it('errors (no prompt) in non-interactive mode when missing', async () => {
    const env: NodeJS.ProcessEnv = {};
    const res = await ensurePrToken('bitbucket', { interactive: false, env, readStored: noStored });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /GITBULK_BITBUCKET_TOKEN/);
      assert.match(res.error, /required/i);
    }
  });

  it('uses a stored token when the env var is missing (env still wins if set)', async () => {
    const env: NodeJS.ProcessEnv = {};
    const res = await ensurePrToken('bitbucket', {
      interactive: false,
      env,
      readStored: () => 'stored-bb',
    });
    assert.deepEqual(res, { ok: true });
    // Der gespeicherte Token landet (getrimmt) in der Env für den Adapter.
    assert.equal(env.GITBULK_BITBUCKET_TOKEN, 'stored-bb');
  });

  it('prefers the env var over a stored token', async () => {
    const env: NodeJS.ProcessEnv = { GITBULK_BITBUCKET_TOKEN: 'from-env' };
    const res = await ensurePrToken('bitbucket', {
      interactive: false,
      env,
      readStored: () => 'stored-bb',
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(env.GITBULK_BITBUCKET_TOKEN, 'from-env');
  });

  it('prompts in interactive mode and stores the entered token in env', async () => {
    const env: NodeJS.ProcessEnv = {};
    let askedVar = '';
    const res = await ensurePrToken('github', {
      interactive: true,
      env,
      readStored: noStored,
      prompt: (varName) => {
        askedVar = varName;
        return Promise.resolve('  entered-token  ');
      },
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(askedVar, 'GITBULK_GITHUB_TOKEN');
    // Token wird (getrimmt) im env gesetzt — nie geloggt/gespeichert.
    assert.equal(env.GITBULK_GITHUB_TOKEN, 'entered-token');
  });

  it('errors when the interactive prompt yields an empty token', async () => {
    const env: NodeJS.ProcessEnv = {};
    const res = await ensurePrToken('github', {
      interactive: true,
      env,
      readStored: noStored,
      prompt: () => Promise.resolve('   '),
    });
    assert.equal(res.ok, false);
    assert.equal(env.GITBULK_GITHUB_TOKEN, undefined);
  });
});

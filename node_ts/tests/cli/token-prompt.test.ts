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
    // Azure-Adapter ist nicht implementiert → kein Token-Prompt; der Nutzer
    // soll sofort die "not implemented"-Meldung des Adapters sehen.
    assert.equal(prTokenEnvVar('azure-devops'), undefined);
  });

  it('azure-devops passes the guard without prompting (adapter reports itself)', async () => {
    let prompted = false;
    const res = await ensurePrToken('azure-devops', {
      interactive: true,
      env: {},
      prompt: () => {
        prompted = true;
        return Promise.resolve('never');
      },
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(prompted, false, 'must not prompt for an unimplemented platform');
  });
});

describe('ensurePrToken', () => {
  it('is ok when the token env var is already set', async () => {
    const env = { GITBULK_GITHUB_TOKEN: 'gh-xyz' };
    const res = await ensurePrToken('github', { interactive: false, env });
    assert.deepEqual(res, { ok: true });
  });

  it('treats a blank env var as missing', async () => {
    const env = { GITBULK_GITHUB_TOKEN: '   ' };
    const res = await ensurePrToken('github', { interactive: false, env });
    assert.equal(res.ok, false);
  });

  it('errors (no prompt) in non-interactive mode when missing', async () => {
    const env: NodeJS.ProcessEnv = {};
    const res = await ensurePrToken('bitbucket', { interactive: false, env });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /GITBULK_BITBUCKET_TOKEN/);
      assert.match(res.error, /required/i);
    }
  });

  it('prompts in interactive mode and stores the entered token in env', async () => {
    const env: NodeJS.ProcessEnv = {};
    let askedVar = '';
    const res = await ensurePrToken('github', {
      interactive: true,
      env,
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
      prompt: () => Promise.resolve('   '),
    });
    assert.equal(res.ok, false);
    assert.equal(env.GITBULK_GITHUB_TOKEN, undefined);
  });
});

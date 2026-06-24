/**
 * Tests für cli/auth.ts — `gitbulk auth login|logout|status`.
 * Token-Eingabe ist injiziert; Speicherort via GITBULK_HOME im Temp-Verzeichnis.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuth } from '../../src/cli/auth.js';
import { readStoredToken, deleteStoredToken } from '../../src/cli/credentials.js';

const home = mkdtempSync(join(tmpdir(), 'gitbulk-auth-'));
const env = (): NodeJS.ProcessEnv => ({ GITBULK_HOME: home });

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => deleteStoredToken('all', env()));

describe('runAuth', () => {
  it('login stores a token via the injected prompt', async () => {
    const e = env();
    const code = await runAuth({
      action: 'login',
      platform: 'bitbucket',
      interactive: true,
      env: e,
      promptToken: () => Promise.resolve('secret-token'),
    });
    assert.equal(code, 0);
    assert.equal(readStoredToken('bitbucket', e), 'secret-token');
  });

  it('login without --platform fails with exit 3', async () => {
    const code = await runAuth({
      action: 'login',
      interactive: true,
      env: env(),
      promptToken: () => Promise.resolve('x'),
    });
    assert.equal(code, 3);
  });

  it('login with an empty token saves nothing (exit 3)', async () => {
    const e = env();
    const code = await runAuth({
      action: 'login',
      platform: 'github',
      interactive: true,
      env: e,
      promptToken: () => Promise.resolve('   '),
    });
    assert.equal(code, 3);
    assert.equal(readStoredToken('github', e), undefined);
  });

  it('logout removes a stored platform token', async () => {
    const e = env();
    await runAuth({
      action: 'login',
      platform: 'bitbucket',
      interactive: true,
      env: e,
      promptToken: () => Promise.resolve('t'),
    });
    const code = await runAuth({ action: 'logout', platform: 'bitbucket', interactive: false, env: e });
    assert.equal(code, 0);
    assert.equal(readStoredToken('bitbucket', e), undefined);
  });

  it('status returns 0 without throwing', async () => {
    const code = await runAuth({ action: 'status', interactive: false, env: env() });
    assert.equal(code, 0);
  });
});

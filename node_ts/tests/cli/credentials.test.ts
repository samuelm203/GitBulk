/**
 * Tests für cli/credentials.ts — persistenter Token-Store.
 * Der Speicherort wird über GITBULK_HOME in ein Temp-Verzeichnis umgelenkt.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

import {
  readStoredToken,
  writeStoredToken,
  deleteStoredToken,
  listStoredPlatforms,
  credentialsPath,
} from '../../src/cli/credentials.js';

const home = mkdtempSync(join(tmpdir(), 'gitbulk-cred-'));
const env = { GITBULK_HOME: home } as NodeJS.ProcessEnv;

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => deleteStoredToken('all', env));

describe('credentials store', () => {
  it('round-trips a token per platform', () => {
    assert.equal(readStoredToken('bitbucket', env), undefined);
    writeStoredToken('bitbucket', 'bb-tok', env);
    writeStoredToken('github', 'gh-tok', env);
    assert.equal(readStoredToken('bitbucket', env), 'bb-tok');
    assert.equal(readStoredToken('github', env), 'gh-tok');
    assert.deepEqual([...listStoredPlatforms(env)].sort(), ['bitbucket', 'github']);
  });

  it('stores the file under GITBULK_HOME, never inside a repo', () => {
    writeStoredToken('bitbucket', 'x', env);
    assert.ok(credentialsPath(env).startsWith(home));
    assert.ok(existsSync(credentialsPath(env)));
  });

  it('writes the file with 0600 permissions', { skip: osPlatform() === 'win32' }, () => {
    writeStoredToken('bitbucket', 'x', env);
    assert.equal(statSync(credentialsPath(env)).mode & 0o777, 0o600);
  });

  it('deletes one platform and then the whole file', () => {
    writeStoredToken('bitbucket', 'a', env);
    writeStoredToken('github', 'b', env);
    assert.equal(deleteStoredToken('github', env), true);
    assert.equal(readStoredToken('github', env), undefined);
    assert.equal(readStoredToken('bitbucket', env), 'a');
    assert.equal(deleteStoredToken('all', env), true);
    assert.equal(existsSync(credentialsPath(env)), false);
    assert.equal(deleteStoredToken('all', env), false); // schon weg
  });

  it('treats a corrupt file as empty (no throw)', () => {
    writeStoredToken('bitbucket', 'a', env);
    // Datei mit Müll überschreiben → read darf nicht werfen.
    writeFileSync(credentialsPath(env), 'not json{{{');
    assert.equal(readStoredToken('bitbucket', env), undefined);
    assert.deepEqual(listStoredPlatforms(env), []);
  });
});

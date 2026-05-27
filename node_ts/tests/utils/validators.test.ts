/**
 * Unit-Tests für utils/validators.ts.
 *
 * Validatoren sind reine Funktionen ohne Seiteneffekte → einfache Tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateFilePath,
  validateMessage,
  validateYesNo,
  sanitizeBranchName,
} from '../../src/utils/validators.js';

describe('validateRuList', () => {
  it('accepts comma-separated string', () => {
    const r = validateRuList('repo-a, repo-b, repo-c');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, ['repo-a', 'repo-b', 'repo-c']);
  });

  it('accepts array of strings', () => {
    const r = validateRuList(['a', 'b']);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, ['a', 'b']);
  });

  it('trims whitespace and filters empty entries', () => {
    const r = validateRuList(['  a  ', '', '   ', 'b']);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, ['a', 'b']);
  });

  it('rejects empty string', () => {
    const r = validateRuList('');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /RU list is missing/);
  });

  it('rejects empty array', () => {
    const r = validateRuList([]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /RU list is missing/);
  });

  it('rejects array of only whitespace', () => {
    const r = validateRuList(['  ', '\t']);
    assert.equal(r.ok, false);
  });
});

describe('validateBranchName', () => {
  it('accepts simple branch name', () => {
    const r = validateBranchName('feature/login');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'feature/login');
  });

  it('accepts single character', () => {
    const r = validateBranchName('x');
    assert.equal(r.ok, true);
  });

  it('replaces whitespace with dashes', () => {
    const r = validateBranchName('my new branch');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'my-new-branch');
  });

  it('strips forbidden characters', () => {
    const r = validateBranchName('feature/test?*');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'feature/test');
  });

  it('rejects double dots', () => {
    const r = validateBranchName('feat..bug');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Invalid branch name/);
  });

  it('rejects leading slash', () => {
    const r = validateBranchName('/abc');
    assert.equal(r.ok, false);
  });

  it('rejects only forbidden characters', () => {
    const r = validateBranchName('***');
    assert.equal(r.ok, false);
  });

  it('rejects empty after sanitization', () => {
    const r = validateBranchName('   ');
    assert.equal(r.ok, false);
  });
});

describe('sanitizeBranchName', () => {
  it('collapses multiple dashes', () => {
    assert.equal(sanitizeBranchName('foo---bar'), 'foo-bar');
  });

  it('trims leading and trailing dashes', () => {
    assert.equal(sanitizeBranchName('-foo-bar-'), 'foo-bar');
  });

  it('handles all transformations together', () => {
    assert.equal(sanitizeBranchName('  Feature **  X  '), 'Feature-X');
  });
});

describe('validateTicket', () => {
  it('accepts AKB-1234 format', () => {
    const r = validateTicket('AKB-1234');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'AKB-1234');
  });

  it('uppercases the input', () => {
    const r = validateTicket('akb-1234');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'AKB-1234');
  });

  it('rejects spaces', () => {
    const r = validateTicket('AKB 1234');
    assert.equal(r.ok, false);
  });

  it('rejects special chars', () => {
    const r = validateTicket('AKB#1234');
    assert.equal(r.ok, false);
  });

  it('rejects empty', () => {
    const r = validateTicket('');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /missing/i);
  });

  it('accepts pure number', () => {
    const r = validateTicket('1234');
    assert.equal(r.ok, true);
  });
});

describe('validateFilePath', () => {
  it('resolves existing file to absolute path', () => {
    // /etc/hostname existiert auf Linux-CI
    const r = validateFilePath('/etc/hostname');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, '/etc/hostname');
  });

  it('rejects non-existent file', () => {
    const r = validateFilePath('/tmp/does-not-exist-xyz-12345.txt');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /File not found/);
  });

  it('rejects directory', () => {
    const r = validateFilePath('/tmp');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not a file/);
  });

  it('rejects empty path', () => {
    const r = validateFilePath('');
    assert.equal(r.ok, false);
  });
});

describe('validateMessage', () => {
  it('accepts normal message', () => {
    const r = validateMessage('feat: hello');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'feat: hello');
  });

  it('trims whitespace', () => {
    const r = validateMessage('  hi  ');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'hi');
  });

  it('rejects whitespace-only', () => {
    const r = validateMessage('   \t\n   ');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /empty/i);
  });

  it('rejects empty', () => {
    const r = validateMessage('');
    assert.equal(r.ok, false);
  });
});

describe('validateYesNo', () => {
  it('accepts Y, y, YES, yes', () => {
    for (const v of ['Y', 'y', 'YES', 'yes', 'Yes']) {
      const r = validateYesNo(v);
      assert.equal(r.ok, true, `expected "${v}" to be valid`);
      if (r.ok) assert.equal(r.value, true);
    }
  });

  it('accepts N, n, NO, no', () => {
    for (const v of ['N', 'n', 'NO', 'no', 'No']) {
      const r = validateYesNo(v);
      assert.equal(r.ok, true, `expected "${v}" to be valid`);
      if (r.ok) assert.equal(r.value, false);
    }
  });

  it('rejects anything else', () => {
    for (const v of ['maybe', 'true', '1', '', 'YN']) {
      const r = validateYesNo(v);
      assert.equal(r.ok, false, `expected "${v}" to be rejected`);
    }
  });
});

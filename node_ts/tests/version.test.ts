/**
 * Stellt sicher, dass die exportierte `VERSION` (und damit `gitbulk --version`)
 * zur Laufzeit aus der package.json kommt und nie wieder davon abdriftet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VERSION } from '../src/index.js';

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it('is a non-empty dotted version', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
  });

  it('was actually read from package.json (not the error fallback)', () => {
    // Beweist, dass der Lesepfad funktioniert hat und nicht still in den
    // try/catch-Fallback gefallen ist.
    assert.notEqual(VERSION, '0.0.0');
  });
});

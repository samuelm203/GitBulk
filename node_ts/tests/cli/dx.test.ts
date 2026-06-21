/**
 * Tests für die DX-Features (Paket B):
 *   - filterRus (`--only`)
 *   - collectOperationInfos (`gitbulk list-operations`)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterRus } from '../../src/cli/filter-rus.js';
import { collectOperationInfos } from '../../src/cli/list-operations.js';
import type { GitBulkConfig } from '../../src/config/schema.js';

/** Minimal-Config mit den gegebenen RUs (nur das für filterRus Nötige). */
function makeConfig(rus: string[]): GitBulkConfig {
  return { rus: rus.map((repo) => ({ repo })) } as unknown as GitBulkConfig;
}

describe('filterRus', () => {
  it('returns the config unchanged when only is undefined or empty', () => {
    const cfg = makeConfig(['a', 'b']);
    assert.equal(filterRus(cfg, undefined), cfg);
    assert.equal(filterRus(cfg, ''), cfg);
    assert.equal(filterRus(cfg, '   '), cfg);
  });

  it('keeps only the requested RUs, preserving config order', () => {
    const cfg = makeConfig(['a', 'b', 'c']);
    // Reihenfolge der --only-Eingabe ist egal; die Config-Reihenfolge gewinnt.
    const out = filterRus(cfg, 'c, a');
    assert.deepEqual(out.rus, [{ repo: 'a' }, { repo: 'c' }]);
    assert.notEqual(out, cfg, 'should return a new frozen object');
    assert.ok(Object.isFrozen(out));
  });

  it('trims whitespace and ignores empty entries', () => {
    const cfg = makeConfig(['a', 'b']);
    assert.deepEqual(filterRus(cfg, ' a , , b ').rus, [{ repo: 'a' }, { repo: 'b' }]);
  });

  it('throws on unknown RU names', () => {
    const cfg = makeConfig(['a', 'b']);
    assert.throws(() => filterRus(cfg, 'a,nope'), /unknown RU\(s\): nope/);
  });

  it('throws when nothing remains (only commas)', () => {
    const cfg = makeConfig(['a']);
    // Nur Whitespace/Kommas → wie "kein Filter" → unverändert (kein Wurf).
    assert.equal(filterRus(cfg, ' , , '), cfg);
  });
});

describe('collectOperationInfos', () => {
  it('lists every registered operation with type, description and params', () => {
    const infos = collectOperationInfos();
    const types = infos.map((i) => i.type);

    for (const expected of [
      'add-file',
      'replace-file',
      'delete-file',
      'regex-replace',
      'maven-add-dependency',
    ]) {
      assert.ok(types.includes(expected), `expected operation "${expected}" to be listed`);
    }

    for (const info of infos) {
      assert.ok(info.description.length > 0, `${info.type} should have a description`);
      assert.ok(Array.isArray(info.params));
    }
  });

  it('derives parameter specs from the Zod schema (regex-replace)', () => {
    const regex = collectOperationInfos().find((i) => i.type === 'regex-replace');
    assert.ok(regex, 'regex-replace should be present');
    const byName = new Map(regex.params.map((p) => [p.name, p]));

    assert.equal(byName.get('pattern')?.required, true);
    assert.equal(byName.get('flags')?.required, false);
    assert.equal(byName.get('flags')?.defaultValue, 'g');
    assert.equal(byName.get('requireMatch')?.kind, 'boolean');
  });
});

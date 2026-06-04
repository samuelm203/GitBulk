/**
 * Tests für die Spezial-CLI-Flags (`-fish`/`-fisch`, `-owner`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fishHelp, ownerEasterEgg, handleSpecialFlags } from '../../src/cli/special-flags.js';

describe('handleSpecialFlags', () => {
  it('returns the command matrix for -fish/-fisch/--fish/--fisch', () => {
    for (const flag of ['-fish', '-fisch', '--fish', '--fisch']) {
      const out = handleSpecialFlags([flag], false);
      assert.ok(out, `expected output for ${flag}`);
      assert.match(out, /command & option matrix/);
      assert.match(out, /gitbulk init/);
      assert.match(out, /list-operations/);
    }
  });

  it('returns the owner easter egg for -owner/--owner', () => {
    for (const flag of ['-owner', '--owner']) {
      const out = handleSpecialFlags([flag], false);
      assert.ok(out, `expected output for ${flag}`);
      assert.match(out, /GITHUB: samuelm203/);
    }
  });

  it('returns undefined for normal args', () => {
    assert.equal(handleSpecialFlags(['--config', 'x.yaml'], false), undefined);
    assert.equal(handleSpecialFlags([], false), undefined);
  });

  it('emits ANSI codes only when color is enabled', () => {
    // eslint-disable-next-line no-control-regex
    const ansi = /\[/;
    assert.doesNotMatch(fishHelp(false), ansi);
    assert.match(fishHelp(true), ansi);
    assert.doesNotMatch(ownerEasterEgg(false), ansi);
    assert.match(ownerEasterEgg(true), ansi);
  });
});


import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveInterpreter } from '../src/git/operations.js';

describe('resolveInterpreter', () => {
  it('resolves .mjs files to process.execPath', () => {
    const scriptPath = 'C:\\test\\script.mjs';
    const result = resolveInterpreter(scriptPath);
    
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.prefixArgs, []);
  });

  it('resolves .js files to process.execPath', () => {
    const scriptPath = 'C:\\test\\script.js';
    const result = resolveInterpreter(scriptPath);
    
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.prefixArgs, []);
  });

  it('resolves .cjs files to process.execPath', () => {
    const scriptPath = 'C:\\test\\script.cjs';
    const result = resolveInterpreter(scriptPath);
    
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.prefixArgs, []);
  });
});

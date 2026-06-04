/**
 * Tests für das handgepflegte JSON-Schema (schema/gitbulk.config.schema.json).
 *
 * Ziel: sicherstellen, dass die Datei valides JSON ist, die erwartete Struktur
 * hat und mit dem echten Zod-Schema in Sachen Pflichtfeldern übereinstimmt
 * (eine Beispiel-Config, die das JSON-Schema erfüllt, validiert auch gegen Zod).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GitBulkConfigSchema } from '../../src/config/schema.js';

const schemaUrl = new URL('../../schema/gitbulk.config.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as {
  required: string[];
  properties: Record<string, unknown>;
};

describe('gitbulk.config.schema.json', () => {
  it('is valid JSON with the expected top-level required fields', () => {
    assert.deepEqual(
      [...schema.required].sort(),
      ['branch', 'commitMessage', 'createPrOnError', 'prPlatform', 'prSummary', 'rus', 'ticket'].sort(),
    );
  });

  it('documents the platform sub-objects and the code-change fields', () => {
    for (const key of ['rus', 'operations', 'script', 'bitbucket', 'github', 'azureDevOps', 'prPlatform']) {
      assert.ok(key in schema.properties, `expected property "${key}" in JSON schema`);
    }
  });

  it('a config satisfying the JSON-schema required fields also validates against Zod', () => {
    const sample = {
      rus: ['repo-a'],
      ticket: 'AKB-1234',
      branch: 'feature/x',
      operations: [{ type: 'add-file', path: 'NOTES.md', content: 'hi' }],
      commitMessage: 'chore: bump',
      prSummary: 'Bump deps',
      createPrOnError: false,
      prPlatform: 'github',
      github: { owner: 'my-org' },
    };
    const result = GitBulkConfigSchema.safeParse(sample);
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
  });
});

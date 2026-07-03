/**
 * Tests für die gradle-add-dependency-Operation: Groovy- + Kotlin-DSL,
 * Top-Level-Block-Erkennung (buildscript wird ignoriert), Idempotenz,
 * Fehlerpfade und das generierte .mjs-Skript (end-to-end).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import gradleAddDependency from '../../src/operations/gradle-add-dependency.js';
import type { Operation, OperationContext, OperationResult } from '../../src/operations/types.js';
import { generateScript } from '../../src/cli/script-generator.js';

function makeCtx(repoDir: string): OperationContext {
  return { repoDir, ru: 'test-repo', ticket: 'AKB-1', branch: 'AKB-1-x', sourceBranch: 'master' };
}

async function run<P>(
  op: Operation<P>,
  repoDir: string,
  params: Record<string, unknown>,
): Promise<OperationResult> {
  const parsed = op.schema.parse(params);
  return op.apply(parsed, makeCtx(repoDir));
}

const GROOVY_BUILD = `plugins {
    id 'java'
}

dependencies {
    implementation 'org.slf4j:slf4j-api:2.0.0'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
}
`;

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gitbulk-gradle-'));
});

describe('gradle-add-dependency', () => {
  it('adds a Groovy-DSL dependency after the opening line with detected indent', async () => {
    writeFileSync(join(ws, 'build.gradle'), GROOVY_BUILD);
    const r = await run(gradleAddDependency, ws, {
      group: 'org.apache.commons',
      name: 'commons-lang3',
      version: '3.14.0',
    });
    assert.equal(r.changed, true);
    const text = readFileSync(join(ws, 'build.gradle'), 'utf8');
    assert.match(text, /\n {4}implementation 'org\.apache\.commons:commons-lang3:3\.14\.0'\n/);
    // Bestehende Dependencies bleiben unangetastet.
    assert.match(text, /slf4j-api:2\.0\.0/);
  });

  it('uses Kotlin-DSL syntax for .kts build files', async () => {
    writeFileSync(join(ws, 'build.gradle.kts'), 'dependencies {\n    implementation("a:b:1")\n}\n');
    const r = await run(gradleAddDependency, ws, {
      group: 'org.apache.commons',
      name: 'commons-lang3',
      version: '3.14.0',
      buildFilePath: 'build.gradle.kts',
    });
    assert.equal(r.changed, true);
    const text = readFileSync(join(ws, 'build.gradle.kts'), 'utf8');
    assert.match(text, /implementation\("org\.apache\.commons:commons-lang3:3\.14\.0"\)/);
  });

  it('honors a custom configuration', async () => {
    writeFileSync(join(ws, 'build.gradle'), 'dependencies {\n}\n');
    await run(gradleAddDependency, ws, {
      group: 'org.junit.jupiter',
      name: 'junit-jupiter',
      version: '5.10.0',
      configuration: 'testImplementation',
    });
    const text = readFileSync(join(ws, 'build.gradle'), 'utf8');
    assert.match(text, /testImplementation 'org\.junit\.jupiter:junit-jupiter:5\.10\.0'/);
  });

  it('is idempotent when group:name is already present (any version)', async () => {
    writeFileSync(join(ws, 'build.gradle'), GROOVY_BUILD);
    const r = await run(gradleAddDependency, ws, {
      group: 'org.slf4j',
      name: 'slf4j-api',
      version: '9.9.9',
    });
    assert.equal(r.changed, false);
    assert.match(r.message, /already present/);
    // bestehende Version bleibt unangetastet
    assert.match(readFileSync(join(ws, 'build.gradle'), 'utf8'), /slf4j-api:2\.0\.0/);
  });

  it('ignores an indented dependencies block (e.g. inside buildscript)', async () => {
    const withBuildscript = `buildscript {
    dependencies {
        classpath 'com.android.tools.build:gradle:8.0.0'
    }
}

dependencies {
    implementation 'a:b:1'
}
`;
    writeFileSync(join(ws, 'build.gradle'), withBuildscript);
    const r = await run(gradleAddDependency, ws, { group: 'x', name: 'y', version: '1' });
    assert.equal(r.changed, true);
    const text = readFileSync(join(ws, 'build.gradle'), 'utf8');
    // Die neue Zeile steht im TOP-LEVEL-Block (nach dessen öffnender Zeile),
    // nicht im buildscript-Block.
    const topLevelIdx = text.indexOf('\ndependencies {');
    assert.ok(text.indexOf("implementation 'x:y:1'") > topLevelIdx);
  });

  it('skips when the build file is missing', async () => {
    const r = await run(gradleAddDependency, ws, { group: 'g', name: 'n', version: '1' });
    assert.equal(r.changed, false);
    assert.match(r.message, /No build\.gradle/);
  });

  it('errors when there is no top-level dependencies block', async () => {
    writeFileSync(join(ws, 'build.gradle'), "plugins {\n    id 'java'\n}\n");
    const r = await run(gradleAddDependency, ws, { group: 'g', name: 'n', version: '1' });
    assert.equal(r.changed, false);
    assert.ok(r.error);
    assert.match(r.error, /top-level dependencies block/);
  });
});

describe('generated .mjs script (end-to-end)', () => {
  it('adds the dependency from generated code and is idempotent', () => {
    writeFileSync(join(ws, 'build.gradle'), GROOVY_BUILD);

    const { code, unsupported } = generateScript([
      {
        type: 'gradle-add-dependency',
        params: {
          group: 'org.apache.commons',
          name: 'commons-lang3',
          version: '3.14.0',
          configuration: 'implementation',
          buildFilePath: 'build.gradle',
        },
      },
    ]);
    assert.deepEqual(unsupported, []);

    const scriptPath = join(ws, 'change.mjs');
    writeFileSync(scriptPath, code);
    const res = spawnSync(process.execPath, [scriptPath], { cwd: ws, encoding: 'utf8' });
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);
    const text = readFileSync(join(ws, 'build.gradle'), 'utf8');
    assert.match(text, /implementation 'org\.apache\.commons:commons-lang3:3\.14\.0'/);

    // Zweiter Lauf: idempotent (keine zweite Zeile).
    const res2 = spawnSync(process.execPath, [scriptPath], { cwd: ws, encoding: 'utf8' });
    assert.equal(res2.status, 0, `script failed: ${res2.stderr}`);
    const matches = readFileSync(join(ws, 'build.gradle'), 'utf8').match(/commons-lang3/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

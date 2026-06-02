/**
 * Tests für das Operations-Fundament und die maven-add-dependency-Operation.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  registerOperation,
  getOperation,
  listOperationTypes,
  listOperations,
  _clearRegistryForTests,
  type Operation,
  type OperationContext,
} from '../../src/operations/types.js';
import { z } from 'zod';

// ── Hilfsfunktionen ────────────────────────────────────────────────

function makeCtx(repoDir: string): OperationContext {
  return {
    repoDir,
    ru: 'test-repo',
    ticket: 'AKB-1',
    branch: 'AKB-1-feature/x',
    sourceBranch: 'master',
  };
}

// ── Registry-Tests ─────────────────────────────────────────────────

describe('operations registry', () => {
  beforeEach(() => {
    _clearRegistryForTests();
  });

  after(() => {
    _clearRegistryForTests();
  });

  it('registers and retrieves an operation', () => {
    const op: Operation<{ x: number }> = {
      type: 'test-op',
      description: 'a test op',
      schema: z.object({ x: z.number() }),
      apply: () => ({ changed: true, message: 'ok' }),
    };
    registerOperation(op);
    assert.equal(getOperation('test-op')?.type, 'test-op');
  });

  it('returns undefined for unknown type', () => {
    assert.equal(getOperation('does-not-exist'), undefined);
  });

  it('throws on duplicate registration', () => {
    const op: Operation<unknown> = {
      type: 'dup',
      description: 'd',
      schema: z.unknown(),
      apply: () => ({ changed: false, message: '' }),
    };
    registerOperation(op);
    assert.throws(() => registerOperation(op), /already registered/);
  });

  it('lists registered types sorted', () => {
    const mk = (t: string): Operation<unknown> => ({
      type: t,
      description: t,
      schema: z.unknown(),
      apply: () => ({ changed: false, message: '' }),
    });
    registerOperation(mk('zebra'));
    registerOperation(mk('alpha'));
    assert.deepEqual(listOperationTypes(), ['alpha', 'zebra']);
  });

  it('lists operations with descriptions', () => {
    registerOperation({
      type: 'op-a',
      description: 'does A',
      schema: z.unknown(),
      apply: () => ({ changed: false, message: '' }),
    });
    const list = listOperations();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.type, 'op-a');
    assert.equal(list[0]!.description, 'does A');
  });
});

// ── maven-add-dependency-Tests ─────────────────────────────────────

describe('maven-add-dependency operation', () => {
  let workspace: string;
  // Die Operation registriert sich beim Import — wir laden sie frisch.
  let mavenOp: Operation<never>;

  before(async () => {
    // Frischer Import nach evtl. Registry-Clear: direkt das Modul ziehen.
    const mod = await import('../../src/operations/maven-add-dependency.js');
    mavenOp = mod.default as unknown as Operation<never>;
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'gitbulk-mavenop-'));
  });

  after(() => {
    // aufräumen passiert pro Test via rmSync unten nicht nötig; tmp wird recycelt
  });

  function writePom(content: string): void {
    writeFileSync(join(workspace, 'pom.xml'), content, 'utf8');
  }
  function readPom(): string {
    return readFileSync(join(workspace, 'pom.xml'), 'utf8');
  }

  const params = {
    groupId: 'org.apache.commons',
    artifactId: 'commons-lang3',
    version: '3.14.0',
    pomPath: 'pom.xml',
  };

  it('adds a dependency to a simple pom (2-space indent)', async () => {
    writePom(
      [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>junit</groupId>',
        '      <artifactId>junit</artifactId>',
        '      <version>4.13.2</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    );
    const r = await mavenOp.apply(params as never, makeCtx(workspace));
    assert.equal(r.changed, true);
    const pom = readPom();
    assert.ok(pom.includes('<artifactId>commons-lang3</artifactId>'));
    // Tags balanciert
    const opens = (pom.match(/<dependency>/g) ?? []).length;
    const closes = (pom.match(/<\/dependency>/g) ?? []).length;
    assert.equal(opens, closes);
    assert.equal(opens, 2);
    // Korrekte Einrückung: <dependency> mit 4 Spaces (wie das vorhandene)
    assert.ok(pom.includes('    <dependency>\n      <groupId>org.apache.commons'));
  });

  it('rejects a pomPath that escapes the repo (path traversal)', async () => {
    writePom('<project>\n  <dependencies>\n  </dependencies>\n</project>\n');
    const r = await mavenOp.apply({ ...params, pomPath: '../evil.xml' } as never, makeCtx(workspace));
    assert.equal(r.changed, false);
    assert.ok(r.error, 'expected an error for an escaping pomPath');
    assert.match(r.error ?? '', /escapes/i);
  });

  it('is idempotent: does not add an existing dependency', async () => {
    writePom(
      [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.apache.commons</groupId>',
        '      <artifactId>commons-lang3</artifactId>',
        '      <version>3.12.0</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    );
    const before = readPom();
    const r = await mavenOp.apply(params as never, makeCtx(workspace));
    assert.equal(r.changed, false);
    assert.equal(readPom(), before, 'file must be unchanged');
  });

  it('adds to the project block, not dependencyManagement', async () => {
    writePom(
      [
        '<project>',
        '  <dependencyManagement>',
        '    <dependencies>',
        '      <dependency>',
        '        <groupId>org.springframework</groupId>',
        '        <artifactId>spring-core</artifactId>',
        '        <version>6.1.0</version>',
        '      </dependency>',
        '    </dependencies>',
        '  </dependencyManagement>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>junit</groupId>',
        '      <artifactId>junit</artifactId>',
        '      <version>4.13.2</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    );
    const r = await mavenOp.apply(params as never, makeCtx(workspace));
    assert.equal(r.changed, true);
    const pom = readPom();
    // Die neue Dependency muss NACH </dependencyManagement> stehen.
    const mgmtClose = pom.indexOf('</dependencyManagement>');
    const newDep = pom.indexOf('commons-lang3');
    assert.ok(newDep > mgmtClose, 'dependency must be in the project block');
  });

  it('returns changed:false when no pom.xml exists', async () => {
    // workspace ist leer
    const r = await mavenOp.apply(params as never, makeCtx(workspace));
    assert.equal(r.changed, false);
    assert.ok(!r.error, 'missing pom is not an error');
  });

  it('returns an error when there is no project dependencies block', async () => {
    writePom(
      [
        '<project>',
        '  <dependencyManagement>',
        '    <dependencies>',
        '      <dependency>',
        '        <groupId>x</groupId>',
        '        <artifactId>y</artifactId>',
        '        <version>1</version>',
        '      </dependency>',
        '    </dependencies>',
        '  </dependencyManagement>',
        '</project>',
        '',
      ].join('\n'),
    );
    const r = await mavenOp.apply(params as never, makeCtx(workspace));
    assert.equal(r.changed, false);
    assert.ok(r.error, 'expected an error');
    assert.match(r.error!, /project-level <dependencies>/);
  });

  it('adds an optional scope when provided', async () => {
    writePom(
      [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>junit</groupId>',
        '      <artifactId>junit</artifactId>',
        '      <version>4.13.2</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    );
    const r = await mavenOp.apply(
      { ...params, scope: 'test' } as never,
      makeCtx(workspace),
    );
    assert.equal(r.changed, true);
    assert.ok(readPom().includes('<scope>test</scope>'));
  });

  it('validates parameters via its schema', () => {
    const result = mavenOp.schema.safeParse({ groupId: '', artifactId: 'x', version: '1' });
    assert.equal(result.success, false);
  });
});

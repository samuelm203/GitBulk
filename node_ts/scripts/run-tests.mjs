/**
 * Plattform- und versionsneutraler Test-Runner.
 *
 * Hintergrund: Der eingebaute Node-Test-Runner löst Glob-Muster für Test-
 * Dateien erst ab Node 22 selbst auf. Auf Node 20 wird das Muster wörtlich
 * genommen ("Could not find ...tests\...\test.ts"), und auf Windows
 * expandiert auch die Shell keine Globs. Deshalb lösen wir die Testdateien
 * hier selbst auf (via rekursivem readdir, verfügbar seit Node 18.17) und
 * starten den eingebauten Test-Runner programmatisch über die node:test API.
 *
 * Aufruf: `node --import tsx scripts/run-tests.mjs`
 *
 * Exit-Code: 0 bei Erfolg, 1 bei mindestens einem fehlgeschlagenen Test.
 */

import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { run } from 'node:test';
import { spec as Spec } from 'node:test/reporters';

const TESTS_DIR = 'tests';

// Alle *.test.ts-Dateien rekursiv einsammeln und auf POSIX-Trenner normalisieren
// (für stabile, plattformunabhängige Pfade an den Runner).
const testFiles = readdirSync(TESTS_DIR, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith('.test.ts'))
  .map((entry) => join(TESTS_DIR, entry));

if (testFiles.length === 0) {
  console.error(`No test files found under ${TESTS_DIR}${sep}`);
  process.exit(1);
}

let failures = 0;

const stream = run({
  files: testFiles,
  // concurrency: false lässt Dateien seriell laufen, damit die git-lastigen
  // Tests sich nicht über temporäre Repos in die Quere kommen.
  concurrency: false,
});

stream.on('test:fail', () => {
  failures++;
});

// Spec-Reporter für menschenlesbare Ausgabe (wie --test-reporter=spec).
stream.compose(new Spec()).pipe(process.stdout);

// Erst wenn der Test-Stream vollständig durchgelaufen ist, steht das
// Ergebnis fest. Dann den Exit-Code setzen (1 = mind. ein Fehler).
stream.on('end', () => {
  process.exitCode = failures > 0 ? 1 : 0;
});

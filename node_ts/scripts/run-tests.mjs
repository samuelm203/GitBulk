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
 * Aufruf: `node --import tsx scripts/run-tests.mjs [--watch] [--coverage]`
 *
 * Flags (optional):
 *   --watch      Tests im Watch-Modus laufen lassen (re-run bei Änderungen).
 *   --coverage   Code-Coverage erfassen und am Ende ausgeben.
 *                ACHTUNG: Coverage braucht Node >= 22 (run()-Coverage-Option);
 *                auf Node 20 wird das Flag ignoriert (mit Hinweis).
 *
 * Exit-Code: 0 bei Erfolg, 1 bei mindestens einem fehlgeschlagenen Test.
 */

import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { run } from 'node:test';
import { spec as Spec } from 'node:test/reporters';

const TESTS_DIR = 'tests';

// ── CLI-Flags ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
let coverage = argv.includes('--coverage');

// Coverage existiert in der run()-API erst ab Node 22. Auf Node 20 würde die
// Option fehlschlagen — dort bewusst deaktivieren und Hinweis ausgeben.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (coverage && nodeMajor < 22) {
  console.warn('[run-tests] --coverage requires Node >= 22; running without coverage.');
  coverage = false;
}

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

const runOptions = {
  files: testFiles,
  // concurrency: false lässt Dateien seriell laufen, damit die git-lastigen
  // Tests sich nicht über temporäre Repos in die Quere kommen.
  concurrency: false,
};
if (watch) runOptions.watch = true;
if (coverage) {
  runOptions.coverage = true;
  // Nur den eigenen Quellcode messen, nicht node_modules/Tests/Helper.
  runOptions.coverageExcludeGlobs = ['tests/**', 'scripts/**', 'node_modules/**', 'dist/**'];
}

const stream = run(runOptions);

stream.on('test:fail', () => {
  failures++;
});

// Spec-Reporter für menschenlesbare Ausgabe (wie --test-reporter=spec).
// Bei aktiver Coverage hängt der Reporter automatisch den Coverage-Report an.
stream.compose(new Spec()).pipe(process.stdout);

// Erst wenn der Test-Stream vollständig durchgelaufen ist, steht das
// Ergebnis fest. Dann den Exit-Code setzen (1 = mind. ein Fehler).
// Im Watch-Modus läuft der Stream weiter — dort wird kein Exit-Code gesetzt.
stream.on('end', () => {
  if (!watch) {
    process.exitCode = failures > 0 ? 1 : 0;
  }
});

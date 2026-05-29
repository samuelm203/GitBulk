/**
 * Git-Test-Fixtures.
 *
 * Stellt Helfer bereit, um isolierte Test-Repositories aufzusetzen:
 *   - `setupBareRemote`  → leeres Bare-Repo als "Remote"
 *   - `setupRu`          → Bare-Remote + lokaler Clone mit initialem Commit
 *   - `cleanup`          → Aufräumen am Ende eines Tests
 *
 * Alle Funktionen arbeiten in einem temporären Verzeichnis, damit Tests
 * parallel laufen können, ohne sich gegenseitig zu stören.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Erzeugt ein frisches temporäres Workspace-Verzeichnis.
 * Pfad enthält ein zufälliges Suffix, sodass parallele Tests sich nicht stören.
 */
export function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'gitbulk-test-'));
}

/**
 * Löscht ein Workspace-Verzeichnis (rekursiv, fehlertolerant).
 */
export function cleanup(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Führt einen Git-Befehl synchron im gegebenen Verzeichnis aus.
 * Wirft bei Exit != 0. Für Tests, wo wir uns nicht um Fehler kümmern müssen.
 */
function git(args: string, cwd: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

/**
 * Setzt ein leeres Bare-Repository als "Remote" auf.
 *
 * @param workspace - Wurzelverzeichnis
 * @param name      - Name des Repos (ohne .git-Suffix)
 * @returns Pfad zum Bare-Repo (mit .git-Suffix)
 */
export function setupBareRemote(workspace: string, name: string): string {
  const remoteDir = join(workspace, `${name}.git`);
  mkdirSync(remoteDir);
  git('init --bare -q --initial-branch=master', remoteDir);
  return remoteDir;
}

/**
 * Setzt eine vollständige RU auf:
 *   1. Bare-Remote
 *   2. Lokaler Clone
 *   3. Initialer Commit auf master
 *   4. Push zu Remote
 *
 * @param workspace - Wurzelverzeichnis
 * @param name      - Name der RU
 * @returns Pfade zum Remote und zum lokalen Clone
 */
export function setupRu(
  workspace: string,
  name: string,
): { remotePath: string; ruPath: string } {
  const remotePath = setupBareRemote(workspace, name);
  const ruPath = join(workspace, name);

  git(`clone -q "${remotePath}" "${ruPath}"`, workspace);
  git('config user.email "test@example.com"', ruPath);
  git('config user.name "Test User"', ruPath);

  writeFileSync(join(ruPath, 'README.md'), '# initial\n');
  git('add .', ruPath);
  git('commit -q -m "init"', ruPath);
  git('push -q origin master', ruPath);

  return { remotePath, ruPath };
}

/**
 * Schreibt ein ausführbares Shell-Skript.
 *
 * @param workspace - Wo das Skript abgelegt wird
 * @param shellContent - Inhalt OHNE Shebang (wird automatisch ergänzt)
 * @returns Absoluter Pfad zum Skript
 */
export function writeShellScript(workspace: string, shellContent: string): string {
  const path = join(workspace, `script-${Math.random().toString(36).slice(2, 10)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${shellContent}\n`, { mode: 0o755 });
  return path;
}

/**
 * Schreibt ein Node-Skript, das einfach lange schläft (30s).
 *
 * Plattformneutral nutzbar als "hängender Prozess" für Timeout-/Abort-Tests,
 * da es über `process.execPath` (Node) läuft und kein `sh` benötigt.
 *
 * @returns Absoluter Pfad zum .mjs-Skript
 */
export function writeHangingNodeScript(workspace: string): string {
  const path = join(workspace, `hang-${Math.random().toString(36).slice(2, 10)}.mjs`);
  // setTimeout hält den Event-Loop 30s am Leben
  writeFileSync(path, `setTimeout(() => {}, 30000);\n`);
  return path;
}

/**
 * Installiert einen `pre-commit`-Hook im RU, der 30 s schläft (also hängt).
 *
 * Plattformneutral zuverlässig: Git führt Hooks über sein mitgeliefertes `sh`
 * aus — auch auf Windows. Damit lässt sich der Timeout-/Kill-Pfad von `runGit`
 * deterministisch testen (ein anschließendes `git commit` hängt im Hook), ohne
 * vom plattformabhängigen `core.editor`-Verhalten abzuhängen.
 *
 * @param ruPath - Pfad zum (geklonten) Repository
 * @returns Absoluter Pfad zum Hook
 */
export function writeHangingPreCommitHook(ruPath: string): string {
  const hookPath = join(ruPath, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  return hookPath;
}

/**
 * Schreibt ein Node-Skript (.mjs), das den gegebenen JS-Body ausführt.
 *
 * Plattformneutral: läuft über `resolveInterpreter` → `process.execPath`,
 * funktioniert also identisch auf Windows, Linux, macOS. Ideal für
 * `executeCodeChange`-Tests, die sonst von `sh`/`sleep`/`touch` abhingen.
 *
 * Im Body verfügbar:
 *   - `process.env.GITBULK_*` (die vom Executor gesetzten Variablen)
 *   - normale Node-APIs (fs, etc.)
 *
 * @param workspace - Ablageort
 * @param jsBody    - JavaScript-Code, der im Skript ausgeführt wird
 * @returns Absoluter Pfad zum .mjs-Skript
 */
export function writeNodeScript(workspace: string, jsBody: string): string {
  const path = join(workspace, `node-script-${Math.random().toString(36).slice(2, 10)}.mjs`);
  writeFileSync(path, jsBody);
  return path;
}

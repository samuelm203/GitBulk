/**
 * Atomare Git-Operationen für Phase 3 des Flowcharts.
 *
 * Jede exportierte Funktion entspricht einer (oder wenigen) Flowchart-Boxen.
 * Die Funktionen sind absichtlich klein und einzeln testbar.
 *
 * Schreibende Operationen respektieren `dryRun` und `skipHooks` aus den
 * `BaseGitOptions`. Read-Only-Operationen (`status`, `revParse`, ...)
 * ignorieren `dryRun` — sie haben keine Seiteneffekte.
 *
 * Convention: Operationen, die im Flowchart "müssen funktionieren"
 * (fetch, reset, clean, add) werfen bei Fehler → `runGitChecked`.
 * Operationen, deren Exit-Code Teil der Logik ist (commit, push), liefern
 * das rohe `GitCommandResult` zurück.
 */

import { existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { runGit, runGitChecked, killProcessTree, type GitCommandResult } from './executor.js';
import type { Logger } from '../utils/logger.js';
import { getDefaultLogger } from '../utils/logger.js';
import { retry, type AttemptResult, type RetryResult, type RetryOptions } from '../utils/retry.js';

/**
 * Gemeinsame Parameter für alle Operationen.
 * Werden vom Runner (Phase 2) pro RU zusammengestellt und durchgereicht.
 */
export interface BaseGitOptions {
  /** Pfad zum RU-Repository */
  cwd: string;
  /** Timeout in ms pro Git-Befehl */
  timeoutMs: number;
  /** Dry-Run-Modus (read-only Befehle ignorieren das Flag) */
  dryRun: boolean;
  /** Hooks deaktivieren? */
  skipHooks: boolean;
  /** Logger (typischerweise mit `withRu(name)` markiert) */
  logger?: Logger;
  /** Abort-Signal für kooperatives Cancel (Ctrl+C) */
  signal?: AbortSignal;
}

/**
 * Bündelt die Executor-Optionen aus den BaseGitOptions. Reine Convenience —
 * spart Boilerplate in jeder Operation.
 */
function toExecOpts(
  base: BaseGitOptions,
  writeOp: boolean,
): {
  cwd: string;
  timeoutMs: number;
  dryRun?: boolean;
  skipHooks?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
} {
  const opts: ReturnType<typeof toExecOpts> = {
    cwd: base.cwd,
    timeoutMs: base.timeoutMs,
  };
  if (writeOp && base.dryRun) opts.dryRun = true;
  if (base.skipHooks) opts.skipHooks = true;
  if (base.logger) opts.logger = base.logger;
  if (base.signal) opts.signal = base.signal;
  return opts;
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.1 — Existenz-Check
// ──────────────────────────────────────────────────────────────────

/**
 * Prüft, ob ein Verzeichnis ein Git-Repository ist.
 * Flowchart: `[RU] not found locally` — diese Funktion liefert das `false`.
 *
 * @returns `true` wenn das Verzeichnis existiert UND `.git` enthält
 */
export function isGitRepository(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  try {
    if (!statSync(repoPath).isDirectory()) return false;
    const gitDir = join(repoPath, '.git');
    if (!existsSync(gitDir)) return false;
    // .git kann Verzeichnis (normal) oder Datei (worktree) sein — beides akzeptieren.
    return true;
  } catch {
    return false;
  }
}

/**
 * Klont ein Repository in `targetDir`.
 *
 * Genutzt, wenn `$config.cloneIfMissing == true` (nicht im Flowchart — siehe
 * Abweichungs-Liste). Aufrufer entscheidet, ob diese Funktion verwendet wird.
 *
 * @throws bei Spawn-Fehler oder Exit != 0
 */
export async function cloneRepo(
  remoteUrl: string,
  targetDir: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  // `git clone` läuft NICHT im RU-Verzeichnis (existiert ja noch nicht),
  // sondern im Parent-Verzeichnis von targetDir.
  const opts: Parameters<typeof runGitChecked>[1] = {
    cwd: process.cwd(),
    timeoutMs: base.timeoutMs,
    // Auch im Dry-Run nicht klonen, sonst kann die nachfolgende Verarbeitung nichts tun.
    dryRun: base.dryRun,
  };
  if (base.skipHooks) opts.skipHooks = true;
  if (base.logger) opts.logger = base.logger;
  if (base.signal) opts.signal = base.signal;
  return runGitChecked(['clone', remoteUrl, targetDir], opts);
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.2 — Branch lesen & Status prüfen
// ──────────────────────────────────────────────────────────────────

/**
 * Liest den aktuell ausgecheckten Branch.
 * Flowchart: `Read current branch → save to [branch]`.
 *
 * Im "detached HEAD"-Zustand gibt `git rev-parse --abbrev-ref HEAD` `HEAD`
 * zurück — wir liefern dann den Commit-Hash, damit der Cleanup-Checkout
 * trotzdem funktioniert.
 *
 * @throws bei Fehler (Repo ohne Commits etc.)
 */
export async function readCurrentBranch(base: BaseGitOptions): Promise<string> {
  // Read-only → kein dryRun
  const result = await runGitChecked(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    toExecOpts(base, false),
  );
  const branch = result.stdout.trim();

  if (branch === 'HEAD') {
    // Detached HEAD → Commit-Hash zurückgeben
    const hashResult = await runGitChecked(['rev-parse', 'HEAD'], toExecOpts(base, false));
    return hashResult.stdout.trim();
  }

  return branch;
}

/**
 * Prüft, ob es uncommitted Changes gibt.
 * Flowchart: `git status --porcelain` → `Output empty?`
 *
 * @returns `true` wenn der Working Tree dirty ist (Output nicht leer)
 */
export async function hasUncommittedChanges(base: BaseGitOptions): Promise<boolean> {
  const result = await runGitChecked(['status', '--porcelain'], toExecOpts(base, false));
  return result.stdout.trim().length > 0;
}

/**
 * Prüft, ob der Working Tree ungelöste Merge-Konflikte (unmerged paths) enthält.
 *
 * `git status --porcelain` markiert unmerged Einträge mit den Status-Codes
 * `DD AU UD UA DU AA UU` (X oder Y == 'U', oder beide 'A', oder beide 'D').
 * In diesem Zustand scheitert `git stash push` ("could not write index") —
 * der Aufrufer sollte das RU dann sauber überspringen statt fatal abzubrechen.
 */
export async function hasMergeConflicts(base: BaseGitOptions): Promise<boolean> {
  const result = await runGitChecked(['status', '--porcelain'], toExecOpts(base, false));
  return result.stdout.split('\n').some((line) => {
    if (line.length < 2) return false;
    const x = line[0];
    const y = line[1];
    return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
  });
}

/**
 * Stash mit dem im Flowchart definierten Marker.
 * Flowchart: `git stash -u -m 'AUTO BACKUP'` → `is_stashed = true`
 *
 * `-u` = include untracked, `-m` = mit Message.
 */
export async function stashAutoBackup(base: BaseGitOptions): Promise<GitCommandResult> {
  return runGitChecked(['stash', 'push', '-u', '-m', 'AUTO BACKUP'], toExecOpts(base, true));
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.3 — Quell-Branch aktualisieren
// ──────────────────────────────────────────────────────────────────

/**
 * Holt aktualisierte Refs vom Remote.
 * Flowchart: `git fetch origin`
 */
export async function fetchOrigin(base: BaseGitOptions): Promise<GitCommandResult> {
  return runGitChecked(['fetch', 'origin'], toExecOpts(base, true));
}

/**
 * Checkt den Quell-Branch aus.
 * Flowchart: `git checkout master` — bei uns konfigurierbar via `sourceBranch`.
 */
export async function checkoutSourceBranch(
  sourceBranch: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  return runGitChecked(['checkout', sourceBranch], toExecOpts(base, true));
}

/**
 * Hard-Reset auf den Remote-Stand des Quell-Branches.
 * Flowchart: `git reset --hard origin/master`
 *
 * Achtung: zerstört lokale Commits auf dem Quell-Branch. Das ist gewollt
 * und entspricht dem Flowchart.
 */
export async function resetHardToOrigin(
  sourceBranch: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  return runGitChecked(['reset', '--hard', `origin/${sourceBranch}`], toExecOpts(base, true));
}

/**
 * Entfernt untracked Files und Verzeichnisse.
 * Flowchart: `git clean -fd`
 */
export async function cleanWorkingTree(base: BaseGitOptions): Promise<GitCommandResult> {
  return runGitChecked(['clean', '-fd'], toExecOpts(base, true));
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.4 — Feature-Branch anlegen
// ──────────────────────────────────────────────────────────────────

/**
 * Baut den vollständigen Feature-Branch-Namen aus Ticket und Branch-Basis.
 * Flowchart: `git checkout -b + [AKB Ticket] + [BranchName]`
 *
 * Trennzeichen: `-` (siehe Abweichung A2 — Flowchart ist mehrdeutig).
 */
export function buildFeatureBranchName(ticket: string, branch: string): string {
  return `${ticket}-${branch}`;
}

/**
 * Baut die Commit-Message aus Ticket und freier Message: `<ticket> <message>`.
 *
 * So trägt jeder Commit (und damit der PR) die Ticket-ID als Präfix — analog
 * zum Feature-Branch-Namen. Ein bereits vorangestelltes identisches Ticket wird
 * NICHT doppelt gesetzt (idempotent, falls der Nutzer das Ticket selbst eintippt).
 */
export function buildCommitMessage(ticket: string, message: string): string {
  const t = ticket.trim();
  const m = message.trim();
  if (t.length === 0) return m;
  if (m === t || m.startsWith(`${t} `)) return m;
  return `${t} ${m}`;
}

/**
 * Legt den Feature-Branch an und wechselt darauf.
 * Flowchart: `git checkout -b [Branch]` — wir nutzen `-B` statt `-b`.
 *
 * `-B` erstellt den Branch ODER setzt ihn zurück, falls er bereits existiert
 * (auf den aktuellen HEAD = der frisch auf `origin/<sourceBranch>` zurück-
 * gesetzte Quell-Branch). Das macht GitBulk RE-RUN-SICHER: läuft das Tool
 * erneut auf einem RU, in dem der Feature-Branch lokal schon liegt (z. B. aus
 * einem vorherigen Lauf), scheitert es nicht mehr fatal
 * (`fatal: a branch named '…' already exists`), sondern startet sauber vom
 * aktuellen Quell-Branch-Stand neu. Etwaige alte lokale Commits auf dem
 * Feature-Branch werden dabei bewusst verworfen.
 *
 * @returns rohes Result — Aufrufer prüft `exitCode` (echte Fehler wie ein
 *          ungültiger Branch-Name bleiben non-zero).
 */
export async function createFeatureBranch(
  branchName: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  return runGit(['checkout', '-B', branchName], toExecOpts(base, true));
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.4 — Code-Change-Skript ausführen
// ──────────────────────────────────────────────────────────────────

/**
 * Sucht auf Windows nach dem von Git for Windows mitgelieferten `sh.exe`.
 *
 * Hintergrund: Git for Windows installiert `sh.exe` unter
 * `<GitInstallDir>\usr\bin\sh.exe` oder `<GitInstallDir>\bin\sh.exe`,
 * legt es aber NICHT zwingend in den globalen PATH. Da GitBulk ohnehin
 * Git voraussetzt, können wir `sh.exe` relativ zur Git-Installation finden.
 *
 * Strategie:
 *   1. Wenn `sh` im PATH ist → einfach `'sh'` zurückgeben (kein Discovery nötig).
 *   2. Sonst: `git --exec-path` liefert z. B.
 *      `C:\Program Files\Git\mingw64\libexec\git-core`. Von dort aus ist
 *      `sh.exe` unter `<GitRoot>\usr\bin\sh.exe` erreichbar.
 *   3. Fallback: typische Installationspfade durchprobieren.
 *
 * @returns Absoluter Pfad zu `sh.exe`, oder `'sh'` als Fallback (PATH).
 */
function findShellOnWindows(): string {
  // 1. Ist sh bereits im PATH? (z. B. WSL, Cygwin, oder PATH enthält Git\usr\bin)
  const inPath = spawnSyncSafe('where', ['sh']);
  if (inPath) {
    const firstLine = inPath.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (firstLine) return firstLine.trim();
  }

  // 2. Git-Installationsverzeichnis über `git --exec-path` ermitteln.
  const execPath = spawnSyncSafe('git', ['--exec-path']);
  if (execPath) {
    // Normalisiere auf Backslashes (Git kann je nach Version / oder \ liefern).
    const trimmed = execPath.trim().replace(/\//g, '\\');
    // execPath ist z. B. C:\Program Files\Git\mingw64\libexec\git-core
    // Wir suchen den Git-Root, indem wir vor dem 'mingw'-Segment abschneiden.
    const idx = trimmed.toLowerCase().indexOf('\\mingw');
    if (idx > 0) {
      const gitRoot = trimmed.slice(0, idx);
      const candidate = join(gitRoot, 'usr', 'bin', 'sh.exe');
      if (existsSync(candidate)) return candidate;
    }
  }

  // 3. Typische Installationspfade als letzter Versuch.
  const guesses = [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
  ];
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }

  // Aufgeben → 'sh' (führt zu klarer Fehlermeldung, falls nicht vorhanden).
  return 'sh';
}

/**
 * Führt einen Befehl synchron aus und gibt stdout zurück, oder `null` bei Fehler.
 * Klein gehalten für die Interpreter-Discovery (kein Streaming nötig).
 */
function spawnSyncSafe(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      return result.stdout;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cache für den ermittelten Windows-Shell-Pfad (Discovery ist teuer).
 */
let cachedWindowsShell: string | null = null;

/**
 * Cache für die tsx-Verfügbarkeit pro Repo-Verzeichnis (require.resolve kostet I/O).
 */
const tsxAvailabilityCache = new Map<string, boolean>();

/**
 * Prüft, ob `tsx` aus dem NUTZER-Repo (`cwd`) auflösbar ist.
 *
 * Bewusst aus `cwd` (nicht aus GitBulks eigenen node_modules): GitBulk liefert
 * tsx NICHT aus, sondern nutzt es nur als devDependency für eigene Tests. So
 * bleibt das Tool dependency-frei und der Nutzer entscheidet, ob er tsx bereitstellt.
 */
function isTsxAvailable(cwd: string): boolean {
  const cached = tsxAvailabilityCache.get(cwd);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    // Anker-Datei muss nicht existieren — die Auflösung startet bei cwd/node_modules.
    createRequire(join(cwd, 'package.json')).resolve('tsx');
    available = true;
  } catch {
    available = false;
  }
  tsxAvailabilityCache.set(cwd, available);
  return available;
}

/**
 * Liefert die Node-Flags für eingebautes TypeScript-Type-Stripping, oder `null`,
 * wenn die laufende Node-Version es nicht unterstützt (< 22.6).
 *
 *   - Node 22.6 – 23.5 → `--experimental-strip-types` nötig.
 *   - Node ≥ 23.6      → standardmäßig an, kein Flag (vermeidet Deprecation-Warnung).
 */
function nativeStripTypesArgs(): string[] | null {
  const [maj = 0, min = 0] = process.versions.node.split('.').map((n) => Number(n));
  const supported = maj > 22 || (maj === 22 && min >= 6);
  if (!supported) return null;
  const needsFlag = maj < 23 || (maj === 23 && min < 6);
  return needsFlag ? ['--experimental-strip-types'] : [];
}

/**
 * Wählt die Runtime für ein `.ts`/`.mts`/`.cts`-Skript (Auto-Erkennung).
 *
 * Reihenfolge: tsx aus dem Nutzer-Repo → Nodes eingebautes Type-Stripping
 * (Node ≥ 22.6) → klarer Fehler. Bei tsx wird der bare Specifier `tsx` an
 * `--import` übergeben; der Kind-Node-Prozess löst ihn relativ zu seinem
 * `cwd` (= Repo) auf, also genau dort, wo wir die Verfügbarkeit geprüft haben.
 */
function resolveTsRuntime(cwd: string): { command: string; prefixArgs: string[] } {
  if (isTsxAvailable(cwd)) {
    return { command: process.execPath, prefixArgs: ['--import', 'tsx'] };
  }
  const native = nativeStripTypesArgs();
  if (native !== null) {
    return { command: process.execPath, prefixArgs: native };
  }
  throw new Error(
    'To run TypeScript scripts on Node < 22.6, please install tsx in your project ' +
      '(npm install -D tsx) or upgrade to Node >= 22.6.',
  );
}

/**
 * Wählt den passenden Interpreter, um ein Skript plattformübergreifend
 * auszuführen.
 *
 * Hintergrund: Auf POSIX (Linux/macOS) wird ein ausführbares Skript per
 * Shebang (`#!/bin/sh`) interpretiert und kann direkt gespawnt werden.
 * Windows kennt KEINE Shebangs — `spawn('script.sh')` schlägt dort mit
 * `ENOENT`/`EFTYPE` fehl. Wir müssen den Interpreter daher explizit wählen:
 *
 *   - `.sh`            → über `sh` ausführen. Auf Windows wird Git's
 *                        mitgeliefertes `sh.exe` gesucht (siehe
 *                        `findShellOnWindows`), da Git ohnehin vorausgesetzt ist.
 *   - `.bat` / `.cmd`  → über `cmd.exe /c` (nur Windows sinnvoll).
 *   - `.ps1`           → über `powershell -File` (Windows) bzw. `pwsh` (POSIX).
 *   - `.js` / `.mjs`   → über `process.execPath` (Node selbst).
 *   - `.ts` / `.mts` / `.cts` → über tsx (aus dem Repo) oder Nodes eingebautes
 *                        Type-Stripping (siehe `resolveTsRuntime`).
 *   - sonst            → direkt ausführen und auf Shebang/Datei-Assoziation
 *                        vertrauen (POSIX-Skripte ohne Endung etc.).
 *
 * Rückgabe: `{ command, prefixArgs }`. Der eigentliche Aufruf ist dann
 * `spawn(command, [...prefixArgs, scriptPath], ...)`.
 *
 * @param scriptPath - Pfad zum Skript.
 * @param cwd        - Arbeitsverzeichnis des Skripts (Repo). Nur für die
 *                     tsx-Auflösung von `.ts`-Skripten relevant.
 */
export function resolveInterpreter(
  scriptPath: string,
  cwd: string = process.cwd(),
): {
  command: string;
  prefixArgs: string[];
} {
  const ext = extname(scriptPath).toLowerCase();
  const isWindows = process.platform === 'win32';

  switch (ext) {
    case '.sh':
    case '.bash': {
      if (isWindows) {
        // Git's sh.exe finden (mit Cache, da Discovery I/O kostet).
        if (cachedWindowsShell === null) {
          cachedWindowsShell = findShellOnWindows();
        }
        return { command: cachedWindowsShell, prefixArgs: [] };
      }
      // POSIX: sh bzw. bash direkt.
      return { command: ext === '.bash' ? 'bash' : 'sh', prefixArgs: [] };
    }
    case '.bat':
    case '.cmd':
      // Batch-Dateien laufen nur über cmd.exe.
      return { command: 'cmd.exe', prefixArgs: ['/c'] };
    case '.ps1':
      return isWindows
        ? { command: 'powershell.exe', prefixArgs: ['-NoProfile', '-File'] }
        : { command: 'pwsh', prefixArgs: ['-NoProfile', '-File'] };
    case '.js':
    case '.mjs':
    case '.cjs':
      // Auf Windows ist eine .mjs Datei nicht direkt ausführbar.
      // Wir verwenden process.execPath für den absoluten Pfad zur node.exe.
      return { command: process.execPath, prefixArgs: [] };
    case '.ts':
    case '.mts':
    case '.cts':
      // TypeScript: tsx (aus dem Repo) oder Nodes Type-Stripping; wirft mit
      // klarer Meldung, wenn weder tsx noch eine geeignete Node-Version da ist.
      return resolveTsRuntime(cwd);
    default:
      // Ohne bekannte Endung: direkt ausführen (POSIX-Shebang) — auf Windows
      // wird das fehlschlagen, aber dann ist das ein bewusstes User-Setup.
      return { command: scriptPath, prefixArgs: ['__SELF__'] };
  }
}

/**
 * Führt das benutzerdefinierte Code-Change-Skript aus.
 * Flowchart: `[Code_Change] execute` → `Exit-Code == 0?`
 *
 * Das Skript wird im RU-Verzeichnis ausgeführt. Es bekommt nützliche
 * Umgebungsvariablen, damit es kontextabhängig agieren kann:
 *
 *   - `GITBULK_RU`            — Name der RU (Repository)
 *   - `GITBULK_TICKET`        — Ticket-Identifier
 *   - `GITBULK_BRANCH`        — Voll-qualifizierter Feature-Branch-Name
 *   - `GITBULK_SOURCE_BRANCH` — Quell-Branch (z. B. master)
 *
 * Plattformübergreifend: Skripte werden über den passenden Interpreter
 * gestartet (siehe `resolveInterpreter`), sodass `.sh` auch auf Windows
 * funktioniert (sofern `sh` via Git-for-Windows/WSL verfügbar ist).
 *
 * Wird NICHT via `runGit` ausgeführt, weil es kein Git-Befehl ist.
 *
 * @returns `{ exitCode, stdout, stderr, timedOut }` — derselbe Shape wie
 *          `GitCommandResult`, damit die Phase-3-Logik einheitlich
 *          mit Exit-Codes umgehen kann.
 */
export async function executeCodeChange(
  scriptPath: string,
  contextEnv: {
    ru: string;
    ticket: string;
    branch: string;
    sourceBranch: string;
  },
  base: BaseGitOptions,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const logger = base.logger ?? getDefaultLogger();

  // ABSICHT: Im Dry-Run wird das Code-Change-Skript ECHT ausgeführt.
  //
  // Rationale: Der User soll sehen, was das Skript tatsächlich tun würde.
  // Nur die schreibenden GIT-Operationen (add, commit, push) werden im
  // Dry-Run übersprungen. Da der Cleanup-Schritt am Ende den Branch zurück-
  // setzt und gestasht wiederherstellt, hinterlässt das Skript keine
  // dauerhaften Spuren — der Working Tree ist nach dem Lauf sauber.
  if (base.dryRun) {
    logger.info(`[dry-run] executing code change script: ${scriptPath} (cwd=${base.cwd})`);
  } else {
    logger.debug(`executing code change script: ${scriptPath} (cwd=${base.cwd})`);
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;

    // Plattformübergreifenden Interpreter wählen (Windows kennt keine Shebangs).
    // base.cwd wird für die tsx-Auflösung von .ts-Skripten benötigt.
    const { command, prefixArgs } = resolveInterpreter(scriptPath, base.cwd);
    // Sonderfall "__SELF__": Skript direkt ausführen (command IST der scriptPath,
    // keine zusätzlichen Argumente). Sonst: command + prefixArgs + scriptPath.
    const isSelfExec = prefixArgs[0] === '__SELF__';
    const spawnArgs = isSelfExec ? [] : [...prefixArgs, scriptPath];

    const child = spawn(command, spawnArgs, {
      cwd: base.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GITBULK_RU: contextEnv.ru,
        GITBULK_TICKET: contextEnv.ticket,
        GITBULK_BRANCH: contextEnv.branch,
        GITBULK_SOURCE_BRANCH: contextEnv.sourceBranch,
      },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.killed || settled) return;
      killProcessTree(child, signal);
    };

    const onAbort = (): void => {
      if (!settled && !child.killed) killTree('SIGTERM');
    };
    base.signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      if (!settled && !child.killed) {
        timedOut = true;
        logger.warn(`code change script timed out after ${base.timeoutMs}ms`);
        killTree('SIGTERM');
        setTimeout(() => {
          if (!settled && !child.killed) killTree('SIGKILL');
        }, 2000).unref();
      }
    }, base.timeoutMs);
    timeoutHandle.unref();

    let stdout = '';
    let stderr = '';
    child.stdin?.end();
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      base.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`failed to spawn code change script: ${err.message}`));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      base.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.5 — Stage & Commit
// ──────────────────────────────────────────────────────────────────

/**
 * Staged alle Änderungen.
 * Flowchart: `git add .`
 */
export async function stageAll(base: BaseGitOptions): Promise<GitCommandResult> {
  return runGitChecked(['add', '.'], toExecOpts(base, true));
}

/**
 * Erstellt einen Commit mit der gegebenen Message.
 * Flowchart: `git commit -m '...'`
 *
 * @returns rohes Result — Aufrufer kann Exit != 0 (z. B. "nothing to commit")
 *          gesondert behandeln.
 */
export async function commit(message: string, base: BaseGitOptions): Promise<GitCommandResult> {
  return runGit(['commit', '-m', message], toExecOpts(base, true));
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.6 — Push mit Retry-Loop
// ──────────────────────────────────────────────────────────────────

/**
 * Patterns im stderr, bei denen ein Retry SINNLOS ist (permanente Fehler).
 * Bei diesen Strings bricht der Push-Loop sofort ab (siehe Abweichung B11).
 */
const PUSH_PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read username/i,
  /permission denied/i,
  /access denied/i,
  /repository not found/i,
  /403 forbidden/i,
  /protected branch/i,
  /pre-receive hook declined/i,
];

/**
 * Push-Operation mit Retry-Loop (Phase 3.6).
 *
 * Verwendet `--force-with-lease` wie im Flowchart vorgegeben — sicherer als
 * `--force`, weil Updates auf dem Remote nicht überschrieben werden, die wir
 * nicht gesehen haben.
 *
 * @param branchName - der Feature-Branch (Push-Ziel)
 * @param base - Standardoptionen
 * @param retryConfig - Retry-Parameter aus `$config.retry`
 * @returns Retry-Result mit Erfolg / Erschöpfung / permanentem Fehler
 */
export async function pushFeatureBranch(
  branchName: string,
  base: BaseGitOptions,
  retryConfig: { maxAttempts: number; backoffMs: number; maxBackoffMs: number },
): Promise<RetryResult<GitCommandResult>> {
  const logger = base.logger ?? getDefaultLogger();

  const retryOpts: RetryOptions = {
    maxAttempts: retryConfig.maxAttempts,
    backoffMs: retryConfig.backoffMs,
    maxBackoffMs: retryConfig.maxBackoffMs,
    description: `push ${branchName}`,
  };
  if (base.logger) retryOpts.logger = base.logger;
  if (base.signal) retryOpts.signal = base.signal;

  return retry<GitCommandResult>(async (): Promise<AttemptResult<GitCommandResult>> => {
    const result = await runGit(
      ['push', 'origin', branchName, '--force-with-lease'],
      toExecOpts(base, true),
    );

    if (result.exitCode === 0) {
      return { ok: true, value: result };
    }

    const combined = `${result.stderr}\n${result.stdout}`;
    const isPermanent = PUSH_PERMANENT_ERROR_PATTERNS.some((pat) => pat.test(combined));

    if (isPermanent) {
      logger.warn(
        `push got permanent error: ${result.stderr.trim().split('\n')[0] ?? '(no stderr)'}`,
      );
      return {
        ok: false,
        retry: false,
        error: result.stderr.trim() || `exit ${result.exitCode}`,
      };
    }

    return {
      ok: false,
      retry: true,
      error: result.stderr.trim() || `exit ${result.exitCode}`,
    };
  }, retryOpts);
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.7 — Cleanup
// ──────────────────────────────────────────────────────────────────

/**
 * Wechselt zurück zum ursprünglich gesicherten Branch.
 * Flowchart: `git checkout [branch]`
 */
export async function checkoutBranch(
  branchName: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  return runGit(['checkout', branchName], toExecOpts(base, true));
}

/**
 * `git stash pop` — nur sinnvoll, wenn vorher gestasht wurde.
 * Flowchart: nach Checkout im Cleanup.
 *
 * @returns rohes Result — bei Conflict gibt's Exit != 0; das Flowchart
 *          loggt dann `Cleanup [RU] failed manual fix`.
 */
export async function stashPop(base: BaseGitOptions): Promise<GitCommandResult> {
  return runGit(['stash', 'pop'], toExecOpts(base, true));
}

// ──────────────────────────────────────────────────────────────────
// Phase 3.8 — Branch-Aufräumung (wenn kein PR)
// ──────────────────────────────────────────────────────────────────

/**
 * Löscht den lokalen Feature-Branch hart.
 * Flowchart: `git branch -D + [AKB Ticket] + [BranchName]`
 *
 * Wird ausgeführt, wenn `PR_Status != create_PR` — also wenn kein PR
 * erstellt wird (z. B. weil Code-Change keinen Diff produzierte).
 */
export async function deleteLocalBranch(
  branchName: string,
  base: BaseGitOptions,
): Promise<GitCommandResult> {
  return runGit(['branch', '-D', branchName], toExecOpts(base, true));
}

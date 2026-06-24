/**
 * `gitbulk template` — gibt eine **fertige Beispiel-Konfiguration** aus, ohne
 * interaktive Abfragen (im Gegensatz zu `gitbulk init`).
 *
 * Zwei Varianten:
 *   - `full`    (Default): alle Felder mit Kommentaren und Defaults — ideal als
 *                Nachschlage-/Startvorlage.
 *   - `minimal` (`--minimal`): nur die Pflichtfelder — schlank zum Loslegen.
 *
 * Ausgabe nach stdout (für `> gitbulk.yaml`) oder via `-o/--output` in eine
 * Datei (`-f/--force` zum Überschreiben). Beide Vorlagen sind bewusst so
 * gehalten, dass sie das Schema erfüllen (Code-Change über `operations:`, damit
 * keine real existierende Skriptdatei nötig ist).
 *
 * Tokens stehen NIE in der Vorlage — sie kommen aus Env-Variablen.
 */

import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import * as colors from '../utils/colors.js';

export type TemplateKind = 'full' | 'minimal';

export interface TemplateOptions {
  kind: TemplateKind;
  /** Zieldatei; fehlt sie, geht die Ausgabe nach stdout. */
  outputPath?: string;
  /** Vorhandene Zieldatei überschreiben? */
  force?: boolean;
  /** Farbe deaktivieren (für Fehlermeldungen). */
  noColor?: boolean;
}

/** Nur die Pflichtfelder — sofort lauffähig. */
const MINIMAL_TEMPLATE = `# GitBulk — minimale Konfiguration (nur Pflichtfelder).
# Erzeugt mit: gitbulk template --minimal
# Volle Vorlage mit allen Optionen: gitbulk template

rus:
  - my-repo
ticket: AKB-1234
branch: feature/my-change

# Code-Change: GENAU EINES von 'operations:' ODER 'script:'.
operations:
  - type: regex-replace
    path: pom.xml
    pattern: '<java.version>17</java.version>'
    replacement: '<java.version>21</java.version>'

commitMessage: 'update Java version'
prSummary: 'Update Java version to 21'
createPrOnError: false

prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
`;

/** Alle Felder mit Kommentaren und Defaults. */
const FULL_TEMPLATE = `# GitBulk — vollständige Konfiguration mit allen Optionen und Defaults.
# Erzeugt mit: gitbulk template
# Tokens stehen NIE in dieser Datei — sie kommen aus Env-Variablen
# (GITBULK_BITBUCKET_TOKEN / GITBULK_GITHUB_TOKEN).

# ── Pflichtfelder ───────────────────────────────────────────────────
rus:                               # Repository-Units (Repo-Slugs)
  - my-repo
  - another-repo
ticket: AKB-1234                   # Ticket-ID; wird Branch und Commit vorangestellt
branch: feature/my-change          # Feature-Branch ohne Ticket → <ticket>-<branch>
commitMessage: 'update Java version'
prSummary: 'Update Java version to 21'
createPrOnError: false             # PR auch anlegen, wenn der Code-Change fehlschlägt

# Code-Change: GENAU EINES von 'operations:' ODER 'script:'.
operations:                        # deklarative, verkettbare Operationen
  - type: regex-replace
    path: pom.xml
    pattern: '<java.version>17</java.version>'
    replacement: '<java.version>21</java.version>'
# script: ./scripts/change.mjs     # Alternative: freies Skript (.sh/.ps1/.mjs/.ts/…)

# ── Optionale Felder (mit Default) ──────────────────────────────────
workspaceDir: .                    # Wurzelverzeichnis der RU-Repos (Default: CWD)
sourceBranch: master               # Basis-Branch für den Feature-Branch
cloneIfMissing: false              # fehlende Repos automatisch klonen
# cloneBaseUrl: https://bitbucket.org/my-workspace   # nötig, wenn cloneIfMissing: true
concurrency: 1                     # parallele RUs (1–50)
commandTimeoutMs: 120000           # Timeout pro Git-Befehl (ms)
dryRun: false                      # keine schreibenden Aktionen (push, PR-API)
skipHooks: false                   # Git-Hooks deaktivieren
retry:                             # Push-Retry (exponentielles Backoff)
  maxAttempts: 3
  backoffMs: 1000
  maxBackoffMs: 30000

# ── PR-Plattform ────────────────────────────────────────────────────
prPlatform: bitbucket              # bitbucket | github  (azure-devops: noch nicht implementiert)
bitbucket:
  workspace: my-workspace          # Workspace-Slug (Cloud) bzw. Project-Key (Server)
  apiVariant: cloud                # cloud | server
  targetBranch: master
  reviewers: []                    # UUIDs (Cloud) oder Usernames
  # apiBaseUrl: https://bitbucket.example.com   # für Server / Custom-Proxy
# github:                          # statt bitbucket — prPlatform: github setzen
#   owner: my-org
#   targetBranch: main
#   reviewers: []
#   apiBaseUrl: https://ghe.example.com/api/v3   # für GitHub Enterprise
`;

/** Liefert den Vorlagen-Text für die gewünschte Variante. */
export function generateTemplate(kind: TemplateKind): string {
  return kind === 'minimal' ? MINIMAL_TEMPLATE : FULL_TEMPLATE;
}

/**
 * Führt das `template`-Subkommando aus: schreibt die Vorlage nach stdout oder
 * in die angegebene Datei.
 *
 * @returns Exit-Code (0 = ok, 3 = Datei existiert ohne `--force`).
 */
export function runTemplate(opts: TemplateOptions): number {
  const content = generateTemplate(opts.kind);

  if (opts.outputPath === undefined) {
    process.stdout.write(content);
    return 0;
  }

  if (existsSync(opts.outputPath) && opts.force !== true) {
    const prefix = opts.noColor ? 'Error:' : colors.redBold('Error:');
    process.stderr.write(
      `${prefix} ${opts.outputPath} already exists. Use --force (-f) to overwrite.\n`,
    );
    return 3;
  }

  writeFileSync(opts.outputPath, content, 'utf8');
  process.stderr.write(`Wrote ${opts.kind} config template to ${opts.outputPath}\n`);
  return 0;
}

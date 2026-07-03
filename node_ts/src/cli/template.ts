/**
 * `gitbulk template` — gibt eine **fertige Beispiel-Konfiguration** aus, ohne
 * interaktive Abfragen (im Gegensatz zu `gitbulk init`).
 *
 * Zwei Varianten:
 *   - `full`    (Default): alle Felder mit Kommentaren und Defaults — ideal als
 *                Nachschlage-/Startvorlage.
 *   - `minimal` (`--minimal`): nur die Pflichtfelder — schlank zum Loslegen.
 *
 * `--platform <p>` wählt die PR-Plattform des emittierten Blocks (Default:
 * bitbucket) — alle vier Adapter werden unterstützt.
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

/** Vom Template unterstützte PR-Plattformen (alle vier Adapter). */
export type TemplatePlatform = 'bitbucket' | 'github' | 'gitlab' | 'azure-devops';

export const TEMPLATE_PLATFORMS: readonly TemplatePlatform[] = [
  'bitbucket',
  'github',
  'gitlab',
  'azure-devops',
];

export interface TemplateOptions {
  kind: TemplateKind;
  /** PR-Plattform des emittierten Blocks (Default: bitbucket). */
  platform?: TemplatePlatform;
  /** Zieldatei; fehlt sie, geht die Ausgabe nach stdout. */
  outputPath?: string;
  /** Vorhandene Zieldatei überschreiben? */
  force?: boolean;
  /** Farbe deaktivieren (für Fehlermeldungen). */
  noColor?: boolean;
}

/** Token-Env-Variable je Plattform (für den Kopf-Kommentar). */
const TOKEN_ENV_VARS: Record<TemplatePlatform, string> = {
  bitbucket: 'GITBULK_BITBUCKET_TOKEN',
  github: 'GITBULK_GITHUB_TOKEN',
  gitlab: 'GITBULK_GITLAB_TOKEN',
  'azure-devops': 'GITBULK_AZURE_DEVOPS_TOKEN',
};

/** Minimaler Plattform-Block (nur Pflichtfelder der Sub-Config). */
const MINIMAL_PLATFORM_BLOCKS: Record<TemplatePlatform, string> = {
  bitbucket: `prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
`,
  github: `prPlatform: github
github:
  owner: my-org
`,
  gitlab: `prPlatform: gitlab
gitlab:
  namespace: my-group
`,
  'azure-devops': `prPlatform: azure-devops
azureDevOps:
  organization: my-org
  project: my-project
`,
};

/** Voller, kommentierter Plattform-Block. */
const FULL_PLATFORM_BLOCKS: Record<TemplatePlatform, string> = {
  bitbucket: `prPlatform: bitbucket              # bitbucket | github | gitlab | azure-devops
bitbucket:
  workspace: my-workspace          # Workspace-Slug (Cloud) bzw. Project-Key (Server)
  apiVariant: cloud                # cloud | server
  targetBranch: master
  reviewers: []                    # UUIDs (Cloud) oder Usernames
  # apiBaseUrl: https://bitbucket.example.com   # für Server / Custom-Proxy
`,
  github: `prPlatform: github                 # bitbucket | github | gitlab | azure-devops
github:
  owner: my-org                    # User oder Organisation
  targetBranch: main
  reviewers: []                    # GitHub-Logins
  # apiBaseUrl: https://ghe.example.com/api/v3   # für GitHub Enterprise
`,
  gitlab: `prPlatform: gitlab                 # bitbucket | github | gitlab | azure-devops
gitlab:
  namespace: my-group              # Gruppe oder User; Projekt = <namespace>/<repo>
  targetBranch: main
  reviewers: []                    # numerische GitLab-User-IDs (als Strings)
  # apiBaseUrl: https://gitlab.example.com/api/v4   # für self-hosted GitLab
`,
  'azure-devops': `prPlatform: azure-devops           # bitbucket | github | gitlab | azure-devops
azureDevOps:
  organization: my-org             # dev.azure.com/<organization>; on-prem: die Collection
  project: my-project              # Repo = <organization>/<project>/<repo>
  targetBranch: master
  reviewers: []                    # Azure-User-IDs (GUIDs)
  # apiBaseUrl: https://tfs.example.com/tfs   # on-prem: Instanz-Wurzel OHNE Collection
`,
};

/** Nur die Pflichtfelder — sofort lauffähig. */
function minimalTemplate(platform: TemplatePlatform): string {
  return `# GitBulk — minimale Konfiguration (nur Pflichtfelder).
# Erzeugt mit: gitbulk template --minimal --platform ${platform}
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

${MINIMAL_PLATFORM_BLOCKS[platform]}`;
}

/** Alle Felder mit Kommentaren und Defaults. */
function fullTemplate(platform: TemplatePlatform): string {
  return `# GitBulk — vollständige Konfiguration mit allen Optionen und Defaults.
# Erzeugt mit: gitbulk template --platform ${platform}
# Tokens stehen NIE in dieser Datei — sie kommen aus Env-Variablen
# (hier: ${TOKEN_ENV_VARS[platform]}).

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
# Andere Plattform? gitbulk template --platform bitbucket|github|gitlab|azure-devops
${FULL_PLATFORM_BLOCKS[platform]}`;
}

/** Liefert den Vorlagen-Text für die gewünschte Variante. */
export function generateTemplate(
  kind: TemplateKind,
  platform: TemplatePlatform = 'bitbucket',
): string {
  return kind === 'minimal' ? minimalTemplate(platform) : fullTemplate(platform);
}

/**
 * Führt das `template`-Subkommando aus: schreibt die Vorlage nach stdout oder
 * in die angegebene Datei.
 *
 * @returns Exit-Code (0 = ok, 3 = Datei existiert ohne `--force`).
 */
export function runTemplate(opts: TemplateOptions): number {
  const content = generateTemplate(opts.kind, opts.platform ?? 'bitbucket');

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

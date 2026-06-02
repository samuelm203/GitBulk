/**
 * Config-Loader für GitBulk.
 *
 * Unterstützt vier Dateiformate, automatisch erkannt anhand der Endung:
 *   - `.yaml` / `.yml`  → YAML-Parser
 *   - `.json`           → JSON.parse
 *   - `.js` / `.mjs`    → ESM-`import()` (Default-Export = Config)
 *   - `.ts`             → ESM-`import()` via tsx-Runtime
 *
 * Modi:
 *   - "strict":  Datei muss vollständig sein, sonst Fehler.
 *   - "hybrid":  Datei kann Teilwerte enthalten, fehlende Felder werden
 *                interaktiv erfragt — entspricht der "C) Beide Modi"-Antwort.
 */

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import {
  GitBulkConfigSchema,
  PartialGitBulkConfigSchema,
  type GitBulkConfig,
  type PartialGitBulkConfig,
} from './schema.js';
import { runInteractivePrompts } from '../cli/prompts.js';
import { getDefaultLogger } from '../utils/logger.js';

/**
 * Unterstützte Config-Dateiformate.
 */
const SUPPORTED_EXTENSIONS = ['.yaml', '.yml', '.json', '.js', '.mjs', '.ts'] as const;
type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/**
 * Fehler-Klasse für Config-Probleme. Sammelt mehrere Zod-Fehler
 * zu einer einzigen, lesbaren Meldung.
 */
export class ConfigError extends Error {
  public readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }

  /**
   * Gibt eine multi-line Repräsentation für CLI-Output zurück.
   */
  public format(): string {
    if (this.details.length === 0) {
      return this.message;
    }
    return [`${this.message}:`, ...this.details.map((d) => `  • ${d}`)].join('\n');
  }
}

/**
 * Optionen für den Config-Loader.
 */
export interface LoadConfigOptions {
  /**
   * Pfad zur Config-Datei (absolut oder relativ zum CWD).
   * Wenn weggelassen, läuft der Loader im rein-interaktiven Modus.
   */
  path?: string;

  /**
   * Modus:
   * - `"strict"`: Datei muss vollständig sein.
   * - `"hybrid"`: fehlende Felder werden interaktiv ergänzt.
   *
   * Standard: `"hybrid"` (entspricht der User-Antwort "Beide Modi parallel").
   */
  mode?: 'strict' | 'hybrid';
}

/**
 * Wirft `ConfigError` mit einheitlicher Meldung, wenn die Endung
 * nicht zu den unterstützten Formaten gehört.
 */
function assertSupportedExtension(ext: string): asserts ext is SupportedExtension {
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ConfigError(
      `Unsupported config file extension "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }
}

/**
 * Liest den Inhalt einer YAML- oder JSON-Datei und parst ihn zu
 * einem rohen JS-Objekt (noch nicht gegen das Schema validiert).
 */
async function parseDataFile(absolutePath: string, ext: SupportedExtension): Promise<unknown> {
  const raw = await readFile(absolutePath, 'utf8');

  if (ext === '.json') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`Invalid JSON in ${absolutePath}: ${(err as Error).message}`);
    }
  }

  // YAML
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${absolutePath}: ${(err as Error).message}`);
  }
}

/**
 * Lädt eine JS-/TS-Config-Datei via dynamischem ESM-Import.
 * Der Default-Export muss die Konfiguration sein.
 *
 * Für `.ts` muss die Anwendung über die tsx-Runtime gestartet werden
 * (z. B. `npm run dev`), sonst kann Node die Datei nicht auflösen.
 */
async function importCodeFile(absolutePath: string): Promise<unknown> {
  // SICHERHEIT: Eine .js/.mjs/.ts-Config wird via dynamischem import() geladen
  // und ihr Default-Export ggf. als Funktion AUSGEFÜHRT — das ist beliebiger
  // Code. Nur Configs aus vertrauenswürdiger Quelle verwenden. Wir warnen
  // explizit, damit das nicht unbemerkt passiert. Für nicht-vertrauenswürdige
  // Eingaben ein Daten-Format (.yaml/.json) nutzen.
  getDefaultLogger().warn(
    `Executing code config "${absolutePath}" — this runs arbitrary code. Only use code configs you trust (prefer .yaml/.json otherwise).`,
  );

  let mod: { default?: unknown; [key: string]: unknown };
  try {
    // Wichtig: file:// URL, damit absolute Pfade unter Windows funktionieren.
    mod = (await import(pathToFileURL(absolutePath).href)) as {
      default?: unknown;
      [key: string]: unknown;
    };
  } catch (err) {
    throw new ConfigError(
      `Failed to import config from ${absolutePath}: ${(err as Error).message}`,
    );
  }

  if (mod.default === undefined) {
    throw new ConfigError(`Config file ${absolutePath} must provide a default export`);
  }
  // Funktion als Default-Export wird ausgewertet (erlaubt dynamische Configs)
  if (typeof mod.default === 'function') {
    try {
      return await (mod.default as () => unknown | Promise<unknown>)();
    } catch (err) {
      throw new ConfigError(
        `Default export function in ${absolutePath} threw: ${(err as Error).message}`,
      );
    }
  }
  return mod.default;
}

/**
 * Auflösen des Datei-Pfads und Existenz-Check.
 */
function resolveConfigPath(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  if (!existsSync(absolute)) {
    throw new ConfigError(`Config file not found: ${absolute}`);
  }
  if (!statSync(absolute).isFile()) {
    throw new ConfigError(`Config path is not a file: ${absolute}`);
  }
  return absolute;
}

/**
 * Liest eine Config-Datei und gibt das rohe Objekt zurück.
 * Die Schema-Validierung erfolgt separat (loadConfig).
 */
async function readConfigFile(absolutePath: string): Promise<unknown> {
  const ext = extname(absolutePath).toLowerCase();
  assertSupportedExtension(ext);

  if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
    return parseDataFile(absolutePath, ext);
  }
  return importCodeFile(absolutePath);
}

/**
 * Wandelt Zod-Issues in eine lesbare Fehler-Detail-Liste um.
 */
function formatZodIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Bestimmt, welche Phase-1-Pflichtfelder in der Teil-Config fehlen.
 * Im Hybrid-Modus werden diese interaktiv nachgefragt.
 */
function missingRequiredFields(partial: PartialGitBulkConfig): string[] {
  const required: Array<keyof PartialGitBulkConfig> = [
    'rus',
    'ticket',
    'branch',
    'commitMessage',
    'prSummary',
    'createPrOnError',
    'prPlatform',
  ];
  const missing = required.filter((key) => partial[key] === undefined);

  // `script` und `operations` sind Alternativen: genau eines muss vorhanden
  // sein. Fehlt beides, fragen wir im Hybrid-Modus nach einem Skript (der
  // interaktive Pfad kennt keine Operationen). Operationen kommen nur aus der
  // Datei und unterdrücken hier die Skript-Nachfrage.
  const hasScript = partial.script !== undefined;
  const hasOperations = Array.isArray(partial.operations) && partial.operations.length > 0;
  if (!hasScript && !hasOperations) {
    missing.push('script');
  }

  return missing;
}

/**
 * Lädt und validiert die GitBulk-Konfiguration.
 *
 * Verhalten:
 *   - Kein `path` und kein Hybrid-Trigger → vollständig interaktiv.
 *   - `path` + alle Felder vorhanden → Datei wird strikt validiert.
 *   - `path` + fehlende Felder + mode="hybrid" → fehlende Felder via Prompt.
 *   - `path` + fehlende Felder + mode="strict" → Fehler.
 *
 * @returns Validierte, gefreezte (read-only) Konfiguration
 * @throws {ConfigError} bei Schema-Verletzungen
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<GitBulkConfig> {
  const mode = options.mode ?? 'hybrid';

  // ── Fall 1: Kein Pfad → rein interaktiv ──────────────────────
  if (!options.path) {
    const interactive = await runInteractivePrompts();
    return finalizeInteractiveOnly(interactive);
  }

  // ── Fall 2: Pfad angegeben → Datei laden ─────────────────────
  const absolutePath = resolveConfigPath(options.path);
  const rawConfig = await readConfigFile(absolutePath);

  // Zunächst gegen das partielle Schema parsen, damit Teil-Configs zugelassen sind.
  const partialResult = PartialGitBulkConfigSchema.safeParse(rawConfig);
  if (!partialResult.success) {
    throw new ConfigError(
      `Config validation failed (${absolutePath})`,
      formatZodIssues(partialResult.error.issues),
    );
  }

  const missing = missingRequiredFields(partialResult.data);

  if (missing.length > 0) {
    if (mode === 'strict') {
      throw new ConfigError(
        `Config is incomplete and mode is "strict"`,
        missing.map((field) => `Missing required field: ${field}`),
      );
    }

    // Hybrid: fehlende Felder interaktiv ergänzen.
    // Aktuelle Vereinfachung: wenn ein Phase-1-Feld fehlt, läuft der gesamte
    // interaktive Dialog. Granulares Nachfragen pro Feld wäre eine künftige
    // Verfeinerung.
    process.stdout.write(
      `\nConfig file is incomplete (missing: ${missing.join(', ')}).\n` +
        `Switching to interactive mode for the missing pieces.\n`,
    );
    const interactive = await runInteractivePrompts();
    // Datei-Defaults für *zusätzliche* Felder beibehalten (workspaceDir,
    // retry, concurrency, etc.) — interaktive Werte überschreiben Phase-1.
    return mergeAndFinalize(partialResult.data, interactive);
  }

  // Fall 3: Datei vollständig → striktes Endschema anwenden.
  const finalResult = GitBulkConfigSchema.safeParse(partialResult.data);
  if (!finalResult.success) {
    throw new ConfigError(
      `Config validation failed (${absolutePath})`,
      formatZodIssues(finalResult.error.issues),
    );
  }

  return Object.freeze(finalResult.data);
}

/**
 * Erstellt die finale Config aus rein interaktiven Eingaben.
 *
 * Da der interaktive Pfad keine Plattform-Auswahl umfasst (das wäre
 * zu viel für die Phase-1-Sequenz), wird hier verlangt, dass mindestens
 * der `prPlatform`- und Plattform-Block via Env-Variablen vorgegeben sind —
 * sonst wirft die Validierung einen erklärenden Fehler.
 *
 * Für den reinen Interaktiv-Modus ohne PR-Plattform-Settings empfehlen
 * wir den User auf den Hybrid-Modus zu schicken.
 */
function finalizeInteractiveOnly(
  interactive: Awaited<ReturnType<typeof runInteractivePrompts>>,
): GitBulkConfig {
  const candidate = {
    ...interactive,
    prPlatform: process.env.GITBULK_PR_PLATFORM,
    bitbucket: process.env.GITBULK_BITBUCKET_WORKSPACE
      ? {
          workspace: process.env.GITBULK_BITBUCKET_WORKSPACE,
          apiBaseUrl: process.env.GITBULK_BITBUCKET_API_URL,
          targetBranch: process.env.GITBULK_BITBUCKET_TARGET_BRANCH ?? 'master',
          reviewers:
            process.env.GITBULK_BITBUCKET_REVIEWERS?.split(',')
              .map((s) => s.trim())
              .filter(Boolean) ?? [],
        }
      : undefined,
  };

  const result = GitBulkConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError('Interactive-only mode requires PR platform settings via environment', [
      ...formatZodIssues(result.error.issues),
      '',
      'Set GITBULK_PR_PLATFORM=bitbucket (or azure-devops) plus the matching workspace env vars,',
      'or use a config file with --config to provide PR platform settings.',
    ]);
  }
  return Object.freeze(result.data);
}

/**
 * Merged Datei-Partial-Werte mit den interaktiven Phase-1-Eingaben.
 * Interaktive Werte gewinnen (User hat sie zuletzt eingegeben).
 */
function mergeAndFinalize(
  partial: PartialGitBulkConfig,
  interactive: Awaited<ReturnType<typeof runInteractivePrompts>>,
): GitBulkConfig {
  const merged = { ...partial, ...interactive };
  const result = GitBulkConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError('Merged config failed validation', formatZodIssues(result.error.issues));
  }
  return Object.freeze(result.data);
}

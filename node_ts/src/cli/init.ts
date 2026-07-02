/**
 * `gitbulk init` — interaktiver Generator.
 *
 * Führt per Prompts durch die verfügbaren Operationen (`collectOperations`),
 * fragt deren Parameter anhand der Zod-Schemas ab und erzeugt am Ende WAHLWEISE:
 *   1. eine lauffähige YAML-Config mit `operations:`-Block,
 *   2. ein eigenständiges `.mjs`/`.ts`-Code-Change-Skript (frei anpassbar), oder
 *   3. BEIDES — ein Skript plus eine Config, die es über `script:` ausführt.
 *
 * Die Operationen-Sammel-Prompts liegen in `cli/operation-prompts.ts` (geteilt
 * mit dem interaktiven Lauf-Modus); die Code-/Config-Erzeugung in eigenen,
 * unit-getesteten Modulen. Diese Datei orchestriert nur Prompts + Datei-Schreiben.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname, join, relative, sep } from 'node:path';

import * as colors from '../utils/colors.js';

import { listOperations } from '../operations/index.js';
import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateMessage,
  validateYesNo,
} from '../utils/validators.js';
import { promptUntilValid } from './prompts.js';
import {
  collectOperations,
  chooseOneOrTwo,
  chooseOneTwoThree,
  type CollectedOp,
} from './operation-prompts.js';
import {
  generateScript,
  type ScriptOperation,
  type ScriptLanguage,
} from './script-generator.js';
import { generateYamlConfig, type InitPrPlatform } from './config-generator.js';

/**
 * Standard-Zielordner für generierte Configs/Skripte. Hält alle GitBulk-
 * Artefakte an einem Ort (per `--output` überschreibbar) und ist via `.gitignore`
 * (`gitbulk/`) standardmäßig ausgenommen.
 */
const GITBULK_DIR = 'gitbulk';

export interface InitOptions {
  /** Optionaler Ausgabepfad (überschreibt den gitbulk/-Default + Dateinamen-Prompt). */
  outputPath?: string;
  /** Vorhandene Datei ohne Rückfrage überschreiben. */
  force?: boolean;
  /** Farbe deaktivieren. */
  noColor?: boolean;
}

/**
 * Validiert einen reinen Dateinamen (kein Pfad-Separator, kein `.`/`..`),
 * damit `init` nicht aus dem gitbulk/-Verzeichnis ausbrechen kann. Leere
 * Eingabe → Default.
 */
export function validateOutputFileName(
  raw: string,
  defaultName: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const t = raw.trim();
  const name = t.length === 0 ? defaultName : t;
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    return { ok: false, error: 'Enter a plain file name (no path separators, no "." / "..").' };
  }
  return { ok: true, value: name };
}

/**
 * Liefert den nächsten freien Pfad, indem vor der Endung ein Zähler eingefügt
 * wird, falls `target` bereits existiert: `gitbulk.config.yaml` →
 * `gitbulk.config2.yaml` → `gitbulk.config3.yaml` …; `gitbulk-change.mjs` →
 * `gitbulk-change2.mjs`. Existiert `target` nicht, wird er unverändert zurück-
 * gegeben. Dateien ohne Endung hängen den Zähler hinten an.
 */
export function nextFreePath(target: string): string {
  if (!existsSync(target)) return target;
  const dir = dirname(target);
  const ext = extname(target); // z. B. ".yaml" (leer, wenn keine Endung)
  const stem = basename(target, ext);
  let n = 2;
  let candidate: string;
  do {
    candidate = join(dir, `${stem}${n}${ext}`);
    n += 1;
  } while (existsSync(candidate));
  return candidate;
}

/**
 * Ermittelt den Zielpfad.
 *
 * Ohne `--output` wird interaktiv ein Dateiname erfragt und die Datei im festen
 * `gitbulk/`-Ordner abgelegt. Mit `--output` gilt der angegebene Pfad.
 *
 * Existiert die Zieldatei bereits, wird – sofern NICHT `--force` gesetzt ist –
 * automatisch der nächste freie Name gewählt (Multi-YAML: `config2.yaml` …),
 * statt zu überschreiben oder nachzufragen. `--force` überschreibt.
 */
export async function resolveOutputPath(
  rl: Interface,
  opts: InitOptions,
  defaultName: string,
): Promise<string> {
  let target: string;
  if (opts.outputPath !== undefined) {
    target = resolve(opts.outputPath);
  } else {
    const filename = await promptUntilValid(rl, `File name [default: ${defaultName}]:`, (raw) =>
      validateOutputFileName(raw, defaultName),
    );
    target = resolve(GITBULK_DIR, filename);
  }

  if (opts.force || !existsSync(target)) {
    return target;
  }

  // Existiert und kein --force: nächsten freien Namen wählen (kein Überschreiben).
  const free = nextFreePath(target);
  output.write(colors.yellow(`${target} already exists — writing ${free} instead.\n`));
  return free;
}

/**
 * Führt den kompletten `gitbulk init`-Dialog aus.
 *
 * @returns Exit-Code (0 = Erfolg, 3 = abgebrochen / Fehler).
 */
export async function runInitGenerator(opts: InitOptions = {}): Promise<number> {
  const rl = createInterface({ input, output });

  try {
    output.write(colors.bold('\n━━━ GitBulk init — code-change generator ━━━\n'));

    if (listOperations().length === 0) {
      process.stderr.write(colors.red('No operations are registered.\n'));
      return 3;
    }

    // ── 1) Art des Code-Change zuerst wählen ─────────────────────
    output.write(colors.bold('\nWhat do you want to create?\n'));
    output.write(`  ${colors.green('1')}. A config with declarative operations (YAML)\n`);
    output.write(`  ${colors.green('2')}. A standalone code-change script\n`);
    output.write(`  ${colors.green('3')}. Both — a script + a config that runs it\n`);
    const kind = await promptUntilValid(rl, 'Choose (1/2/3):', chooseOneTwoThree);

    // ── 2) Bei Skript (auch im beides-Modus): Sprache wählen ─────
    let language: ScriptLanguage = 'js';
    if (kind === '2' || kind === '3') {
      output.write(colors.bold('\nScript language?\n'));
      output.write(`  ${colors.green('1')}. JavaScript (.mjs)\n`);
      output.write(`  ${colors.green('2')}. TypeScript (.ts)\n`);
      const lang = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);
      language = lang === '2' ? 'ts' : 'js';
    }

    // ── 3) Operationen zusammenstellen ───────────────────────────
    const operations = await collectOperations(rl);

    // ── 4) Exportieren ───────────────────────────────────────────
    if (kind === '2') return await exportScript(rl, opts, operations, language);
    if (kind === '3') return await exportBoth(rl, opts, operations, language);
    return await exportConfig(rl, opts, operations);
  } finally {
    rl.close();
  }
}

/** Schreibt das generierte Code-Change-Skript (.mjs oder .ts). */
async function exportScript(
  rl: Interface,
  opts: InitOptions,
  operations: CollectedOp[],
  language: ScriptLanguage,
): Promise<number> {
  const scriptOps: ScriptOperation[] = operations.map((o) => ({ type: o.type, params: o.params }));
  const { code, unsupported } = generateScript(scriptOps, language);

  if (unsupported.length > 0) {
    process.stderr.write(
      colors.yellow(
        `\nNote: no script generator for: ${[...new Set(unsupported)].join(', ')}. ` +
          'These are left as TODO comments in the script.\n',
      ),
    );
  }

  const defaultName = language === 'ts' ? 'gitbulk-change.ts' : 'gitbulk-change.mjs';
  const target = await resolveOutputPath(rl, opts, defaultName);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code, { mode: 0o755 });
  output.write(colors.green(`\n✓ Wrote standalone script: ${target}\n`));
  output.write(colors.gray(`  Use it via the "script" field in your config, then edit freely.\n`));
  if (language === 'ts') {
    output.write(
      colors.gray('  TypeScript runs via tsx (npm i -D tsx) or Node >= 22.6 automatically.\n'),
    );
  }
  return 0;
}

/** Interaktiv erfragte Config-Felder (ohne den Code-Change-Teil). */
interface PromptedConfigFields {
  rus: string[];
  ticket: string;
  branch: string;
  commitMessage: string;
  prSummary: string;
  createPrOnError: boolean;
  prPlatform: InitPrPlatform;
  bitbucketWorkspace?: string;
  githubOwner?: string;
  gitlabNamespace?: string;
  azureOrganization?: string;
  azureProject?: string;
}

/** Nicht-leerer-String-Validator für die Plattform-Felder. */
function validateNonEmpty(label: string) {
  return (raw: string): { ok: true; value: string } | { ok: false; error: string } =>
    raw.trim().length > 0
      ? { ok: true, value: raw.trim() }
      : { ok: false, error: `${label} must not be empty.` };
}

/** Fragt die PR-Plattform (1–4) ab. */
async function promptPlatform(rl: Interface): Promise<InitPrPlatform> {
  const choices: Record<string, InitPrPlatform> = {
    '1': 'bitbucket',
    '2': 'github',
    '3': 'gitlab',
    '4': 'azure-devops',
  };
  return promptUntilValid(
    rl,
    'PR platform — 1) Bitbucket  2) GitHub  3) GitLab  4) Azure DevOps:',
    (raw) => {
      const value = choices[raw.trim()];
      return value !== undefined
        ? { ok: true as const, value }
        : { ok: false as const, error: 'Enter 1, 2, 3 or 4.' };
    },
  );
}

/** Fragt die gemeinsamen Config-Felder ab (geteilt von Config- und beides-Modus). */
async function promptConfigFields(rl: Interface): Promise<PromptedConfigFields> {
  output.write(colors.bold('\nNow the remaining config fields:\n'));

  const rus = await promptUntilValid(rl, 'List of RUs, separated by commas:', validateRuList);
  const ticket = await promptUntilValid(rl, 'Enter ticket (e.g. AKB-1234):', validateTicket);
  const branch = await promptUntilValid(rl, 'Enter branch name:', validateBranchName);
  const commitMessage = await promptUntilValid(rl, 'Enter commit message:', validateMessage);
  const prSummary = await promptUntilValid(rl, 'Enter PR summary:', validateMessage);
  const createPrOnError = await promptUntilValid(
    rl,
    'If a code change fails, make a PR anyway (Y/N)?',
    validateYesNo,
  );

  const prPlatform = await promptPlatform(rl);
  const fields: PromptedConfigFields = {
    rus, ticket, branch, commitMessage, prSummary, createPrOnError, prPlatform,
  };
  // Plattform-spezifische Adressierung (exactOptionalPropertyTypes: nur setzen,
  // was die gewählte Plattform braucht).
  switch (prPlatform) {
    case 'bitbucket':
      fields.bitbucketWorkspace = await promptUntilValid(
        rl,
        'Bitbucket workspace (slug or project key):',
        validateNonEmpty('Workspace'),
      );
      break;
    case 'github':
      fields.githubOwner = await promptUntilValid(
        rl,
        'GitHub owner (user or organization):',
        validateNonEmpty('Owner'),
      );
      break;
    case 'gitlab':
      fields.gitlabNamespace = await promptUntilValid(
        rl,
        'GitLab namespace (group or user):',
        validateNonEmpty('Namespace'),
      );
      break;
    case 'azure-devops':
      fields.azureOrganization = await promptUntilValid(
        rl,
        'Azure DevOps organization:',
        validateNonEmpty('Organization'),
      );
      fields.azureProject = await promptUntilValid(
        rl,
        'Azure DevOps project:',
        validateNonEmpty('Project'),
      );
      break;
  }

  return fields;
}

/** Schreibt die YAML-Config (Operationen-Variante). */
async function exportConfig(
  rl: Interface,
  opts: InitOptions,
  operations: CollectedOp[],
): Promise<number> {
  const f = await promptConfigFields(rl);

  const yaml = generateYamlConfig({
    ...f,
    operations: operations.map((o) => ({ type: o.type, ...o.params })),
  });

  const target = await resolveOutputPath(rl, opts, 'gitbulk.config.yaml');

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, yaml);
  output.write(colors.green(`\n✓ Wrote config: ${target}\n`));
  output.write(colors.gray(`  Run it via: gitbulk --config ${target}\n`));
  return 0;
}

/**
 * Schreibt BEIDES: ein generiertes Code-Change-Skript UND eine Config, die es
 * über das `script:`-Feld ausführt (statt `operations:`).
 *
 * Pfad-Logik: ohne `--output` werden zwei Dateinamen erfragt (beide in
 * `gitbulk/`). Mit `--output` benennt dieser die CONFIG; das Skript wird mit
 * dem Default-Namen daneben abgelegt. Der `script:`-Wert ist der Skript-Pfad
 * RELATIV ZUM CWD — so löst GitBulk ihn zur Laufzeit auf (wie eine handgepflegte
 * Config; `gitbulk` wird üblicherweise aus dem Repo-Root gestartet).
 */
async function exportBoth(
  rl: Interface,
  opts: InitOptions,
  operations: CollectedOp[],
  language: ScriptLanguage,
): Promise<number> {
  const scriptOps: ScriptOperation[] = operations.map((o) => ({ type: o.type, params: o.params }));
  const { code, unsupported } = generateScript(scriptOps, language);

  if (unsupported.length > 0) {
    process.stderr.write(
      colors.yellow(
        `\nNote: no script generator for: ${[...new Set(unsupported)].join(', ')}. ` +
          'These are left as TODO comments in the script.\n',
      ),
    );
  }

  const scriptDefault = language === 'ts' ? 'gitbulk-change.ts' : 'gitbulk-change.mjs';

  // Zielpfade bestimmen.
  let scriptTarget: string;
  let configTarget: string;
  if (opts.outputPath !== undefined) {
    configTarget = opts.force ? resolve(opts.outputPath) : nextFreePath(resolve(opts.outputPath));
    const sibling = join(dirname(configTarget), scriptDefault);
    scriptTarget = opts.force ? sibling : nextFreePath(sibling);
  } else {
    scriptTarget = await resolveOutputPath(rl, opts, scriptDefault);
    configTarget = await resolveOutputPath(rl, opts, 'gitbulk.config.yaml');
  }

  // Skript schreiben.
  mkdirSync(dirname(scriptTarget), { recursive: true });
  writeFileSync(scriptTarget, code, { mode: 0o755 });
  output.write(colors.green(`\n✓ Wrote script: ${scriptTarget}\n`));

  // Skript-Pfad relativ zum CWD (POSIX-Separatoren für portable YAML).
  const scriptRel = relative(process.cwd(), scriptTarget).split(sep).join('/');

  // Config-Felder erfragen und Config mit `script:` schreiben.
  const f = await promptConfigFields(rl);
  const yaml = generateYamlConfig({ ...f, script: scriptRel });

  mkdirSync(dirname(configTarget), { recursive: true });
  writeFileSync(configTarget, yaml);
  output.write(colors.green(`\n✓ Wrote config: ${configTarget}\n`));
  output.write(colors.gray(`  The config runs the script via "script: ${scriptRel}" — edit it freely.\n`));
  output.write(colors.gray(`  Run it via: gitbulk --config ${configTarget}\n`));
  if (language === 'ts') {
    output.write(
      colors.gray('  TypeScript runs via tsx (npm i -D tsx) or Node >= 22.6 automatically.\n'),
    );
  }
  return 0;
}

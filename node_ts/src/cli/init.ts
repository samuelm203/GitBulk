/**
 * `gitbulk init` — interaktiver Generator.
 *
 * Führt per Prompts durch die verfügbaren Operationen (`collectOperations`),
 * fragt deren Parameter anhand der Zod-Schemas ab und erzeugt am Ende WAHLWEISE:
 *   1. eine lauffähige YAML-Config mit `operations:`-Block, oder
 *   2. ein eigenständiges `.mjs`/`.ts`-Code-Change-Skript (frei anpassbar).
 *
 * Die Operationen-Sammel-Prompts liegen in `cli/operation-prompts.ts` (geteilt
 * mit dem interaktiven Lauf-Modus); die Code-/Config-Erzeugung in eigenen,
 * unit-getesteten Modulen. Diese Datei orchestriert nur Prompts + Datei-Schreiben.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
import { collectOperations, chooseOneOrTwo, type CollectedOp } from './operation-prompts.js';
import {
  generateScript,
  type ScriptOperation,
  type ScriptLanguage,
} from './script-generator.js';
import { generateYamlConfig } from './config-generator.js';

export interface InitOptions {
  /** Optionaler Ausgabepfad (sonst Default je nach Modus oder Prompt). */
  outputPath?: string;
  /** Vorhandene Datei ohne Rückfrage überschreiben. */
  force?: boolean;
  /** Farbe deaktivieren. */
  noColor?: boolean;
}

/** Ermittelt den Zielpfad und prüft Überschreiben. */
async function resolveOutputPath(
  rl: Interface,
  opts: InitOptions,
  defaultName: string,
): Promise<string | undefined> {
  const target = resolve(opts.outputPath ?? defaultName);
  if (existsSync(target) && !opts.force) {
    const overwrite = await promptUntilValid(
      rl,
      `${target} already exists. Overwrite? (Y/N):`,
      validateYesNo,
    );
    if (!overwrite) {
      output.write(colors.yellow('Aborted — no file written.\n'));
      return undefined;
    }
  }
  return target;
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
    const kind = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);

    // ── 2) Bei Skript: Sprache wählen ────────────────────────────
    let language: ScriptLanguage = 'js';
    if (kind === '2') {
      output.write(colors.bold('\nScript language?\n'));
      output.write(`  ${colors.green('1')}. JavaScript (.mjs)\n`);
      output.write(`  ${colors.green('2')}. TypeScript (.ts)\n`);
      const lang = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);
      language = lang === '2' ? 'ts' : 'js';
    }

    // ── 3) Operationen zusammenstellen ───────────────────────────
    const operations = await collectOperations(rl);

    // ── 4) Exportieren ───────────────────────────────────────────
    if (kind === '2') {
      return await exportScript(rl, opts, operations, language);
    }
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
  if (!target) return 3;

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

/** Schreibt die YAML-Config. */
async function exportConfig(
  rl: Interface,
  opts: InitOptions,
  operations: CollectedOp[],
): Promise<number> {
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
  const bitbucketWorkspace = await promptUntilValid(
    rl,
    'Bitbucket workspace (slug or project key):',
    (raw) =>
      raw.trim().length > 0
        ? { ok: true as const, value: raw.trim() }
        : { ok: false as const, error: 'Workspace must not be empty.' },
  );

  const yaml = generateYamlConfig({
    rus,
    ticket,
    branch,
    commitMessage,
    prSummary,
    createPrOnError,
    prPlatform: 'bitbucket',
    bitbucketWorkspace,
    operations: operations.map((o) => ({ type: o.type, ...o.params })),
  });

  const target = await resolveOutputPath(rl, opts, 'gitbulk.config.yaml');
  if (!target) return 3;

  writeFileSync(target, yaml);
  output.write(colors.green(`\n✓ Wrote config: ${target}\n`));
  output.write(colors.gray(`  Run it via: gitbulk --config ${target}\n`));
  return 0;
}

/**
 * `gitbulk init` — interaktiver Generator.
 *
 * Führt per Prompts durch die verfügbaren Operationen (`listOperations()`),
 * fragt deren Parameter anhand der Zod-Schemas ab (siehe
 * `operation-introspect`) und erzeugt am Ende WAHLWEISE:
 *   1. eine lauffähige YAML-Config mit `operations:`-Block, oder
 *   2. ein eigenständiges `.mjs`-Code-Change-Skript (frei anpassbar).
 *
 * Reine Logik (Introspektion, Code-/Config-Erzeugung) liegt in eigenen,
 * unit-getesteten Modulen; diese Datei orchestriert nur die Prompts und das
 * Schreiben der Datei.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';

import { listOperations, getOperation } from '../operations/index.js';
import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateMessage,
  validateYesNo,
} from '../utils/validators.js';
import { describeOperationParams, type ParamSpec } from './operation-introspect.js';
import { promptUntilValid } from './prompts.js';
import {
  generateScript,
  type ScriptOperation,
  type ScriptLanguage,
} from './script-generator.js';
import { generateYamlConfig } from './config-generator.js';

/** Validator für eine "1 oder 2"-Auswahl (für die Eingangsfragen). */
function chooseOneOrTwo(raw: string): { ok: true; value: '1' | '2' } | { ok: false; error: string } {
  const t = raw.trim();
  return t === '1' || t === '2'
    ? { ok: true, value: t }
    : { ok: false, error: 'Please enter 1 or 2.' };
}

export interface InitOptions {
  /** Optionaler Ausgabepfad (sonst Default je nach Modus oder Prompt). */
  outputPath?: string;
  /** Vorhandene Datei ohne Rückfrage überschreiben. */
  force?: boolean;
  /** Farbe deaktivieren. */
  noColor?: boolean;
}

/** Intern gesammelte Operation: Typ + geparste Parameter (inkl. Defaults). */
interface CollectedOp {
  type: string;
  params: Record<string, unknown>;
}

/**
 * Fragt einen einzelnen Operation-Parameter ab.
 * @returns den Wert, oder `undefined` wenn das (optionale) Feld übersprungen wird.
 */
async function promptParam(rl: Interface, spec: ParamSpec): Promise<unknown> {
  const def =
    spec.defaultValue !== undefined ? ` ${chalk.gray(`[default: ${String(spec.defaultValue)}]`)}` : '';
  const opt = spec.required ? '' : chalk.gray(' (optional)');

  if (spec.kind === 'boolean') {
    const hint = spec.required ? '(Y/N)' : '(Y/N, blank = default)';
    for (;;) {
      const raw = (await rl.question(chalk.cyan(`  ${spec.name} ${hint}${def}: `))).trim();
      if (raw === '') {
        return spec.required ? promptRetry(rl, spec) : undefined;
      }
      const res = validateYesNo(raw);
      if (res.ok) return res.value;
      process.stderr.write(`${chalk.red(res.error)}\n`);
    }
  }

  if (spec.kind === 'enum') {
    const values = spec.enumValues ?? [];
    for (;;) {
      const raw = (
        await rl.question(chalk.cyan(`  ${spec.name} (${values.join(' / ')})${def}: `))
      ).trim();
      if (raw === '' && !spec.required) return undefined;
      if (values.includes(raw)) return raw;
      process.stderr.write(`${chalk.red(`Please enter one of: ${values.join(', ')}`)}\n`);
    }
  }

  if (spec.kind === 'number') {
    for (;;) {
      const raw = (await rl.question(chalk.cyan(`  ${spec.name} (number)${def}: `))).trim();
      if (raw === '' && !spec.required) return undefined;
      const n = Number(raw);
      if (raw !== '' && Number.isFinite(n)) return n;
      process.stderr.write(`${chalk.red('Please enter a valid number.')}\n`);
    }
  }

  // string
  for (;;) {
    const raw = await rl.question(chalk.cyan(`  ${spec.name}${opt}${def}: `));
    if (raw === '' && !spec.required) return undefined;
    if (raw.length > 0) return raw;
    process.stderr.write(`${chalk.red('This field is required.')}\n`);
  }
}

/** Kleiner Helfer: erneut nach einem Pflicht-Boolean fragen. */
async function promptRetry(rl: Interface, spec: ParamSpec): Promise<unknown> {
  process.stderr.write(`${chalk.red('This field is required.')}\n`);
  return promptParam(rl, spec);
}

/**
 * Fragt alle Parameter einer Operation ab und validiert sie gegen das
 * registrierte Schema. Bei Validierungsfehler wird die Operation verworfen
 * (Rückgabe `undefined`), damit der Nutzer sie neu wählen kann.
 */
async function collectOperation(rl: Interface, type: string): Promise<CollectedOp | undefined> {
  const op = getOperation(type);
  if (!op) return undefined;

  const specs = describeOperationParams(op.schema);
  const raw: Record<string, unknown> = {};

  output.write(chalk.bold(`\nConfiguring "${type}":\n`));
  for (const spec of specs) {
    const value = await promptParam(rl, spec);
    if (value !== undefined) {
      raw[spec.name] = value;
    }
  }

  const parsed = op.schema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(chalk.red('\nInvalid parameters:\n'));
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      process.stderr.write(chalk.red(`  • ${path}: ${issue.message}\n`));
    }
    return undefined;
  }

  return { type, params: parsed.data as Record<string, unknown> };
}

/**
 * Sammelt interaktiv die Operationskette (mindestens eine Operation).
 */
async function collectOperations(rl: Interface): Promise<CollectedOp[]> {
  const available = listOperations();
  const collected: CollectedOp[] = [];

  for (;;) {
    output.write(chalk.bold('\nAvailable operations:\n'));
    available.forEach((op, i) => {
      output.write(`  ${chalk.green(String(i + 1))}. ${op.type} — ${chalk.gray(op.description)}\n`);
    });
    const doneHint = collected.length > 0 ? " or 'd' to finish" : '';
    const raw = (
      await rl.question(chalk.cyan(`Select an operation (1-${available.length})${doneHint}: `))
    ).trim();

    if (collected.length > 0 && (raw === 'd' || raw === 'D')) {
      return collected;
    }

    const idx = Number(raw);
    const chosen = Number.isInteger(idx) && idx >= 1 && idx <= available.length
      ? available[idx - 1]
      : undefined;
    if (!chosen) {
      process.stderr.write(chalk.red('Invalid selection.\n'));
      continue;
    }

    const op = await collectOperation(rl, chosen.type);
    if (op) {
      collected.push(op);
      output.write(chalk.green(`✓ Added ${op.type} (${collected.length} total).\n`));
    }
  }
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
      output.write(chalk.yellow('Aborted — no file written.\n'));
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
    output.write(chalk.bold('\n━━━ GitBulk init — code-change generator ━━━\n'));

    if (listOperations().length === 0) {
      process.stderr.write(chalk.red('No operations are registered.\n'));
      return 3;
    }

    // ── 1) Art des Code-Change zuerst wählen ─────────────────────
    output.write(chalk.bold('\nWhat do you want to create?\n'));
    output.write(`  ${chalk.green('1')}. A config with declarative operations (YAML)\n`);
    output.write(`  ${chalk.green('2')}. A standalone code-change script\n`);
    const kind = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);

    // ── 2) Bei Skript: Sprache wählen ────────────────────────────
    let language: ScriptLanguage = 'js';
    if (kind === '2') {
      output.write(chalk.bold('\nScript language?\n'));
      output.write(`  ${chalk.green('1')}. JavaScript (.mjs)\n`);
      output.write(`  ${chalk.green('2')}. TypeScript (.ts)\n`);
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
      chalk.yellow(
        `\nNote: no script generator for: ${[...new Set(unsupported)].join(', ')}. ` +
          'These are left as TODO comments in the script.\n',
      ),
    );
  }

  const defaultName = language === 'ts' ? 'gitbulk-change.ts' : 'gitbulk-change.mjs';
  const target = await resolveOutputPath(rl, opts, defaultName);
  if (!target) return 3;

  writeFileSync(target, code, { mode: 0o755 });
  output.write(chalk.green(`\n✓ Wrote standalone script: ${target}\n`));
  output.write(chalk.gray(`  Use it via the "script" field in your config, then edit freely.\n`));
  if (language === 'ts') {
    output.write(
      chalk.gray('  TypeScript runs via tsx (npm i -D tsx) or Node >= 22.6 automatically.\n'),
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
  output.write(chalk.bold('\nNow the remaining config fields:\n'));

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
  output.write(chalk.green(`\n✓ Wrote config: ${target}\n`));
  output.write(chalk.gray(`  Run it via: gitbulk --config ${target}\n`));
  return 0;
}

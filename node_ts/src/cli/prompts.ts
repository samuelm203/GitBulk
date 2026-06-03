/**
 * Interaktive Prompts für GitBulk (Phase 1 "Input from User" des Flowcharts).
 *
 * Jede Eingabe folgt dem Flowchart-Muster:
 *   1. Print 'Prompt-Text' → 2. Input → 3. Validate → 4. bei Fehler erneut.
 *
 * Der interaktive Modus konfiguriert einen Lauf VOLLSTÄNDIG (kein Config-File
 * nötig): RUs/Ticket/Branch, Code-Change (freies Skript ODER deklarative
 * operations), Commit/PR-Texte UND die PR-Plattform inkl. Pflichtfelder.
 *
 * Verwendet `node:readline/promises` (Node 20+) — keine externe Prompt-Library.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import * as colors from '../utils/colors.js';
import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateFilePath,
  validateMessage,
  validateYesNo,
  type ValidationResult,
} from '../utils/validators.js';
import { collectOperations, chooseOneOrTwo, type CollectedOp } from './operation-prompts.js';

/** Bitbucket-Felder aus dem interaktiven Modus. */
export interface InteractiveBitbucket {
  workspace: string;
  targetBranch: string;
  reviewers: string[];
}

/** GitHub-Felder aus dem interaktiven Modus. */
export interface InteractiveGitHub {
  owner: string;
  targetBranch: string;
  reviewers: string[];
}

/**
 * Das Ergebnis der interaktiven Eingabe-Phase — vollständig genug, um daraus
 * ohne Env-Variablen eine valide Config zu bauen.
 */
export interface InteractiveInputResult {
  /** `$config.rus` */
  rus: string[];
  /** `$config.ticket` */
  ticket: string;
  /** `$config.branch` (ohne Ticket-Präfix) */
  branch: string;
  /** Freies Code-Change-Skript (genau eines von `script`/`operations`). */
  script?: string;
  /** Deklarative Operationen (genau eines von `script`/`operations`). */
  operations?: CollectedOp[];
  /** `$config.commitMessage` */
  commitMessage: string;
  /** `$config.prSummary` */
  prSummary: string;
  /** `$config.createPrOnError` */
  createPrOnError: boolean;
  /** Gewählte PR-Plattform. */
  prPlatform: 'bitbucket' | 'github';
  /** Bitbucket-Settings (gesetzt bei `prPlatform === 'bitbucket'`). */
  bitbucket?: InteractiveBitbucket;
  /** GitHub-Settings (gesetzt bei `prPlatform === 'github'`). */
  github?: InteractiveGitHub;
}

/**
 * Fragt wiederholt nach einer Eingabe, bis sie die Validierung besteht.
 */
export async function promptUntilValid<T>(
  rl: Interface,
  promptText: string,
  validator: (raw: string) => ValidationResult<T>,
): Promise<T> {
  while (true) {
    const raw = await rl.question(colors.cyan(`${promptText} `));
    const result = validator(raw);
    if (result.ok) {
      return result.value;
    }
    process.stderr.write(`${colors.red(result.error)}\n`);
  }
}

// ── Kleine Inline-Validatoren für die Zusatz-Felder ───────────────────

/** Nicht-leerer (getrimmter) String. */
function nonEmpty(raw: string): ValidationResult<string> {
  const t = raw.trim();
  return t.length > 0 ? { ok: true, value: t } : { ok: false, error: 'Must not be empty.' };
}

/** Akzeptiert leere Eingabe und liefert dann den Default. */
function orDefault(def: string): (raw: string) => ValidationResult<string> {
  return (raw: string) => {
    const t = raw.trim();
    return { ok: true, value: t.length > 0 ? t : def };
  };
}

/** Komma-separierte Liste; leere Einträge entfernt (immer gültig, auch leer). */
function csvList(raw: string): ValidationResult<string[]> {
  return {
    ok: true,
    value: raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

/**
 * Sammelt eine vollständige interaktive Konfiguration (ein Durchlauf, ohne
 * Bestätigungs-Loop). Nimmt `rl` als Parameter → unit-testbar mit Mock.
 */
export async function collectInteractiveConfig(rl: Interface): Promise<InteractiveInputResult> {
  // 1. RUs / Ticket / Branch
  const rus = await promptUntilValid(rl, 'List of RUs, separated by commas:', validateRuList);
  const ticket = await promptUntilValid(rl, 'Enter ticket (e.g. AKB-1234):', validateTicket);
  const branch = await promptUntilValid(rl, 'Enter branch name:', validateBranchName);

  // 2. Code-Change: Skript ODER Operationen
  output.write(colors.bold('\nHow should the code change be defined?\n'));
  output.write(`  ${colors.green('1')}. A code-change script (path)\n`);
  output.write(`  ${colors.green('2')}. Declarative operations\n`);
  const changeKind = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);

  let script: string | undefined;
  let operations: CollectedOp[] | undefined;
  if (changeKind === '1') {
    script = await promptUntilValid(rl, 'Path to the code script to execute:', validateFilePath);
  } else {
    operations = await collectOperations(rl);
  }

  // 3. Commit / PR-Texte
  const commitMessage = await promptUntilValid(rl, 'Enter commit message:', validateMessage);
  const prSummary = await promptUntilValid(rl, 'Enter PR summary:', validateMessage);
  const createPrOnError = await promptUntilValid(
    rl,
    'If the code change fails, make a PR anyway (Y/N)?',
    validateYesNo,
  );

  // 4. PR-Plattform + Pflichtfelder
  output.write(colors.bold('\nWhich PR platform?\n'));
  output.write(`  ${colors.green('1')}. Bitbucket\n`);
  output.write(`  ${colors.green('2')}. GitHub\n`);
  const platformChoice = await promptUntilValid(rl, 'Choose (1/2):', chooseOneOrTwo);

  const result: InteractiveInputResult = {
    rus,
    ticket,
    branch,
    commitMessage,
    prSummary,
    createPrOnError,
    prPlatform: platformChoice === '2' ? 'github' : 'bitbucket',
  };
  if (script !== undefined) result.script = script;
  if (operations !== undefined) result.operations = operations;

  if (result.prPlatform === 'bitbucket') {
    const workspace = await promptUntilValid(
      rl,
      'Bitbucket workspace (slug or project key):',
      nonEmpty,
    );
    const targetBranch = await promptUntilValid(rl, 'Target branch [default: master]:', orDefault('master'));
    const reviewers = await promptUntilValid(
      rl,
      'Reviewers (comma-separated, optional):',
      csvList,
    );
    result.bitbucket = { workspace, targetBranch, reviewers };
  } else {
    const owner = await promptUntilValid(rl, 'GitHub owner (user or organization):', nonEmpty);
    const targetBranch = await promptUntilValid(rl, 'Target branch [default: main]:', orDefault('main'));
    const reviewers = await promptUntilValid(
      rl,
      'Reviewers (GitHub logins, comma-separated, optional):',
      csvList,
    );
    result.github = { owner, targetBranch, reviewers };
  }

  return result;
}

/**
 * Zeigt eine Zusammenfassung und fragt, ob übernommen oder neu begonnen wird.
 */
export async function confirmConfig(
  rl: Interface,
  config: InteractiveInputResult,
): Promise<boolean> {
  const change = config.script
    ? `script: ${config.script}`
    : `${config.operations?.length ?? 0} operation(s)`;
  const platform =
    config.prPlatform === 'bitbucket'
      ? `bitbucket (workspace: ${config.bitbucket?.workspace ?? '?'}, target: ${config.bitbucket?.targetBranch ?? '?'})`
      : `github (owner: ${config.github?.owner ?? '?'}, target: ${config.github?.targetBranch ?? '?'})`;

  // Reviewer-Liste der gewählten Plattform (für die dynamische Zeile unten).
  const reviewers =
    config.prPlatform === 'bitbucket'
      ? config.bitbucket?.reviewers ?? []
      : config.github?.reviewers ?? [];

  output.write('\n');
  output.write(colors.bold('━━━ Configuration Summary ━━━\n'));
  output.write(`  ${colors.gray('RUs:')}             ${config.rus.join(', ')}\n`);
  output.write(`  ${colors.gray('Ticket:')}          ${config.ticket}\n`);
  output.write(`  ${colors.gray('Branch:')}          ${config.ticket}-${config.branch}\n`);
  output.write(`  ${colors.gray('Code change:')}     ${change}\n`);
  output.write(`  ${colors.gray('Commit message:')}  ${config.commitMessage}\n`);
  output.write(`  ${colors.gray('PR summary:')}      ${config.prSummary}\n`);
  output.write(`  ${colors.gray('PR on error:')}     ${config.createPrOnError ? 'Yes' : 'No'}\n`);
  output.write(`  ${colors.gray('PR platform:')}     ${platform}\n`);
  // Reviewers NUR anzeigen, wenn welche gesetzt sind (sonst Zeile komplett weglassen).
  if (reviewers.length > 0) {
    output.write(`  ${colors.gray('Reviewers:')}       ${reviewers.join(', ')}\n`);
  }
  output.write(colors.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'));

  return promptUntilValid(rl, 'Confirm configuration? (Y/N):', validateYesNo);
}

/**
 * Führt die komplette interaktive Eingabe-Phase (Sammeln + Bestätigung) durch.
 * Bei "N" beginnt die Sequenz von vorn.
 */
export async function runInteractivePrompts(): Promise<InteractiveInputResult> {
  const rl = createInterface({ input, output });

  try {
    while (true) {
      output.write(colors.bold('\n━━━ GitBulk Configuration ━━━\n\n'));
      const config = await collectInteractiveConfig(rl);
      if (await confirmConfig(rl, config)) {
        return config;
      }
      output.write(colors.yellow('\nRestarting configuration...\n'));
    }
  } finally {
    rl.close();
  }
}

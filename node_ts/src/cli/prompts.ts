/**
 * Interaktive Prompts für GitBulk (Phase 1 "Input from User" des Flowcharts).
 *
 * Jede Eingabe folgt dem Flowchart-Muster:
 *   1. Print 'Prompt-Text'
 *   2. Input <variable>
 *   3. Validate
 *   4. Bei Fehler → Error ausgeben → zurück zu Schritt 1
 *
 * Außerdem implementiert dieses Modul den Bestätigungs-Loop am Ende von Phase 1:
 * Config-Zusammenfassung anzeigen → Y/N → ggf. von vorn beginnen.
 *
 * Verwendet die in Node 20+ verfügbare `readline/promises`-API,
 * damit wir ohne externe Prompt-Library auskommen.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import chalk from 'chalk';
import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateFilePath,
  validateMessage,
  validateYesNo,
  type ValidationResult,
} from '../utils/validators.js';

/**
 * Das Ergebnis der interaktiven Eingabe-Phase.
 * Spiegelt 1:1 die `$config`-Variablen aus dem Flowchart wider.
 */
export interface InteractiveInputResult {
  /** `$config.rus` — Liste der Repository-Units */
  rus: string[];
  /** `$config.ticket` — z. B. `AKB-1234`, wird im Branch-Namen vorangestellt */
  ticket: string;
  /** `$config.branch` — sanitisierter Branch-Name (ohne Ticket-Präfix) */
  branch: string;
  /** `$config.script` — absoluter Pfad zum Code-Change-Skript */
  script: string;
  /** `$config.commitMessage` — Commit-Message für `git commit -m '...'` */
  commitMessage: string;
  /** `$config.prSummary` — Titel/Beschreibung der Pull Requests */
  prSummary: string;
  /** `$config.createPrOnError` — PR trotzdem erstellen, wenn Code-Change fehlschlägt? */
  createPrOnError: boolean;
}

/**
 * Fragt wiederholt nach einer Eingabe, bis sie die Validierung besteht.
 * Entspricht der Schleife "Print Error → erneut prompten" aus dem Flowchart.
 *
 * @param rl - aktive readline-Instanz
 * @param promptText - Anzeigetext (entspricht `Print '...'` im Flowchart)
 * @param validator - Validierungsfunktion (entspricht der Diamant-Raute)
 * @returns Validierter Wert
 */
async function promptUntilValid<T>(
  rl: Interface,
  promptText: string,
  validator: (raw: string) => ValidationResult<T>,
): Promise<T> {
  // Endlosschleife — wird nur durch erfolgreiche Validierung verlassen.
  // SIGINT/Ctrl+C beendet den Prozess auf der Ebene des CLI-Einstiegs.

  while (true) {
    const raw = await rl.question(chalk.cyan(`${promptText} `));
    const result = validator(raw);

    if (result.ok) {
      return result.value;
    }

    // Fehler auf stderr — passt zu Anwendungs-Logs in CI-Pipelines.
    process.stderr.write(`${chalk.red(result.error)}\n`);
  }
}

/**
 * Zeigt eine Zusammenfassung der gesammelten Konfiguration und fragt
 * den User, ob sie übernommen oder von vorn begonnen werden soll
 * (Flowchart: Confirmation-Loop am Ende von Phase 1).
 *
 * @returns `true` wenn der User die Config bestätigt, `false` für Neustart
 */
async function confirmConfig(rl: Interface, config: InteractiveInputResult): Promise<boolean> {
  output.write('\n');
  output.write(chalk.bold('━━━ Configuration Summary ━━━\n'));
  output.write(`  ${chalk.gray('RUs:')}             ${config.rus.join(', ')}\n`);
  output.write(`  ${chalk.gray('Ticket:')}          ${config.ticket}\n`);
  output.write(`  ${chalk.gray('Branch:')}          ${config.ticket}-${config.branch}\n`);
  output.write(`  ${chalk.gray('Script:')}          ${config.script}\n`);
  output.write(`  ${chalk.gray('Commit message:')}  ${config.commitMessage}\n`);
  output.write(`  ${chalk.gray('PR summary:')}      ${config.prSummary}\n`);
  output.write(
    `  ${chalk.gray('PR on error:')}     ${config.createPrOnError ? 'Yes' : 'No'}\n`,
  );
  output.write(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'));

  return promptUntilValid(rl, 'Confirm configuration? (Y/N):', validateYesNo);
}

/**
 * Führt die komplette interaktive Eingabe-Phase (Phase 1 + Bestätigung) durch.
 *
 * Bei "N" in der Bestätigung wird `Restarting configuration...` ausgegeben
 * und die gesamte Eingabesequenz beginnt von vorn — entsprechend
 * dem Flowchart.
 *
 * @returns Validierte Konfiguration, bereit zum "Freeze" in Phase 2
 */
export async function runInteractivePrompts(): Promise<InteractiveInputResult> {
  const rl = createInterface({ input, output });

  try {
    // Outer loop: wiederholt sich, wenn der User die Zusammenfassung ablehnt.
    while (true) {
      output.write(chalk.bold('\n━━━ GitBulk Configuration ━━━\n\n'));

      // 1. RU-Liste
      const rus = await promptUntilValid(
        rl,
        'List of RUs, separated by commas:',
        validateRuList,
      );

      // 2. Ticket (eigener Schritt, wie vom User angefordert)
      const ticket = await promptUntilValid(
        rl,
        'Enter ticket (e.g. AKB-1234):',
        validateTicket,
      );

      // 3. Branch-Name
      const branch = await promptUntilValid(rl, 'Enter branch name:', validateBranchName);

      // 4. Pfad zum Code-Change-Skript
      const script = await promptUntilValid(
        rl,
        'Path to the code script to execute:',
        validateFilePath,
      );

      // 5. Commit-Message
      const commitMessage = await promptUntilValid(rl, 'Enter commit message:', validateMessage);

      // 6. PR-Summary
      const prSummary = await promptUntilValid(rl, 'Enter PR summary:', validateMessage);

      // 7. PR auch bei fehlerhaftem Code-Change? (Y/N)
      const createPrOnError = await promptUntilValid(
        rl,
        'If Change_code failed, make a PR anyway (Y/N)?',
        validateYesNo,
      );

      const config: InteractiveInputResult = {
        rus,
        ticket,
        branch,
        script,
        commitMessage,
        prSummary,
        createPrOnError,
      };

      // Bestätigungs-Loop
      const confirmed = await confirmConfig(rl, config);
      if (confirmed) {
        return config;
      }

      output.write(chalk.yellow('\nRestarting configuration...\n'));
    }
  } finally {
    rl.close();
  }
}

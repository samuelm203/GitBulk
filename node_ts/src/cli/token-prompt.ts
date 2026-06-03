/**
 * Auth-Guard: stellt sicher, dass der für die PR-Plattform nötige Token
 * vorhanden ist, BEVOR der Lauf startet.
 *
 * Tokens werden NIE aus der Config gelesen — immer aus Env-Variablen. Fehlt der
 * Token, wird im echten Terminal interaktiv (maskiert) danach gefragt und der
 * Wert nur im Prozess-`env` gesetzt (nie geloggt/gespeichert). In Nicht-TTY-/
 * CI-Umgebungen gibt es stattdessen einen klaren Fehler.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { Writable } from 'node:stream';

import type { GitBulkConfig } from '../config/schema.js';

/** PR-Plattform (aus der Config). */
export type PrPlatform = GitBulkConfig['prPlatform'];

/** Ergebnis des Auth-Guards. */
export type EnsureTokenResult = { ok: true } | { ok: false; error: string };

/** Optionen für {@link ensurePrToken} (env/prompt injizierbar für Tests). */
export interface EnsureTokenOptions {
  /** Darf im echten Terminal interaktiv gefragt werden? (TTY) */
  interactive: boolean;
  /** Env-Map (Default: `process.env`) — injizierbar für Tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Prompt-Funktion (Default: maskierte readline-Abfrage). Injizierbar, damit
   * der interaktive Pfad ohne echtes Terminal getestet werden kann.
   */
  prompt?: (varName: string, platform: PrPlatform) => Promise<string>;
}

/**
 * Liefert den Namen der Env-Variable, aus der der Token der Plattform gelesen
 * wird, oder `undefined` für Plattformen ohne definierten Token.
 */
export function prTokenEnvVar(platform: PrPlatform): string | undefined {
  switch (platform) {
    case 'bitbucket':
      return 'GITBULK_BITBUCKET_TOKEN';
    case 'github':
      return 'GITBULK_GITHUB_TOKEN';
    case 'azure-devops':
      return 'GITBULK_AZURE_DEVOPS_TOKEN';
    default:
      return undefined;
  }
}

/**
 * Stellt sicher, dass der Plattform-Token gesetzt ist.
 *
 * - Token vorhanden → ok.
 * - Fehlt + interaktiv → maskiert abfragen, in `env` setzen, ok (oder Fehler
 *   bei leerer Eingabe).
 * - Fehlt + nicht-interaktiv → Fehler (Aufrufer bricht mit Exit 3 ab).
 */
export async function ensurePrToken(
  platform: PrPlatform,
  opts: EnsureTokenOptions,
): Promise<EnsureTokenResult> {
  const varName = prTokenEnvVar(platform);
  // Unbekannte/ohne-Token-Plattform: nicht hier behandeln (Adapter meldet selbst).
  if (varName === undefined) return { ok: true };

  const env = opts.env ?? process.env;
  const current = env[varName];
  if (current !== undefined && current.trim().length > 0) {
    return { ok: true };
  }

  if (!opts.interactive) {
    return {
      ok: false,
      error:
        `Environment variable ${varName} is required for ${platform} PR creation. ` +
        'Set it and re-run, or run in an interactive terminal to be prompted.',
    };
  }

  const promptFn = opts.prompt ?? promptForTokenMasked;
  const entered = (await promptFn(varName, platform)).trim();
  if (entered.length === 0) {
    return { ok: false, error: `No token entered for ${varName}.` };
  }
  env[varName] = entered;
  return { ok: true };
}

/**
 * Fragt den Token maskiert ab (kein Echo). Nutzt eine „stumme" Output-Senke
 * für die readline-Instanz, sodass Tastenanschläge nicht sichtbar sind; der
 * Prompt selbst geht nach stderr.
 *
 * Nur im echten Terminal aufgerufen (interaktiv). Nicht unit-getestet —
 * readline/TTY-Eingabe ist im Test-Harness nicht reproduzierbar.
 */
async function promptForTokenMasked(varName: string, platform: PrPlatform): Promise<string> {
  // Stumme Senke: verschluckt das Echo der Eingabe vollständig.
  const muted = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  try {
    stderr.write(`\n${platform} token not found.\nEnter ${varName} (input hidden): `);
    const answer = await rl.question('');
    stderr.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

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
import { readStoredToken } from './credentials.js';

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
  /**
   * Liest einen persistent gespeicherten Token (`gitbulk auth login`).
   * Default: `credentials.readStoredToken`. Injizierbar für Tests.
   */
  readStored?: (platform: PrPlatform) => string | undefined;
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
    case 'gitlab':
      return 'GITBULK_GITLAB_TOKEN';
    case 'azure-devops':
      // Adapter ist noch nicht implementiert — hier KEINEN Token abfragen,
      // sonst tippt der Nutzer einen Token ein und bekommt direkt danach
      // "not implemented" vom Adapter. Sobald der Adapter existiert:
      // 'GITBULK_AZURE_DEVOPS_TOKEN'.
      return undefined;
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

  // 2. Persistent gespeicherter Token (gitbulk auth login). Env behält Vorrang;
  //    ein gefundener Token wird in die Env gelegt, damit der Adapter ihn liest.
  const readStored =
    opts.readStored ??
    ((p: PrPlatform): string | undefined =>
      p === 'bitbucket' || p === 'github' || p === 'gitlab' ? readStoredToken(p) : undefined);
  const stored = readStored(platform);
  if (stored !== undefined && stored.trim().length > 0) {
    env[varName] = stored.trim();
    return { ok: true };
  }

  if (!opts.interactive) {
    return {
      ok: false,
      error:
        `Environment variable ${varName} is required for ${platform} PR creation. ` +
        `Set it, run \`gitbulk auth login --platform ${platform}\` to store it once, ` +
        'or run in an interactive terminal to be prompted.',
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
  return promptMaskedSecret(`\n${platform} token not found.\nEnter ${varName} (input hidden): `);
}

/**
 * Liest eine Eingabe maskiert (kein Echo) vom Terminal — für Tokens/Secrets.
 * Eine „stumme" Output-Senke verschluckt jeden Tastenanschlag; der Prompt-Text
 * selbst geht nach stderr. Nur im echten Terminal aufrufen (interaktiv).
 *
 * Wiederverwendet von `gitbulk auth login` (siehe `auth.ts`).
 */
export async function promptMaskedSecret(promptLine: string): Promise<string> {
  const muted = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  try {
    stderr.write(promptLine);
    const answer = await rl.question('');
    stderr.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

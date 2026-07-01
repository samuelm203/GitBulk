/**
 * `gitbulk auth` — verwaltet persistent gespeicherte PR-Tokens.
 *
 *   gitbulk auth login  --platform bitbucket|github|gitlab|azure-devops   Token speichern
 *   gitbulk auth logout [--platform …]                Token entfernen (ohne = alle)
 *   gitbulk auth status                               zeigt, welche Tokens vorliegen
 *
 * Der Token landet in `~/.gitbulk/credentials.json` (außerhalb jedes Repos,
 * Rechte 0600). Zur Laufzeit hat die Env-Variable IMMER Vorrang. Tokens werden
 * NIE ausgegeben oder geloggt — `status` zeigt nur, OB ein Token vorhanden ist.
 */

import process from 'node:process';

import * as colors from '../utils/colors.js';
import {
  writeStoredToken,
  deleteStoredToken,
  listStoredPlatforms,
  credentialsPath,
  TOKEN_PLATFORMS,
  type TokenPlatform,
} from './credentials.js';
import { prTokenEnvVar, promptMaskedSecret } from './token-prompt.js';

export type AuthAction = 'login' | 'logout' | 'status';

export interface AuthOptions {
  action: AuthAction;
  /** Zielplattform (Pflicht für `login`; optional für `logout`). */
  platform?: TokenPlatform;
  /** Darf interaktiv (maskiert) gefragt werden? (TTY) */
  interactive: boolean;
  noColor?: boolean;
  /** Env-Map (für Speicherort via GITBULK_HOME / Vorrang-Anzeige). */
  env?: NodeJS.ProcessEnv;
  /** Token-Eingabe (Default: maskierte Terminal-Abfrage). Injizierbar für Tests. */
  promptToken?: (platform: TokenPlatform) => Promise<string>;
}

function fail(message: string, noColor: boolean): number {
  const prefix = noColor ? 'Error:' : colors.redBold('Error:');
  process.stderr.write(`${prefix} ${message}\n`);
  return 3;
}

/**
 * Führt das `auth`-Subkommando aus.
 *
 * @returns Exit-Code (0 = ok, 3 = Nutzungs-/Eingabefehler).
 */
export async function runAuth(opts: AuthOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const noColor = opts.noColor ?? false;

  switch (opts.action) {
    case 'login': {
      if (opts.platform === undefined) {
        return fail(
          '`auth login` requires --platform bitbucket|github|gitlab|azure-devops.',
          noColor,
        );
      }
      if (!opts.interactive && opts.promptToken === undefined) {
        return fail(
          'Cannot read a token without a terminal. Run `gitbulk auth login` interactively, ' +
            `or set ${prTokenEnvVar(opts.platform) ?? 'the token env var'} directly.`,
          noColor,
        );
      }
      const promptToken =
        opts.promptToken ??
        ((p: TokenPlatform): Promise<string> =>
          promptMaskedSecret(`Enter ${prTokenEnvVar(p) ?? 'token'} for ${p} (input hidden): `));
      const token = (await promptToken(opts.platform)).trim();
      if (token.length === 0) {
        return fail('No token entered — nothing saved.', noColor);
      }
      const path = writeStoredToken(opts.platform, token, env);
      process.stderr.write(`Saved ${opts.platform} token to ${path} (file mode 0600).\n`);
      return 0;
    }

    case 'logout': {
      const target: TokenPlatform | 'all' = opts.platform ?? 'all';
      const removed = deleteStoredToken(target, env);
      if (removed) {
        process.stderr.write(
          target === 'all'
            ? 'Removed all stored GitBulk tokens.\n'
            : `Removed stored ${target} token.\n`,
        );
      } else {
        process.stderr.write(
          target === 'all'
            ? 'No stored tokens to remove.\n'
            : `No stored ${target} token to remove.\n`,
        );
      }
      return 0;
    }

    case 'status': {
      const stored = new Set(listStoredPlatforms(env));
      const out = process.stdout;
      out.write(`Credential store: ${credentialsPath(env)}\n`);
      out.write('Resolution order: env var > stored token > interactive prompt\n\n');
      for (const platform of TOKEN_PLATFORMS) {
        const varName = prTokenEnvVar(platform);
        const envSet = varName !== undefined && (env[varName]?.trim().length ?? 0) > 0;
        const hasStored = stored.has(platform);
        const active = envSet ? 'env var' : hasStored ? 'stored' : 'none';
        out.write(
          `  ${platform.padEnd(10)} env:${envSet ? 'yes' : ' no'}  stored:${hasStored ? 'yes' : ' no'}  → ${active}\n`,
        );
      }
      return 0;
    }
  }
}

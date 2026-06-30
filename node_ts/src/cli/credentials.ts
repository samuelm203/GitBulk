/**
 * Persistenter Token-Speicher (`gitbulk auth login`).
 *
 * Tokens werden — bewusst NICHT in der Projekt-Config, sondern — in einer
 * nutzereigenen Datei AUSSERHALB des Repos abgelegt:
 *   `~/.gitbulk/credentials.json`  (Verzeichnis 0700, Datei 0600)
 *
 * Auflösungs-Reihenfolge zur Laufzeit (siehe `token-prompt.ts`):
 *   1. Env-Variable (hat IMMER Vorrang)
 *   2. hier gespeicherter Token
 *   3. interaktive Abfrage
 *
 * Sicherheit: Klartext auf der Platte (wie `~/.npmrc` / git-credentials), aber
 * mit restriktiven Rechten und außerhalb jedes Repos. Tokens werden NIE
 * geloggt. Speicherort über `GITBULK_HOME` umlenkbar (auch für Tests).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import process from 'node:process';

/** Plattformen mit Token-Unterstützung (Azure DevOps: noch kein Adapter). */
export type TokenPlatform = 'bitbucket' | 'github' | 'gitlab';

export const TOKEN_PLATFORMS: readonly TokenPlatform[] = ['bitbucket', 'github', 'gitlab'];

interface CredentialsFile {
  tokens: Partial<Record<TokenPlatform, string>>;
}

/** Basisverzeichnis des Stores (`GITBULK_HOME` übersteuert `~/.gitbulk`). */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GITBULK_HOME;
  if (override !== undefined && override.trim().length > 0) return override;
  return join(homedir(), '.gitbulk');
}

/** Voller Pfad zur Credentials-Datei. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(credentialsDir(env), 'credentials.json');
}

/** Liest die Datei defensiv; bei Fehlen/Korruptheit → leerer Store. */
function readFile(path: string): CredentialsFile {
  if (!existsSync(path)) return { tokens: {} };
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (data !== null && typeof data === 'object') {
      const tokens = (data as { tokens?: unknown }).tokens;
      if (tokens !== null && typeof tokens === 'object') {
        return { tokens: { ...(tokens as Partial<Record<TokenPlatform, string>>) } };
      }
    }
  } catch {
    // Korrupt → wie leer behandeln (nicht crashen).
  }
  return { tokens: {} };
}

/** Gespeicherten Token einer Plattform lesen (oder `undefined`). */
export function readStoredToken(
  platform: TokenPlatform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = readFile(credentialsPath(env)).tokens[platform];
  return token !== undefined && token.trim().length > 0 ? token : undefined;
}

/** Token speichern (Verzeichnis/Datei mit restriktiven Rechten). Liefert den Pfad. */
export function writeStoredToken(
  platform: TokenPlatform,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = credentialsDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  const store = readFile(path);
  store.tokens[platform] = token;
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // mode bei writeFileSync greift nur beim Neuanlegen → bei bestehender Datei
  // explizit nachziehen (best effort; unter Windows weitgehend wirkungslos).
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / fremdes FS — ignorieren */
  }
  return path;
}

/**
 * Token entfernen. `'all'` löscht die gesamte Datei. Liefert `true`, wenn etwas
 * entfernt wurde.
 */
export function deleteStoredToken(
  platform: TokenPlatform | 'all',
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  if (platform === 'all') {
    rmSync(path, { force: true });
    return true;
  }
  const store = readFile(path);
  if (store.tokens[platform] === undefined) return false;
  delete store.tokens[platform];
  if (Object.keys(store.tokens).length === 0) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }
  return true;
}

/** Plattformen mit gespeichertem Token (für `gitbulk auth status`). */
export function listStoredPlatforms(env: NodeJS.ProcessEnv = process.env): TokenPlatform[] {
  const tokens = readFile(credentialsPath(env)).tokens;
  return TOKEN_PLATFORMS.filter((p) => {
    const t = tokens[p];
    return t !== undefined && t.trim().length > 0;
  });
}

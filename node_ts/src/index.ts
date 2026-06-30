/**
 * GitBulk — öffentliche API zum programmatischen Verwenden aus eigenen
 * Skripten heraus (sowohl TS als auch JS).
 *
 * @example TypeScript
 * ```ts
 * import { runBulk, type GitBulkConfig } from 'gitbulk';
 * ```
 *
 * @example JavaScript (ESM)
 * ```js
 * import { runBulk } from 'gitbulk';
 * ```
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// TODO: Öffentliche API hier exportieren, sobald die Module implementiert sind.
// export { runBulk } from './core/runner.js';
// export type { GitBulkConfig, RepositoryConfig } from './config/types.js';

/**
 * Paket-Version — zur Laufzeit aus der `package.json` gelesen statt hartcodiert,
 * damit `gitbulk --version` IMMER mit der veröffentlichten Version übereinstimmt
 * (kein manuelles Nachpflegen je Release). Aus `dist/index.js` liegt die
 * `package.json` eine Ebene höher (Paket-Wurzel); im Dev-Modus (`src/index.ts`
 * via tsx) gilt derselbe relative Pfad.
 *
 * Defensiv in try/catch: das Lesen passiert beim Modul-Import — schlägt es fehl
 * (gebündelte Nutzung über esbuild/Vite/…, verschobenes dist, fehlende Datei),
 * darf NICHT das ganze Paket beim Import crashen. Dann gilt der Fallback.
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // gebündelt / verschoben / unlesbar — Fallback nutzen, nicht werfen.
  }
  return '0.0.0';
}

export const VERSION = readPackageVersion();

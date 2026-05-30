/**
 * RU-Filter für die `--only`-CLI-Option.
 *
 * Erlaubt es, einen Lauf auf eine Teilmenge der konfigurierten RUs zu
 * beschränken, ohne die Config zu ändern — praktisch zum Testen einzelner
 * Repositories.
 */

import type { GitBulkConfig } from '../config/schema.js';

/**
 * Filtert `config.rus` auf die in `only` genannten RUs (komma-separiert).
 *
 * @param config - Die geladene (gefreezte) Config.
 * @param only   - Komma-separierte RU-Namen, oder `undefined` (= kein Filter).
 * @returns Eine neue, gefreezte Config mit reduzierter `rus`-Liste — oder die
 *          unveränderte Config, wenn `only` leer/undefined ist.
 * @throws {Error} bei unbekannten RU-Namen oder leerem Ergebnis.
 */
export function filterRus(config: GitBulkConfig, only: string | undefined): GitBulkConfig {
  if (only === undefined || only.trim().length === 0) {
    return config;
  }

  const wanted = only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (wanted.length === 0) {
    return config;
  }

  const unknown = wanted.filter((w) => !config.rus.includes(w));
  if (unknown.length > 0) {
    throw new Error(
      `--only: unknown RU(s): ${unknown.join(', ')}. Configured RUs: ${config.rus.join(', ')}`,
    );
  }

  // Reihenfolge der Config beibehalten, nur die gewünschten behalten.
  const filtered = config.rus.filter((r) => wanted.includes(r));
  if (filtered.length === 0) {
    throw new Error('--only: no RUs left after filtering');
  }

  return Object.freeze({ ...config, rus: filtered });
}

/**aus eigenen Skripten heraus verwenden (sowohl TS als auch JS).
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

// TODO: Öffentliche API hier exportieren, sobald die Module implementiert sind.
// export { runBulk } from './core/runner.js';
// export type { GitBulkConfig, RepositoryConfig } from './config/types.js';

export const VERSION = '0.1.0';

* GitBulk - Public API
 *
 * Dieser Entry Point exportiert die öffentliche Programmier-API von GitBulk.
 * Damit lässt sich GitBulk nicht nur als CLI, sondern auch programmatisch
 *
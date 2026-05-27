/**
 * GitBulk - Public API
 *
 * Dieser Entry Point exportiert die öffentliche Programmier-API von GitBulk.
 * Damit lässt sich GitBulk nicht nur als CLI, sondern auch programmatisch
 * aus eigenen Skripten heraus verwenden (sowohl TS als auch JS).
 *
 * @example TypeScript
 * ```ts
 * import { runBulk, loadConfig, type GitBulkConfig } from 'gitbulk';
 *
 * const config = await loadConfig({ path: './gitbulk.config.yaml' });
 * const summary = await runBulk(config);
 * console.log(`${summary.totals.prsCreated} PRs created`);
 * ```
 */

export const VERSION = '0.1.0';

// Core API
export { runBulk } from './core/runner.js';
export type { RuResult, RunSummary, RunOptions } from './core/runner.js';
export { printRunSummary } from './core/reporter.js';

// Config
export { loadConfig, ConfigError } from './config/loader.js';
export type { GitBulkConfig, BitbucketConfig, RetryConfig, PrPlatform } from './config/schema.js';

// PR-Adapter (für Custom-Plattform-Implementierungen)
export { createPrAdapter, PrAdapterError } from './git/pr-adapter.js';
export type {
  PullRequestAdapter,
  CreatePrInput,
  CreatePrResult,
} from './git/pr-adapter.js';

// Logger
export { createLogger, getDefaultLogger, setDefaultLogger } from './utils/logger.js';
export type { Logger, LogLevel, LoggerOptions } from './utils/logger.js';

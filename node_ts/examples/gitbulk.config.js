/**
 * GitBulk — Beispielkonfiguration (JavaScript)
 *
 * Nutzt JSDoc für Type-Hints. So profitierst du auch in JS von Autocomplete
 * und Validierung im Editor (z. B. VS Code).
 */

/** @type {import('../src/config/schema.js').GitBulkConfig} */
const config = {
  rus: ['my-service-api', 'my-service-frontend', 'my-service-worker'],
  ticket: 'AKB-1234',
  branch: 'feature/update-dependencies',
  script: './scripts/update-deps.sh',
  commitMessage: 'feat: update shared dependencies',
  prSummary: 'Update shared dependencies across services',
  createPrOnError: false,

  workspaceDir: process.env.WORKSPACE ?? `${process.env.HOME}/work/repos`,
  cloneIfMissing: false,
  sourceBranch: 'master',

  retry: {
    maxAttempts: 3,
    backoffMs: 1000,
    maxBackoffMs: 30_000,
  },

  concurrency: 1,
  commandTimeoutMs: 120_000,
  dryRun: false,

  prPlatform: 'bitbucket',
  bitbucket: {
    workspace: 'my-workspace',
    targetBranch: 'master',
    reviewers: [],
  },
};

export default config;

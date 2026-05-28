# GitBulk

> Configurable CLI tool for bulk operations on Git repositories.

GitBulk allows you to perform defined Git operations (cloning, pulling, branching, code changes, commit and push) across many repositories in a configuration-driven way — robust, parallel, and traceable.

## Status

**In Development** — Currently building the core framework.

## Requirements

- **Node.js**: >= 20.0.0
- **Git**: Installed and available in PATH (`git --version`)

## Installation (Development)

```bash
git clone <repo-url>
cd GitBulk
npm install
npm run build
```

To use it globally during development:
```bash
npm link
```

## Usage

```bash
gitbulk [options]
```

### CLI Options

| Option | Description | Default |
| --- | --- | --- |
| `-c, --config <path>` | Path to a config file (`.yaml`, `.yml`, `.json`, `.js`, `.mjs`, `.ts`) | - |
| `-m, --mode <mode>` | Config mode: `strict` (file must be complete) or `hybrid` (prompt for missing) | `hybrid` |
| `--dry-run` | Skip write operations (push, PR API calls) | `false` |
| `-l, --log-level <level>` | `debug`, `info`, `warn`, `error` | `info` |
| `--no-color` | Disable colored output | - |
| `-v, --version` | Print version and exit | - |

## Configuration

GitBulk can be configured via files or a combination of files and environment variables.

### Environment Variables

Useful for CI/CD or providing sensitive credentials:

- `GITBULK_BITBUCKET_TOKEN`: Token for Bitbucket API.
- `GITBULK_PR_PLATFORM`: `bitbucket` or `azure-devops`.
- `GITBULK_BITBUCKET_WORKSPACE`: Bitbucket workspace name.
- `GITBULK_BITBUCKET_API_URL`: Custom Bitbucket API URL.
- `GITBULK_BITBUCKET_TARGET_BRANCH`: Target branch for PRs (default: `master`).
- `GITBULK_BITBUCKET_REVIEWERS`: Comma-separated list of reviewer UUIDs/account IDs.

### Config File Example (YAML)

```yaml
repositories:
  - name: my-repo
    path: ./repos/my-repo
prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
  targetBranch: main
concurrency: 5
```

## Development Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run CLI directly from TypeScript (via tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Run type checking |
| `npm run lint` | Lint source code with ESLint |
| `npm run format` | Format code with Prettier |
| `npm test` | Run tests using Node.js Test Runner |
| `npm run test:coverage` | Run tests with coverage report |

## Project Structure

```text
src/
├── cli/        # CLI entry point, argument parsing, interactive prompts
├── config/     # Config loaders (YAML/JSON/JS/TS) and Zod schema validation
├── core/       # Bulk runner orchestration, execution logic, and reporting
├── git/        # Git command execution and PR platform adapters
└── utils/      # Logger, validators, and shared helpers
tests/          # Test suites
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

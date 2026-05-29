# GitBulk

[![CI](https://github.com/samuelm203/GitBulk/actions/workflows/ci.yml/badge.svg)](https://github.com/samuelm203/GitBulk/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org)

**GitBulk** is a configurable command-line tool for running bulk operations across many Git
repositories at once. Define a code change once, point GitBulk at a list of repositories
("RUs" — repository units), and it will clone/update each one, run your change, commit, push a
feature branch, and open a pull request — in parallel, with retries, and with a clear report at
the end.

It is designed to be **modular, safe, and cross-platform** (Linux, macOS, Windows), with careful
error handling so that a failure in one repository never derails the rest of the run.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI options](#cli-options)
- [Terminal UI (TUI)](#terminal-ui-tui)
- [How a run works](#how-a-run-works)
- [Exit codes](#exit-codes)
- [Edge cases & safety](#edge-cases--safety)
- [Development](#development)
- [License](#license)

---

## Features

- **Bulk operations** across any number of repositories from a single config.
- **Parallel execution** with a configurable concurrency limit.
- **Custom code-change scripts** per repository (any executable: `.sh`, `.bat`, `.cmd`,
  `.ps1`, `.js`/`.mjs`). The right interpreter is chosen automatically per platform.
- **Pull-request automation** for Bitbucket (Cloud and Server). The adapter layer is
  extensible for additional platforms.
- **Automatic retries** with exponential backoff on transient API failures.
- **Robust error handling**: per-repository isolation, timeouts with full process-tree
  termination, and graceful abort on `Ctrl+C`.
- **Cross-platform**: continuously tested on Linux, macOS, and Windows.
- **Optional Terminal UI** with a live, animated per-repository progress view.
- **Dry-run mode** to preview a run without pushing or creating PRs.
- **Zero heavy runtime dependencies** for the UI — built on ANSI + `readline`.

---

## Requirements

- **Node.js >= 20**
- **Git** installed and available on the `PATH`
  - On Windows, Git for Windows is sufficient; GitBulk locates the bundled `sh.exe`
    automatically to run `.sh` scripts.

---

## Installation

> GitBulk lives in the `node_ts/` subdirectory of the repository.

```bash
git clone https://github.com/samuelm203/GitBulk.git
cd GitBulk/node_ts
npm install
npm run build
```

This produces the executable entry point at `dist/cli/index.js`. You can run it directly with
Node, or link it locally:

```bash
# Run directly
node dist/cli/index.js --help

# Or link it as a global "gitbulk" command for local development
npm link
gitbulk --help
```

---

## Quick start

1. Write a small code-change script, e.g. `update-deps.sh`:

   ```sh
   #!/bin/sh
   # Available environment variables:
   #   $GITBULK_RU, $GITBULK_TICKET, $GITBULK_BRANCH, $GITBULK_SOURCE_BRANCH
   npm update --save
   ```

2. Create a config file, e.g. `gitbulk.yaml` (see [Configuration](#configuration)).

3. Preview the run without making any changes:

   ```bash
   gitbulk --config gitbulk.yaml --dry-run
   ```

4. Run it for real, with the live Terminal UI:

   ```bash
   gitbulk --config gitbulk.yaml --tui
   ```

---

## Configuration

GitBulk accepts configuration as **YAML, JSON, JS, MJS, or TS**. Fields can also be supplied
interactively (see [`--mode`](#cli-options)).

### Example (`gitbulk.yaml`)

```yaml
# Required
rus:
  - my-service-api
  - my-service-frontend
  - my-service-worker
ticket: AKB-1234
branch: feature/update-dependencies
script: ./scripts/update-deps.sh
commitMessage: "feat: update shared dependencies"
prSummary: "Update shared dependencies across services"
createPrOnError: false

# Optional
workspaceDir: ~/work/repos      # where the RU repositories live (default: CWD)
sourceBranch: master            # branch to base the feature branch on
cloneIfMissing: true            # clone a repo if it isn't present locally
cloneBaseUrl: "https://github.com/my-org"
concurrency: 4                  # how many repos to process in parallel
commandTimeoutMs: 120000        # per-git-command timeout
dryRun: false
skipHooks: false                # pass --no-verify to git

# Pull-request platform
prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
  apiVariant: cloud             # "cloud" or "server"
  targetBranch: master
  reviewers: []
```

### Field reference

| Field             | Required | Description                                                        |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `rus`             | yes      | List of repository units (array or comma-separated string).        |
| `ticket`          | yes      | Ticket identifier; prefixes the branch name (`<ticket>-<branch>`). |
| `branch`          | yes      | Feature branch name (sanitized automatically).                     |
| `script`          | yes      | Path to the code-change script run inside each repo.               |
| `commitMessage`   | yes      | Commit message used on a successful change.                        |
| `prSummary`       | yes      | Title/description for the pull request.                            |
| `createPrOnError` | yes      | Create a PR even if the code-change script fails.                  |
| `workspaceDir`    | no       | Root directory containing the RU repositories. Default: CWD.       |
| `sourceBranch`    | no       | Base branch for the feature branch. Default: `master`.             |
| `cloneIfMissing`  | no       | Clone a repo if missing (requires `cloneBaseUrl`).                 |
| `cloneBaseUrl`    | cond.    | Base URL for cloning. Required when `cloneIfMissing` is true.      |
| `concurrency`     | no       | Number of repositories processed in parallel.                      |
| `commandTimeoutMs`| no       | Timeout per git command (ms).                                      |
| `dryRun`          | no       | Skip all write operations (push, PR API).                          |
| `skipHooks`       | no       | Bypass git hooks (`--no-verify`).                                  |
| `prPlatform`      | no       | PR platform. Currently `bitbucket`.                                |

See the [`examples/`](./examples) directory for ready-to-copy YAML, JSON, JS, and TS configs.

### Script environment variables

Your code-change script receives these environment variables:

| Variable                | Meaning                                |
| ----------------------- | -------------------------------------- |
| `GITBULK_RU`            | Name of the current repository unit.   |
| `GITBULK_TICKET`        | The configured ticket identifier.      |
| `GITBULK_BRANCH`        | The fully-qualified feature branch.    |
| `GITBULK_SOURCE_BRANCH` | The source branch (e.g. `master`).     |

---

## CLI options

```text
gitbulk [options]

  -c, --config <path>    Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)
  -m, --mode <mode>      "strict" (file must be complete) or "hybrid" (prompt for
                         missing fields). Default: hybrid
      --dry-run          Do not perform any write operations (push, PR API)
      --tui              Run with an interactive terminal UI showing live per-RU progress
  -l, --log-level <lvl>  debug | info | warn | error. Default: info
      --no-color         Disable colored output
  -v, --version          Print version and exit
  -h, --help             Show help
```

---

## Terminal UI (TUI)

Pass `--tui` to run with a live, animated progress view. Each repository shows its current
state, an animated spinner while running, and a live tally in the footer:

```text
GitBulk — 4 RUs, concurrency 4
  ✓ service-auth     done      PR created
  ⠹ service-billing  running
  – service-users    skipped   no changes
  ○ service-gateway  pending

  1 done  0 failed  1 skipped  2 remaining
```

The TUI works in both modes:

- **From a file:** `gitbulk --tui --config gitbulk.yaml`
- **Fully interactive:** `gitbulk --tui` (prompts for any missing fields, then shows the
  live view)

Tip: combine with `--dry-run` to watch a full run safely without pushing anything. Use
`--no-color` in environments without ANSI support; the spinner falls back to a static symbol.

---

## How a run works

For each repository, GitBulk follows a four-phase flow:

1. **Input** — load and validate configuration (file and/or interactive).
2. **Loop / runner** — iterate over all RUs, honoring the concurrency limit.
3. **Per-repo git & code change** — ensure the repo exists, update the source branch,
   create the feature branch, run the code-change script, then commit and push if there is a
   diff.
4. **Pull-request API** — open a PR on the configured platform, with retries on transient
   failures.

A `RunSummary` is printed at the end with per-repository outcomes and totals.

---

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | Success — no failures.                        |
| `1`  | Completed, but one or more PRs failed.        |
| `2`  | Completed, but one or more fatal errors.      |
| `3`  | Setup error (bad config, git missing, etc.).  |
| `130`| Force-quit via a second `Ctrl+C`.             |

---

## Edge cases & safety

- **Per-repository isolation.** A failure in one repository (clone error, script failure,
  PR API error) is recorded and reported, but never aborts the other repositories.
- **Timeouts kill the whole process tree.** If a git command hangs (e.g. waiting on a
  credential prompt), GitBulk terminates the entire process tree — `taskkill /T` on Windows,
  process-group signals on POSIX — so a stuck child cannot hold the run hostage.
- **Graceful abort.** The first `Ctrl+C` requests a clean shutdown; a second forces exit.
- **Cross-platform scripts.** `.sh` scripts run via the platform shell (Git's bundled
  `sh.exe` is located automatically on Windows); `.bat`/`.cmd`, `.ps1`, and `.js`/`.mjs`
  scripts are dispatched to the appropriate interpreter.
- **Dry-run.** `--dry-run` performs all read-only steps and runs your script, but skips
  pushes and PR creation.
- **Transient API failures** are retried with exponential backoff; permanent failures
  (e.g. `4xx`) are not retried.

---

## Development

```bash
cd node_ts

npm run typecheck         # type-check the source
npm run typecheck:tests   # type-check the tests
npm run lint              # ESLint (source + tests)
npm run build             # compile to dist/
npm test                  # run the full test suite
```

Continuous integration runs all of the above on **Linux, macOS, and Windows** across
**Node 20 and 22** on every push and pull request.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for details.

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
- [Declarative operations](#declarative-operations)
- [Generating a config with `gitbulk init`](#generating-a-config-with-gitbulk-init)
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
  `.ps1`, `.js`/`.mjs`, and `.ts`/TypeScript). The right interpreter is chosen automatically
  per platform.
- **Declarative operations** as an alternative to scripts: configure a chain of reusable
  changes (add/replace/delete a file, regex replace, add a Maven dependency) directly in the
  config — they run in order, treat a missing target file as a no-op, and report whether
  anything changed. No scripting required.
- **Interactive generator** (`gitbulk init`) that walks you through the available operations
  and writes either a ready-to-run config or a standalone, editable `.mjs`/`.ts` script.
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

The fastest way to get going is the interactive generator:

```bash
gitbulk init
```

It walks you through the available [operations](#declarative-operations) and writes either a
ready-to-run config or a standalone `.mjs`/`.ts` script. Then preview and run:

```bash
gitbulk --config gitbulk.config.yaml --dry-run   # preview, nothing is pushed
gitbulk --config gitbulk.config.yaml --tui       # run for real, with the live UI
```

Prefer to write the config yourself? You have two ways to define the change per repository:

**A) Declarative operations** — no scripting (see [Declarative operations](#declarative-operations)):

```yaml
operations:
  - type: regex-replace
    path: pom.xml
    pattern: "<java.version>17</java.version>"
    replacement: "<java.version>21</java.version>"
```

**B) A custom script** — full control, any language. E.g. `update-deps.sh`:

```sh
#!/bin/sh
# Available env vars: $GITBULK_RU $GITBULK_TICKET $GITBULK_BRANCH $GITBULK_SOURCE_BRANCH
npm update --save
```

```yaml
script: ./scripts/update-deps.sh
```

Each config sets **exactly one** of `operations:` or `script:`. See
[Configuration](#configuration) for the full file.

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

# Define the change with EITHER `script:` OR `operations:` (exactly one).
script: ./scripts/update-deps.sh
# operations:                       # alternative — see "Declarative operations"
#   - type: regex-replace
#     path: pom.xml
#     pattern: "17"
#     replacement: "21"

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
| `script`          | cond.    | Path to the code-change script. Set this **or** `operations`.      |
| `operations`      | cond.    | List of declarative operations. Set this **or** `script`.          |
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

See the [`node_ts/examples/`](./node_ts/examples) directory for ready-to-copy configs (YAML,
JSON, JS, TS), a declarative-operations config (`gitbulk.operations.yaml`), and example
code-change scripts (`change.mjs`, `change.ts`).

### Script environment variables

Your code-change script receives these environment variables:

| Variable                | Meaning                                |
| ----------------------- | -------------------------------------- |
| `GITBULK_RU`            | Name of the current repository unit.   |
| `GITBULK_TICKET`        | The configured ticket identifier.      |
| `GITBULK_BRANCH`        | The fully-qualified feature branch.    |
| `GITBULK_SOURCE_BRANCH` | The source branch (e.g. `master`).     |

---

## Declarative operations

Instead of writing a script, you can list one or more **operations** directly in the config.
They run **in order** inside each repository, treat a **missing target file as a no-op** (no
error), and **report whether they changed anything**. Most are also safe to re-run unchanged;
the exception is `regex-replace`, which is only re-run-safe if your pattern no longer matches
after the substitution. Use `operations:` *instead of* `script:`.

```yaml
operations:
  - type: regex-replace
    path: pom.xml
    pattern: "<java.version>17</java.version>"
    replacement: "<java.version>21</java.version>"
  - type: maven-add-dependency
    groupId: org.apache.commons
    artifactId: commons-lang3
    version: "3.14.0"
  - type: add-file
    path: .editorconfig
    content: |
      root = true
      [*]
      indent_style = space
```

If any operation reports an error, GitBulk treats the change like a failed script (commit message
`ERROR WHILE CODE CHANGE`, PR only created when `createPrOnError: true`). If nothing changed, no PR
is opened and the feature branch is deleted.

### Available operations

| `type`                 | Purpose                                              | Key parameters                                                                 |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `add-file`             | Create a file (incl. parent dirs).                   | `path`, `content`, `overwrite` (default `false`)                               |
| `replace-file`         | Replace the full content of an existing file.        | `path`, `content`                                                              |
| `delete-file`          | Delete a file (no-op if already gone).               | `path`                                                                         |
| `regex-replace`        | Search & replace via a regular expression.           | `path`, `pattern`, `replacement`, `flags` (default `g`), `requireMatch`        |
| `maven-add-dependency` | Add a dependency to the first project-level `<dependencies>` block (skips `<dependencyManagement>`); no-op if group+artifact already present. | `groupId`, `artifactId`, `version`, `scope`, `pomPath` (default `pom.xml`) |

Paths are always relative to the repository and may not escape it (no absolute paths, no `..`).
The list of operations and their parameters is also available interactively via `gitbulk init`.

---

## Generating a config with `gitbulk init`

`gitbulk init` is an interactive generator. It first asks **what** you want to create, walks you
through the available operations, prompts only for the parameters each one needs (derived from its
schema), and writes one of:

1. a ready-to-run **YAML config** (the `operations:` block plus the remaining required fields), or
2. a standalone **code-change script** you can edit freely — in **JavaScript (`.mjs`)** or
   **TypeScript (`.ts`)** (you pick the language up front).

```bash
gitbulk init                       # interactive; writes ./gitbulk.config.yaml, ./gitbulk-change.mjs or .ts
gitbulk init --output my.yaml      # choose the output path
gitbulk init --force               # overwrite the output file without asking
```

A typical session: choose config or script (and its language), pick operations one by one, fill in
their fields, done. Then run the generated config as usual:

```bash
gitbulk --config gitbulk.config.yaml --dry-run
```

> The Bitbucket token is never written to the config — it is read at runtime from the
> `GITBULK_BITBUCKET_TOKEN` environment variable.

---

## CLI options

```text
gitbulk [options]

  -c, --config <path>    Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)
  -m, --mode <mode>      "strict" (file must be complete) or "hybrid" (prompt for
                         missing fields). Default: hybrid
      --dry-run          Do not perform any write operations (push, PR API)
      --tui              Run with an interactive terminal UI showing live per-RU progress
      --only <rus>       Only process these RUs (comma-separated subset of the configured RUs)
  -l, --log-level <lvl>  debug | info | warn | error. Default: info
      --no-color         Disable colored output
  -v, --version          Print version and exit
  -h, --help             Show help

gitbulk init [options]          Interactively generate a config or a standalone .mjs/.ts script
  -o, --output <path>    Output file path
  -f, --force            Overwrite the output file if it already exists

gitbulk list-operations [opts]  List all available operations and their parameters
      --json             Output as JSON (machine-readable)
```

Use `--only` to run a subset without editing the config, e.g.
`gitbulk --config gitbulk.yaml --only service-api,service-worker --dry-run`. Run
`gitbulk list-operations` to see every declarative operation and its parameters.

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
   create the feature branch, run the code change (your `script` *or* the configured
   `operations`), then commit and push if there is a diff.
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
- **TypeScript scripts.** `.ts`/`.mts`/`.cts` scripts run via [`tsx`](https://tsx.is) when it is
  installed in your project (`npm install -D tsx`, works on Node 20+), otherwise via Node's
  built-in type stripping (Node ≥ 22.6). GitBulk does not ship `tsx` itself; on Node < 22.6
  without `tsx` it fails with a clear message.
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

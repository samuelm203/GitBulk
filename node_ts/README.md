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

It is **modular, safe, and cross-platform** (Linux, macOS, Windows), with careful error handling
so a failure in one repository never derails the rest of the run — and it is built on a
deliberately **tiny dependency footprint** (see below).

> This is the **TypeScript / Node.js** implementation. A native **PowerShell port** with the
> same workflow lives in [`../powershell/`](../powershell).

---

## Table of Contents

- [Minimal dependencies](#minimal-dependencies)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Declarative operations](#declarative-operations)
- [Generating a config with `gitbulk init`](#generating-a-config-with-gitbulk-init)
- [CLI options](#cli-options)
- [Terminal UI (TUI)](#terminal-ui-tui)
- [Architecture & how a run works](#architecture--how-a-run-works)
- [Security](#security)
- [Exit codes](#exit-codes)
- [Edge cases & safety](#edge-cases--safety)
- [Development](#development)
- [License](#license)

---

## Minimal dependencies

GitBulk runs on **just two runtime dependencies**:

| Dependency | Why it stays |
| ---------- | ------------ |
| **`zod`**  | Schema validation for the config and for every operation's parameters. Security-relevant — malformed configs are rejected early, with precise messages. Also powers the schema introspection behind `list-operations` and `init`. |
| **`yaml`** | YAML config parsing. Node has no built-in YAML parser, and dropping YAML support would be a real regression. |

**Everything else uses native Node.js APIs.** Dependencies that were previously used have been
removed in favor of the standard library:

| Removed      | Replaced by                                                            |
| ------------ | ---------------------------------------------------------------------- |
| `commander`  | `node:util`'s `parseArgs` + a small hand-written subcommand dispatcher |
| `p-limit`    | a ~25-line concurrency limiter — [`src/utils/concurrency.ts`](./src/utils/concurrency.ts) |
| `chalk`      | a tiny ANSI color helper — [`src/utils/colors.ts`](./src/utils/colors.ts) |
| `ora`        | the zero-dependency ANSI Terminal UI in [`src/tui/`](./src/tui)        |

The interactive prompts and the live Terminal UI are built directly on `node:readline` and ANSI
escape codes — no UI framework, no spinner library. The result is a small, auditable install with
a minimal supply-chain surface.

---

## Features

- **Bulk operations** across any number of repositories from a single config.
- **Parallel execution** with a configurable concurrency limit.
- **Custom code-change scripts** per repository (any executable: `.sh`, `.bat`, `.cmd`,
  `.ps1`, `.js`/`.mjs`, and `.ts`/TypeScript). The right interpreter is chosen automatically
  per platform.
- **Declarative operations** as an alternative to scripts: a chain of reusable changes
  (add/replace/delete a file, regex replace, add a Maven/npm dependency, patch JSON) configured
  directly in the config — they run in order, treat a missing target file as a no-op, and report
  whether anything changed. No scripting required.
- **Interactive generator** (`gitbulk init`) that walks you through the available operations and
  writes either a ready-to-run config or a standalone, editable `.mjs`/`.ts` script.
- **Pull-request automation** for Bitbucket (Cloud and Server) and GitHub (incl. Enterprise).
  The adapter layer is extensible for additional platforms.
- **Automatic retries** with exponential backoff on transient push/API failures.
- **Robust error handling**: per-repository isolation, timeouts with full process-tree
  termination, and graceful abort on `Ctrl+C`.
- **Cross-platform**: continuously tested on Linux, macOS, and Windows.
- **Optional Terminal UI** with a live, animated per-repository progress view.
- **Dry-run mode** to preview a run without pushing or creating PRs.

---

## Requirements

- **Node.js >= 20**
- **Git** installed and available on the `PATH`
  - On Windows, Git for Windows is sufficient; GitBulk locates the bundled `sh.exe`
    automatically to run `.sh` scripts.

---

## Installation

GitBulk lives in the `node_ts/` directory of the repository.

```bash
git clone https://github.com/samuelm203/GitBulk.git
cd GitBulk/node_ts
npm install
npm run build
```

This produces the executable entry point at `dist/cli/index.js`. Run it directly with Node, or
link it locally:

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

> ⚠️ A `.js`/`.mjs`/`.ts` config is **imported and executed** (its default export may be a
> function that is called) — i.e. it can run arbitrary code. Only use code configs you trust;
> prefer `.yaml`/`.json` for untrusted input. GitBulk prints a warning when loading a code config.

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
skipHooks: false                # disable git hooks (core.hooksPath=/dev/null)
retry:                          # push retry (exponential backoff)
  maxAttempts: 3
  backoffMs: 1000
  maxBackoffMs: 30000

# Pull-request platform — "bitbucket" or "github"
prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
  apiVariant: cloud             # "cloud" or "server"
  targetBranch: master
  reviewers: []

# For GitHub, use prPlatform: github and a github block instead:
# prPlatform: github
# github:
#   owner: my-org               # user or organization
#   targetBranch: main
#   reviewers: []               # GitHub logins
#   # apiBaseUrl: https://ghe.example.com/api/v3   # GitHub Enterprise only
```

### Field reference

| Field              | Required | Default     | Description                                                        |
| ------------------ | -------- | ----------- | ------------------------------------------------------------------ |
| `rus`              | yes      | —           | Repository units (array or comma-separated string). Each name must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |
| `ticket`           | yes      | —           | Ticket identifier; prefixes the branch name (`<ticket>-<branch>`). |
| `branch`           | yes      | —           | Feature branch name (sanitized automatically).                     |
| `script`           | cond.    | —           | Path to the code-change script. Set this **or** `operations`.      |
| `operations`       | cond.    | —           | List of declarative operations. Set this **or** `script`.          |
| `commitMessage`    | yes      | —           | Commit message. The ticket is prepended automatically: `<ticket> <commitMessage>`. |
| `prSummary`        | yes      | —           | Title/description for the pull request.                            |
| `createPrOnError`  | yes      | —           | Create a PR even if the code change fails.                         |
| `workspaceDir`     | no       | CWD         | Root directory containing the RU repositories.                     |
| `sourceBranch`     | no       | `master`    | Base branch for the feature branch.                                |
| `cloneIfMissing`   | no       | `false`     | Clone a repo if missing (requires `cloneBaseUrl`).                 |
| `cloneBaseUrl`     | cond.    | —           | Base URL for cloning. Required when `cloneIfMissing` is true.      |
| `concurrency`      | no       | `1`         | Repositories processed in parallel (1–50).                         |
| `commandTimeoutMs` | no       | `120000`    | Timeout per git command (ms).                                      |
| `retry`            | no       | see above   | `{ maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 30000 }`.        |
| `dryRun`           | no       | `false`     | Skip all write operations (push, PR API).                          |
| `skipHooks`        | no       | `false`     | Disable git hooks (`core.hooksPath=/dev/null`).                    |
| `prPlatform`       | yes      | —           | `bitbucket` \| `github` \| `azure-devops` (Azure not yet implemented). |
| `bitbucket`        | cond.    | —           | `{ workspace, apiVariant: cloud\|server, targetBranch: master, reviewers: [], apiBaseUrl? }`. Required when `prPlatform: bitbucket`. Token from `GITBULK_BITBUCKET_TOKEN`. |
| `github`           | cond.    | —           | `{ owner, targetBranch: main, reviewers: [], apiBaseUrl? }`. Required when `prPlatform: github`. Token from `GITBULK_GITHUB_TOKEN`. |

See [`examples/`](./examples) for ready-to-copy configs (YAML, JSON, JS, TS), a
declarative-operations config (`gitbulk.operations.yaml`), and example code-change scripts
(`change.mjs`, `change.ts`).

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

Instead of writing a script, list one or more **operations** directly in the config. They run
**in order** inside each repository, treat a **missing target file as a no-op** (no error), and
**report whether they changed anything**. JSON/npm operations preserve the file's indentation and
key order and are idempotent (skip when already set). Use `operations:` *instead of* `script:`.

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
`ERROR WHILE CODE CHANGE: <commitMessage>`, PR only created when `createPrOnError: true`). If
nothing changed, no PR is opened and the feature branch is deleted.

### Available operations

| `type`                 | Purpose                                              | Key parameters                                                                 |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `add-file`             | Create a file (incl. parent dirs).                   | `path`, `content`, `overwrite` (default `false`)                               |
| `replace-file`         | Replace the full content of an existing file.        | `path`, `content`                                                              |
| `delete-file`          | Delete a file (no-op if already gone).               | `path`                                                                         |
| `regex-replace`        | Search & replace via a regular expression.           | `path`, `pattern`, `replacement`, `flags` (default `g`), `requireMatch`        |
| `maven-add-dependency` | Add a dependency to the first project-level `<dependencies>` block (skips `<dependencyManagement>`); no-op if group+artifact already present. | `groupId`, `artifactId`, `version`, `scope`, `pomPath` (default `pom.xml`) |
| `npm-add-dependency`   | Add a dependency to `package.json` (no-op if already present). | `name`, `version`, `field` (`dependencies`\|`devDependencies`\|`peerDependencies`, default `dependencies`), `packagePath` (default `package.json`) |
| `npm-update`           | Update the version of an existing dependency in `package.json` (searches all dependency fields). | `name`, `version`, `packagePath` (default `package.json`) |
| `json-patch`           | Set a value at a dot-path in a JSON file (creates intermediate objects). The value is parsed as JSON when possible (`true`, `42`, `"x"`), else used as a raw string. | `path`, `pointer` (e.g. `scripts.build`), `value` |

Paths are always relative to the repository and **may not escape it** (no absolute paths, no
`..`). The list of operations and their parameters is also available via `gitbulk list-operations`
(add `--json` for machine-readable output) and interactively via `gitbulk init`.

---

## Generating a config with `gitbulk init`

`gitbulk init` is an interactive generator. It first asks **what** you want to create, walks you
through the available operations, prompts only for the parameters each one needs (derived from its
schema), and writes one of:

1. a ready-to-run **YAML config** (the `operations:` block plus the remaining required fields), or
2. a standalone **code-change script** you can edit freely — in **JavaScript (`.mjs`)** or
   **TypeScript (`.ts`)** (you pick the language up front).

It then asks for the **file name** (with a sensible default) and writes the file into a fixed
**`gitbulk/`** directory (created if missing); an existing file is only overwritten after you
confirm (or with `--force`). Pass `--output <path>` to write to an explicit location instead.

```bash
gitbulk init                       # interactive; writes into ./gitbulk/ (asks for the file name)
gitbulk init --output ./my.yaml    # write to an explicit path instead of ./gitbulk/
gitbulk init --force               # overwrite an existing output file without asking
```

> The API token is never written to the config — it is read at runtime from an environment
> variable: `GITBULK_BITBUCKET_TOKEN` for Bitbucket, `GITBULK_GITHUB_TOKEN` for GitHub.

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
`gitbulk --config gitbulk.yaml --only service-api,service-worker --dry-run`.

The CLI is parsed with Node's built-in `node:util` `parseArgs` (no external argument parser).
Subcommand-only flags used in the wrong context (e.g. `--json` outside `list-operations`) are
rejected as a usage error rather than silently ignored.

---

## Terminal UI (TUI)

Pass `--tui` to run with a live, animated progress view. Each repository shows its current state,
an animated spinner while running, and a live tally in the footer:

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
- **Fully interactive:** `gitbulk --tui` (prompts for any missing fields, then shows the live view)

Tip: combine with `--dry-run` to watch a full run safely without pushing anything. Use
`--no-color` in environments without ANSI support; the spinner falls back to a static symbol.

In TUI mode all log output is written to **stderr** so it never interferes with the live view on
stdout — redirect with `2>run.log` if you want to capture the per-RU log alongside the UI.

---

## Architecture & how a run works

GitBulk is organized into small, independently testable modules under `src/`:

```
cli/         CLI entry + argument parsing (parseArgs), init generator, list-operations
config/      schema (zod) + loader (YAML/JSON/JS/TS, strict & hybrid modes)
core/        runner (per-RU loop + concurrency) + reporter (run summary)
git/         executor (spawn wrapper, timeouts, process-tree kill) + per-RU phases + PR adapters
operations/  declarative operations + registry + path-safety helper
tui/         zero-dependency ANSI terminal UI
utils/       logger, colors, concurrency limiter, retry, validators
```

A run flows through four phases:

1. **Config (input).** `config/loader.ts` reads and validates the config (file and/or interactive)
   against the `zod` schema in `config/schema.ts`, fills in defaults, and freezes the result.
2. **Runner (loop).** `core/runner.ts` iterates over all RUs, honoring `concurrency` via a small
   native limiter, and isolates per-repository failures.
3. **Per-repo git & code change** (`git/phase3.ts`, on top of `git/executor.ts`), for each RU:
   1. **Ensure the repo** exists locally — clone it (`cloneIfMissing`) or skip.
   2. **Back up** uncommitted work (`git stash`), then **update the source branch**
      (`fetch` → `checkout <sourceBranch>` → `reset --hard origin/<sourceBranch>` → `clean -fd`).
   3. **Create the feature branch** `<ticket>-<branch>`.
   4. **Run the code change** — your `script` *or* the configured `operations`.
   5. **Check the diff.** No diff → delete the branch, no PR. Diff → **commit** as
      `<ticket> <commitMessage>` (or `ERROR WHILE CODE CHANGE: <ticket> <commitMessage>` if the
      change failed — the failure is flagged while the configured message is kept as context).
   6. **Push** the feature branch with `--force-with-lease`, retried with exponential backoff;
      permanent errors (auth, protected branch, …) are not retried.
   7. **Clean up** — restore the original branch and stash.
4. **Pull request** (`git/phase4.ts` + `git/pr-adapter.ts`). Open a PR on the configured platform
   (Bitbucket/GitHub), best-effort reviewer assignment. Tokens are read from the environment.

A `RunSummary` is printed at the end with per-repository outcomes and totals.

---

## Security

- **No shell, no command injection.** Git commands and code-change scripts are spawned via
  `child_process.spawn` with `shell: false` and arguments passed as an array. User-controlled
  values (RU names, branch names, messages) are never interpolated into a shell.
- **Path-traversal protection.** File operations resolve every path through `resolveInRepo`, which
  rejects absolute paths and any path that escapes the repository via `..`.
- **RU-name validation.** Repository names — used as directory segments, URL segments, and `git`
  arguments — must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. This blocks path separators, `..`
  traversal, a leading `-` (which git could misread as an option), and whitespace/control chars.
- **Tokens come from the environment, never the config** (`GITBULK_BITBUCKET_TOKEN` /
  `GITBULK_GITHUB_TOKEN`), so they cannot be committed by accident.
- **Process-tree timeouts.** A hanging git command (e.g. an interactive credential prompt) is
  killed together with its entire process tree (`taskkill /T` on Windows, process-group signals on
  POSIX) so a stuck child cannot hold the run hostage.
- **Code configs run code.** A `.js`/`.mjs`/`.ts` config is `import()`-ed and its default export
  may be invoked — arbitrary code. GitBulk logs a warning before doing so; use `.yaml`/`.json` for
  untrusted input.

---

## Exit codes

| Code  | Meaning                                       |
| ----- | --------------------------------------------- |
| `0`   | Success — no failures.                        |
| `1`   | Completed, but one or more PRs failed.        |
| `2`   | Completed, but one or more fatal errors.      |
| `3`   | Setup error (bad config, git missing, etc.).  |
| `130` | Force-quit via a second `Ctrl+C`.             |

---

## Edge cases & safety

- **Per-repository isolation.** A failure in one repository (clone error, script failure, PR API
  error) is recorded and reported, but never aborts the other repositories.
- **Graceful abort.** The first `Ctrl+C` requests a clean shutdown; a second forces exit.
- **Cross-platform scripts.** `.sh` scripts run via the platform shell (Git's bundled `sh.exe` is
  located automatically on Windows); `.bat`/`.cmd`, `.ps1`, and `.js`/`.mjs` scripts are dispatched
  to the appropriate interpreter.
- **TypeScript scripts.** `.ts`/`.mts`/`.cts` scripts run via [`tsx`](https://tsx.is) when it is
  installed in your project (`npm install -D tsx`, works on Node 20+), otherwise via Node's
  built-in type stripping (Node ≥ 22.6). GitBulk does not ship `tsx` itself; on Node < 22.6
  without `tsx` it fails with a clear message.
- **Dry-run.** `--dry-run` performs all read-only steps and runs your script, but skips pushes and
  PR creation.
- **Transient push/API failures** are retried with exponential backoff; permanent failures
  (auth, `4xx`, protected branch) are not retried.

---

## Development

```bash
cd node_ts

npm run typecheck         # type-check the source
npm run typecheck:tests   # type-check the tests
npm run lint              # ESLint (source + tests, flat config)
npm run build             # compile to dist/
npm test                  # run the full test suite
```

Continuous integration runs all of the above on **Linux, macOS, and Windows** across **Node 20 and
22** on every push and pull request.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](../LICENSE) for details.

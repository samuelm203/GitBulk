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

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Declarative operations](#declarative-operations)
- [Generating a config with `gitbulk init`](#generating-a-config-with-gitbulk-init)
- [CLI options](#cli-options)
- [Terminal UI (TUI)](#terminal-ui-tui)
- [GUI (browser dashboard)](#gui-browser-dashboard)
- [Architecture & how a run works](#architecture--how-a-run-works)
- [Security](#security)
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
- **Declarative operations** as an alternative to scripts: a chain of reusable changes
  (add/replace/delete a file, regex replace, add a Maven/Gradle/npm dependency, patch JSON/YAML) configured
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

Run it without installing anything, or install it globally:

```bash
# One-off, no install (recommended for trying it out):
npx @samuelm203/gitbulk --help
npx @samuelm203/gitbulk init

# Or install it globally — the command is still "gitbulk":
npm install -g @samuelm203/gitbulk
gitbulk --help
```

Requires **Node ≥ 20**. The only runtime dependencies are `zod` and `yaml` (plus `express` + `open`,
pulled in only for the optional `--gui` dashboard).

### From source (for development)

GitBulk's reference implementation lives in the `node_ts/` directory of the repository.

```bash
git clone https://github.com/samuelm203/GitBulk.git
cd GitBulk/node_ts
npm install
npm run build      # produces the executable entry point at dist/cli/index.js

node dist/cli/index.js --help
# …or link it as a global "gitbulk" command:
npm link && gitbulk --help
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
  # A single run can span multiple Bitbucket workspaces / GitHub owners:
  # give an entry an explicit `workspace` to override the global default.
  # - { repo: legacy-tool, workspace: other-workspace }
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

# For GitLab, use prPlatform: gitlab and a gitlab block instead:
# prPlatform: gitlab
# gitlab:
#   namespace: my-group         # group or user; project = <namespace>/<repo>
#   targetBranch: main
#   reviewers: []               # numeric GitLab user IDs (as strings)
#   # apiBaseUrl: https://gitlab.example.com/api/v4   # self-hosted GitLab only

# For Azure DevOps, use prPlatform: azure-devops and an azureDevOps block instead:
# prPlatform: azure-devops
# azureDevOps:
#   organization: my-org        # cloud: dev.azure.com/<organization>; on-prem: the collection name
#   project: my-project         # repo is addressed as <organization>/<project>/<repo>
#   targetBranch: main
#   reviewers: []               # Azure user IDs (GUIDs)
#   # apiBaseUrl: https://tfs.example.com/tfs   # Azure DevOps Server: instance root WITHOUT the collection
#   #                                           # (the collection goes in "organization" above)
```

### Field reference

| Field              | Required | Default     | Description                                                        |
| ------------------ | -------- | ----------- | ------------------------------------------------------------------ |
| `rus`              | yes      | —           | Repository units. Either a name (`repo-a`) or `{ repo, workspace }` to target a different Bitbucket workspace / GitHub owner per RU. Names/workspaces must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |
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
| `prPlatform`       | yes      | —           | `bitbucket` \| `github` \| `gitlab` \| `azure-devops`. |
| `bitbucket`        | cond.    | —           | `{ workspace, apiVariant: cloud\|server, targetBranch: master, reviewers: [], apiBaseUrl? }`. Required when `prPlatform: bitbucket`. Token from `GITBULK_BITBUCKET_TOKEN`. |
| `github`           | cond.    | —           | `{ owner, targetBranch: main, reviewers: [], apiBaseUrl? }`. Required when `prPlatform: github`. Token from `GITBULK_GITHUB_TOKEN`. |
| `gitlab`           | cond.    | —           | `{ namespace, targetBranch: main, reviewers: [], apiBaseUrl? }` (reviewers = numeric user IDs; project = `namespace/repo`). Required when `prPlatform: gitlab`. Token from `GITBULK_GITLAB_TOKEN`. |
| `azureDevOps`      | cond.    | —           | `{ organization, project, targetBranch: master, reviewers: [], apiBaseUrl? }` (reviewers = user GUIDs; repo = `organization/project/<ru>`, per-RU `workspace` overrides the project). API base is `<apiBaseUrl>/<organization>`; on-prem set `apiBaseUrl` to the instance root **without** the collection and put the collection in `organization`. Required when `prPlatform: azure-devops`. Token (PAT) from `GITBULK_AZURE_DEVOPS_TOKEN`. |

See [`examples/`](./examples) for ready-to-copy configs (YAML, JSON, JS, TS), a
declarative-operations config (`gitbulk.operations.yaml`), and example code-change scripts
(`change.mjs`, `change.ts`).

### JSON Schema (editor autocomplete)

A hand-maintained JSON Schema for the config lives at
[`schema/gitbulk.config.schema.json`](./schema/gitbulk.config.schema.json). Reference it from the
top of your YAML for autocomplete and inline validation in editors with the YAML language server:

```yaml
# yaml-language-server: $schema=./schema/gitbulk.config.schema.json
rus: [my-service-api]
ticket: AKB-1234
# …
```

GitBulk's own Zod validation (`src/config/schema.ts`) remains authoritative — the JSON Schema is a
best-effort editor aid and may lag behind newly added operations.

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
| `gradle-add-dependency` | Add a dependency to the **top-level** `dependencies { }` block (indented blocks like `buildscript` are ignored). Groovy or Kotlin DSL, chosen by the `buildFilePath` ending (`.kts` → Kotlin); no-op if `group:name` is already present. | `group`, `name`, `version`, `configuration` (default `implementation`), `buildFilePath` (default `build.gradle`) |
| `npm-add-dependency`   | Add a dependency to `package.json` (no-op if already present). | `name`, `version`, `field` (`dependencies`\|`devDependencies`\|`peerDependencies`, default `dependencies`), `packagePath` (default `package.json`) |
| `npm-update`           | Update the version of an existing dependency in `package.json` (searches all dependency fields). | `name`, `version`, `packagePath` (default `package.json`) |
| `json-patch`           | Set a value at a dot-path in a JSON file (creates intermediate objects). The value is parsed as JSON when possible (`true`, `42`, `"x"`), else used as a raw string. | `path`, `pointer` (e.g. `scripts.build`), `value` |
| `yaml-patch`           | Set a value at a dot-path in a YAML file — **comments and formatting of untouched parts are preserved** (document-mode edit). Value coercion like `json-patch`. No standalone-script generator (YAML needs the `yaml` dependency). | `path`, `pointer` (e.g. `image.tag`), `value` |

Paths are always relative to the repository and **may not escape it** (no absolute paths, no
`..`). The list of operations and their parameters is also available via `gitbulk list-operations`
(add `--json` for machine-readable output) and interactively via `gitbulk init`.

---

## Generating a config with `gitbulk init`

`gitbulk init` is an interactive generator. It first asks **what** you want to create, walks you
through the available operations, prompts only for the parameters each one needs (derived from its
schema), and writes one of:

1. a ready-to-run **YAML config** (the `operations:` block plus the remaining required fields),
2. a standalone **code-change script** you can edit freely — in **JavaScript (`.mjs`)** or
   **TypeScript (`.ts`)** (you pick the language up front), or
3. **both** — a script **and** a config that runs it via the `script:` field. Use this when you
   want the convenience of clicking the operations together but the freedom to hand-edit the
   resulting script afterwards. The config references the script by its path relative to where you
   run `gitbulk` (e.g. `script: gitbulk/gitbulk-change.mjs`).

For the config variants it also asks for the **PR platform** (Bitbucket, GitHub, GitLab or
Azure DevOps) and the platform's addressing fields (workspace / owner / namespace /
organization + project), and emits the matching sub-block with a sensible `targetBranch` default.

It then asks for the **file name** (with a sensible default) and writes the file into a fixed
**`gitbulk/`** directory (created if missing). If the target already exists, GitBulk does **not**
overwrite it — it picks the next free name instead (`gitbulk.config.yaml` → `gitbulk.config2.yaml`
→ `gitbulk.config3.yaml` …), so repeated runs never clobber earlier configs. Pass `--force` to
overwrite, or `--output <path>` to write to an explicit location. (In **both** mode, `--output`
names the config and the script is written next to it.)

```bash
gitbulk init                       # interactive; writes into ./gitbulk/ (asks for the file name)
gitbulk init                       # run again → ./gitbulk/gitbulk.config2.yaml (no overwrite)
gitbulk init --output ./my.yaml    # write to an explicit path instead of ./gitbulk/
gitbulk init --force               # overwrite the existing output file instead of incrementing
```

> The API token is never written to the config. At runtime it is resolved in this order:
> **environment variable** (`GITBULK_BITBUCKET_TOKEN` / `GITBULK_GITHUB_TOKEN`) →
> **stored token** (`gitbulk auth login`, saved in `~/.gitbulk/credentials.json`, mode `0600`,
> outside any repo) → **interactive prompt** (hidden input, real terminal only). In
> non-interactive/CI runs without a token it exits with a clear error. The token is never logged.

---

## CLI options

```text
gitbulk [options]

  -c, --config <path>    Path to a config file (.yaml, .yml, .json, .js, .mjs, .ts)
  -m, --mode <mode>      "strict" (file must be complete) or "hybrid" (prompt for
                         missing fields). Default: hybrid
      --dry-run          Do not perform any write operations (push, PR API)
      --tui              Run with an interactive terminal UI showing live per-RU progress
      --gui              Open the live process view in its own window (local, 127.0.0.1);
                         the run is started via a button in the window
      --deep-log         Record a granular step-by-step log; at the end choose [D]ownload
                         (writes ./gitbulk/gitbulk-log-<ts>.log) or [P]rint. Non-TTY: file.
      --only <rus>       Only process these RUs (comma-separated subset of the configured RUs)
      --report <path>    Write a machine-readable JSON run report after the run (for CI):
                         per-RU outcome + PR link/error, totals and the exit code
      --retry-failed <report.json>  Re-run only the RUs that failed in a previous
                         --report run (pr-failed, fatal-error, not-processed)
  -l, --log-level <lvl>  debug | info | warn | error. Default: info
      --no-color         Disable colored output
  -v, --version          Print version and exit
  -h, --help             Show help
      -fish, -fisch      Show a compact command/option matrix (alias help)

gitbulk close [options]         Close the open PRs of a config's RUs + delete the remote
                                feature branches (cleanup after a bad run). Destructive:
                                asks for confirmation; --yes for CI; --dry-run to preview;
                                --json for a machine-readable report.

gitbulk init [options]          Interactively generate a config or a standalone .mjs/.ts script
  -o, --output <path>    Output file path
  -f, --force            Overwrite the output file instead of auto-incrementing the name

gitbulk template [options]      Print a ready-to-edit config template (no prompts)
      --full             Full template with every field + comments (default)
      --minimal          Only the required fields
  -o, --output <path>    Write to a file instead of stdout
  -f, --force            Overwrite the output file if it exists

gitbulk status [options]        Show the PR status of a config's RUs (read-only)
  -c, --config <path>    Path to a config file
  -m, --mode <mode>      "strict" or "hybrid" (default: hybrid)
      --only <rus>       Only check these RUs (comma-separated subset)
      --json             Output as JSON (machine-readable)
      --watch            Poll and re-render until all PRs are merged/declined
                         (Ctrl+C stops with exit 130)
      --interval <s>     Poll interval in seconds for --watch (default: 30)

gitbulk auth <login|logout|status>  Store/remove a PR token (~/.gitbulk/credentials.json)
      --platform <p>     bitbucket | github (required for login)

gitbulk list-operations [opts]  List all available operations and their parameters
      --json             Output as JSON (machine-readable)
```

### Config template (`gitbulk template`)

When you'd rather start from a file and edit it by hand than answer the interactive prompts of
`gitbulk init`, use `gitbulk template`. It prints a **schema-valid** YAML config (no prompts):

```bash
gitbulk template                      # full template (every field + comments) to stdout
gitbulk template --minimal            # only the required fields
gitbulk template -o gitbulk.yaml      # write to a file (-f/--force to overwrite)
gitbulk template --minimal > my.yaml  # or just redirect stdout
```

The **full** template (default) documents every field with its default; the **minimal** template
contains only the required fields so you can get going quickly. Both use an `operations:` block, so
the emitted config is valid as-is without a separate script file. Tokens are **never** part of the
template — they come from environment variables (or `gitbulk auth`, below).

### Tracking a run (`gitbulk status`)

After a bulk run you usually have many open pull requests. `gitbulk status` queries the platform
for **the same config** and shows, per RU, the state of its PR — without touching any local repo or
performing a single write:

```bash
gitbulk status --config gitbulk.yaml             # table of PR states for every RU
gitbulk status --config gitbulk.yaml --only a,b  # restrict to a subset
gitbulk status --config gitbulk.yaml --json      # machine-readable (for CI)
```

It re-derives the feature branch exactly like a run (`<ticket>-<branch>`) and looks the PR up by its
source branch, so no run report or extra state is needed. Each RU is reported as **open**,
**merged**, **declined** or **none** (no PR for that branch), together with its **approvals** and a
**CI** rollup (passed / failed / running / none). API errors are listed per RU without aborting the
rest. Token resolution is identical to a run: **environment variable → stored token → interactive
prompt**.

```text
Ticket AKB-1234 · branch AKB-1234-feature/x · github · 3 RUs

RU      PR    STATE   APPROVALS  CI       URL
repo-a  #11   open    2/3        passed   https://github.com/my-org/repo-a/pull/11
repo-b  #12   merged  2          passed   https://github.com/my-org/repo-b/pull/12
repo-c  -     none    -          -

Summary: 1 merged · 1 open · 0 declined · 1 none
```

Approvals show `approved/required` where the platform exposes a required count (Bitbucket reviewers)
and just the approved count otherwise (GitHub). Approvals and CI are **best-effort**: if those extra
API calls fail, the columns stay empty but the core state is still shown. Bitbucket Cloud/Server and
GitHub are supported.

### Storing a token (`gitbulk auth`)

By default a token must be present in its environment variable for each run. To store it once:

```bash
gitbulk auth login --platform bitbucket   # prompts (hidden) and saves the token
gitbulk auth status                        # shows which platforms have a token (never the value)
gitbulk auth logout --platform bitbucket   # remove it again (omit --platform to clear all)
```

The token is saved **outside any repository** in `~/.gitbulk/credentials.json` (file mode `0600`;
relocatable via `GITBULK_HOME`) and is **never** written to a project config or logged. At run
time the resolution order is **environment variable → stored token → interactive prompt**, so an
env var always wins (handy for CI).

Use `--only` to run a subset without editing the config, e.g.
`gitbulk --config gitbulk.yaml --only service-api,service-worker --dry-run`.

For CI pipelines, `--report` writes a machine-readable JSON report (per-RU outcome,
PR link or error, totals, exit code) and `--retry-failed` chains onto it:

```bash
gitbulk --config gitbulk.yaml --report run.json          # full run + report
gitbulk --config gitbulk.yaml --retry-failed run.json \
        --report retry.json                              # re-run only the failures
```

Retried are RUs with outcome `pr-failed`, `fatal-error` or `not-processed`
(e.g. after Ctrl+C); `pr-created` and `pr-skipped` (no diff) are left alone.
The report format is versioned via `reportVersion` and never contains tokens.

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

While the live view is on screen, log messages (warnings, errors) are **held back** and printed
in one block right after the run — so nothing can shift or corrupt the in-place rendering. They
go to **stderr**, so `2>run.log` still captures them separately. Long repository names are
truncated to the terminal width, and if the repository list is taller than the terminal, GitBulk
automatically falls back to simple append-only output instead of the live view.

---

## GUI (browser dashboard)

Pass `--gui` to watch a run in a polished local **browser dashboard** instead of the terminal:

```bash
gitbulk --gui --config gitbulk.config.yaml            # real run, started via button
gitbulk --gui --config gitbulk.config.yaml --dry-run  # safe preview of the full flow
```

GitBulk starts a small local web server (bound to **127.0.0.1 only**, random port) and opens the
dashboard as **its own application window** (Chromium app mode via Edge/Chrome — no tabs, no
address bar; falls back to the default browser if neither is installed). The run is streamed
live via Server-Sent Events:

- **Process view** modeled after the project flowchart — *Bitbucket Repo → Anpassen →
  PR erstellen* with an animated loop arrow while repositories are being processed.
- **One card per repository** with a mini pipeline whose stages switch on real runner events
  (`git` phase vs. `pr` phase), plus duration, a clickable PR link (with an *updated* badge on
  re-runs), and error details.
- **Live counters** (created / updated / failed / skipped), progress bar and run timer.
- **Live log panel** streaming the full granular logger output (debug level). In GUI mode the
  **deep log is always on** — no `--deep-log` flag needed; after the run it is saved
  automatically to `gitbulk/gitbulk-log-<timestamp>.log`.

The run does **not** start automatically — click *Run starten* in the page. When the run
finishes, the summary is also printed to the terminal, the process exits with the usual
[exit codes](#exit-codes), and the page keeps its final state. Tokens are never sent to the
page; the server only ever exposes repository names and run status. `--gui` and `--tui` are
mutually exclusive.

> The GUI is the one deliberate exception to the tiny-dependency rule: it uses `express` (local
> server) and `open` (cross-platform browser launch). The TUI remains zero-dependency.

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
   If an open PR for the same source branch already exists (a re-run), GitBulk looks it up and
   reports it as **`PR updated`** instead of `PR created` — no duplicate PR is attempted.

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
- **Tokens never live in a project config.** They come from an environment variable
  (`GITBULK_BITBUCKET_TOKEN` / `GITBULK_GITHUB_TOKEN`) or, optionally, a user-level store
  written by `gitbulk auth login` (`~/.gitbulk/credentials.json`, mode `0600`, outside any repo).
  The env var always takes precedence, and tokens are never logged.
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

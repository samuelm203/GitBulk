# Changelog

All notable changes to GitBulk are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitBulk ships **two implementations** from one repository: the reference
implementation in [`node_ts/`](./node_ts) (published to npm as
[`@samuelm203/gitbulk`](https://www.npmjs.com/package/@samuelm203/gitbulk)) and a
native PowerShell port in [`powershell/`](./powershell). Both are kept at feature
parity (the browser GUI and terminal TUI are Node-only).

## [Unreleased]

### Added

- **`--report <path>`** (Node CLI): write a machine-readable JSON run report for CI
  after a bulk run — per-RU outcome with PR link or error, totals, run metadata and
  the process exit code. Versioned via `reportVersion`; never contains tokens.
- **`-Report` / `-RetryFailed`** (PowerShell port): the same CI report + retry flow
  for `./gitbulk.ps1`. The retry reader accepts both implementations' outcome
  vocabularies, so reports are interchangeable between Node and PowerShell.
- **`--retry-failed <report.json>`** (Node CLI): re-run only the RUs that failed in
  a previous `--report` run (`pr-failed`, `fatal-error`, `not-processed`). Chains
  with `--report` to produce a fresh report of the retry.
- **`gitbulk init` platform choice** (Node CLI): the interactive generator now asks
  for the PR platform (Bitbucket, GitHub, GitLab or Azure DevOps) and its addressing
  fields, and emits the matching config sub-block — previously it always generated a
  Bitbucket config.
- **`-Init` platform choice** (PowerShell port): same for `./gitbulk.ps1 -Init` —
  GitLab and Azure DevOps can now be selected (previously bitbucket/github only),
  and the generated header names the platform's token env var.
- **`template --platform <p>`** (Node CLI + PowerShell `-Template -Platform`): the
  config template can now be emitted for any of the four PR platforms (default:
  bitbucket) — with the matching sub-block, targetBranch default and token env var.
- **Automatic GitHub releases**: pushing a `vX.Y.Z` tag now also creates a GitHub
  release whose notes are the CHANGELOG section of that version (after the npm
  publish succeeded; idempotent on workflow re-runs).
- **New operation `yaml-patch`** (Node CLI + PowerShell port): set a value at a
  dot-path in a YAML file, with the same JSON-style value coercion as `json-patch`.
  The Node version edits the document in place and **preserves comments and
  formatting**; the PowerShell port re-serializes via `powershell-yaml` (comments
  are not preserved).
- **Demo setup script** (`node_ts/examples/demo/setup-demo.mjs`): builds a fully
  isolated, repeatable demo workspace (three local repos with bare remotes plus a
  ready-to-run dry-run config) — nothing leaves the machine, a dummy token suffices.
- **CI coverage job**: the test suite now also runs once with V8 coverage
  (Ubuntu, Node 22) and writes the coverage table to the job summary.
- **Dependabot**: weekly update PRs for npm (`node_ts/`, minor/patch grouped)
  and GitHub Actions.
- **`gitbulk status --watch`** (Node CLI): poll and re-render the status table
  (interval via `--interval <s>`, default 30) until no PR is open anymore —
  handy while waiting for reviews. Ctrl+C stops with exit 130.
- **`gitbulk close`** (Node CLI): the cleanup counterpart to a run — closes/declines
  every open PR of a config's RUs (all four platforms) and deletes the remote
  feature branches (`git push origin --delete` from each local repo). Destructive:
  asks for confirmation in a terminal, `--yes` for CI, `--dry-run` to preview,
  `--json` for a machine-readable report. Exit `1` if any close/delete failed.
- **New operation `gradle-add-dependency`** (Node CLI + PowerShell port): add a
  dependency to the top-level `dependencies { }` block of a Gradle build file —
  Groovy or Kotlin DSL (chosen by the `buildFilePath` ending), configurable
  `configuration` (default `implementation`), idempotent on `group:name`.
  Ten operations total.

## [1.1.0] - 2026-07-02

### Added

- **Azure DevOps support** (`prPlatform: azure-devops`): create pull requests
  (with create-vs-update detection via the active-PR lookup) and `gitbulk status`
  (state + approvals + CI rollup) against Azure DevOps Services (dev.azure.com) and
  Azure DevOps Server (on-prem via `apiBaseUrl`). A repo is addressed as
  `organization/project/<repo>`, per-RU `workspace` overrides the project, the PAT
  comes from `GITBULK_AZURE_DEVOPS_TOKEN`, and
  `gitbulk auth login --platform azure-devops` stores it. In **both** the Node CLI
  and the PowerShell port.
- **GitLab support** (`prPlatform: gitlab`): create merge requests (with
  create-vs-update detection) and `gitbulk status` (state + approvals + CI rollup)
  against gitlab.com and self-hosted instances. Project = `<namespace>/<repo>`,
  per-RU `workspace` overrides the namespace, token from `GITBULK_GITLAB_TOKEN`,
  and `gitbulk auth login --platform gitlab` stores it. In **both** the Node CLI
  and the PowerShell port.

## [1.0.1] - 2026-06-29

### Fixed

- `gitbulk --version` now reports the actual package version. It was hardcoded in
  `src/index.ts` and read `0.1.0` even from the published `1.0.0`; the version is
  now read from `package.json` at runtime, so it can never drift from a release again.

## [1.0.0] - 2026-06-29

Initial public release.

### Added — core

- Bulk engine: run a code change across many repository units (RUs), commit, push a
  feature branch and open a pull request — in parallel, with push retries and a
  final per-RU summary. Exit codes `0` ok / `1` a PR failed / `2` a fatal per-RU
  error / `3` setup error / `130` SIGINT.
- Configuration via YAML / JSON (Node also: `.js` / `.mjs` / `.ts`), validated with
  clear, aggregated error messages.
- Code change per RU is **exactly one** of a free `script:` or a chainable
  `operations:` list. Script file types: `.sh`/`.bash`, `.bat`/`.cmd`, `.ps1`,
  `.js`/`.mjs`/`.cjs` and `.ts`/`.mts`/`.cts` (TypeScript via `tsx` from the target
  repo, then Node type-stripping).
- Eight declarative operations: `add-file`, `replace-file`, `delete-file`,
  `regex-replace`, `npm-add-dependency`, `npm-update`, `json-patch`,
  `maven-add-dependency` — path-safe (no absolute paths or `..`) and idempotent.

### Added — CLI

- `gitbulk init` — interactive generator: a config, a standalone `.mjs`/`.ts`
  script, **or both** (a script plus a config that runs it via `script:`).
- `gitbulk template` — print a ready-to-edit, schema-valid config (`--minimal` or
  full) without prompts.
- `gitbulk auth` — store a PR token outside any repo in
  `~/.gitbulk/credentials.json` (mode `0600`). Runtime resolution order:
  **env var → stored token → interactive prompt**.
- `gitbulk status` — read-only PR overview for a config's RUs: open / merged /
  declined / none, plus approvals and a CI rollup, as a table or `--json`.
- `gitbulk list-operations` — list the available operations and their parameters.
- Global `--only repo-a,repo-b` to run on a subset of RUs.
- `--tui` (live terminal dashboard) and `--gui` (local browser dashboard) — Node only.

### Added — PR platforms

- Bitbucket (Cloud & Server) and GitHub (github.com & Enterprise) adapters,
  including create-vs-update detection and per-RU workspace/owner overrides
  (`{ repo, workspace }` entries) so RUs from multiple workspaces run together.
- Azure DevOps is schema-prepared but not yet implemented.

### Added — PowerShell port

- Native PowerShell module (`powershell/`) at feature parity with the Node CLI:
  the run flow, all eight operations, `-ListOperations`, `-Init`, `-Template`,
  `-Auth`, `-Status` and per-RU workspaces.

### Security

- Tokens are never read from a project config and never logged.
- The `--gui` server binds to `127.0.0.1` only and never sends tokens to the browser.

[Unreleased]: https://github.com/samuelm203/GitBulk/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/samuelm203/GitBulk/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/samuelm203/GitBulk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/samuelm203/GitBulk/releases/tag/v1.0.0

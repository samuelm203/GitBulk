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

_Nothing yet._

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

[Unreleased]: https://github.com/samuelm203/GitBulk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/samuelm203/GitBulk/releases/tag/v1.0.0

# GitBulk (PowerShell)

A **native PowerShell port** of [GitBulk](../README.md) — same bulk Git workflow
(code change → commit → push feature branch → open PR across many repos), with no
Node runtime required.

> **Status:** in development. The end-to-end flow works (config → run across RUs →
> commit/push → open PRs on GitHub/Bitbucket). All eight declarative `operations:` are
> ported (file, npm, json and maven). Still pending vs. the Node version: the
> `list-operations` command and the interactive `init` generator. See
> [ROADMAP.md](./ROADMAP.md); the reference implementation is [`../node_ts/`](../node_ts).

## Usage

```powershell
# Run from a config file (JSON or YAML). Token via env var, never in the config:
$env:GITBULK_GITHUB_TOKEN = '…'      # or GITBULK_BITBUCKET_TOKEN

./gitbulk.ps1 -Config ./gitbulk.config.yaml -DryRun        # preview, nothing pushed
./gitbulk.ps1 -Config ./gitbulk.config.json                # real run
./gitbulk.ps1 -Config ./gitbulk.config.yaml -Only repo-a,repo-b   # subset of RUs

# Or via the module function:
Import-Module ./GitBulk.psd1
Invoke-GitBulk -ConfigPath ./gitbulk.config.yaml -DryRun
```

Exit codes: `0` success · `1` a PR failed · `2` a fatal per-RU error · `3` setup
error (bad config, unknown `-Only` RU). The config format matches the Node version
(see the repo root [README](../README.md)); the code change is defined via `script:`
**or** a declarative `operations:` chain.

### Declarative operations (instead of a script)

Each RU runs exactly one code change: a free `script:` **or** an `operations:` chain.
All operations write only inside the repo directory (paths must be relative and may
not escape via `..`). Available operations:

| Operation | What it does |
|-----------|--------------|
| `add-file` | Create a file with content (skips an existing file unless `overwrite`) |
| `replace-file` | Replace the full content of an existing file (skips if missing) |
| `delete-file` | Delete a file (no-op if already gone) |
| `regex-replace` | Search & replace in a file via a .NET regex (`flags: g` = replace all) |
| `npm-add-dependency` | Add a dependency to `package.json` (`field`: dependencies/devDependencies/peerDependencies) |
| `npm-update` | Update the version of an existing dependency in `package.json` |
| `json-patch` | Set a value at a dot-path in a JSON file (`value` parsed as JSON if possible) |
| `maven-add-dependency` | Add a Maven dependency to `pom.xml` (before the project `</dependencies>`) |

JSON edits keep the file's existing indentation and key order; npm/json operations
are idempotent (skip when already set). Example:

```yaml
# gitbulk.config.yaml — operations instead of a script
operations:
  - type: add-file
    path: docs/NOTICE.md
    content: "© ACME\n"
    overwrite: false          # default: skip an existing file with other content
  - type: replace-file        # only updates an existing file
    path: .editorconfig
    content: "root = true\n"
  - type: regex-replace
    path: build.gradle
    pattern: "version = '1\\.0\\.0'"
    replacement: "version = '1.1.0'"
    flags: g                  # .NET regex; g = replace all (default)
    requireMatch: false       # true → "no match" is an error
  - type: delete-file
    path: obsolete.txt
  - type: npm-add-dependency
    name: lodash
    version: "^4.17.21"
    field: dependencies       # default; also devDependencies / peerDependencies
  - type: json-patch
    path: package.json
    pointer: scripts.build    # dot-path; missing intermediates are created
    value: "tsc"              # parsed as JSON if possible ("true", "42", '{"a":1}')
  - type: maven-add-dependency
    pomPath: pom.xml          # default
    groupId: org.apache.commons
    artifactId: commons-lang3
    version: "3.14.0"
    scope: test               # optional
```

An operation that fails (e.g. `requireMatch` with no match, or a path outside the
repo) marks the whole change as failed → the commit message becomes
`ERROR WHILE CODE CHANGE` (a PR is opened only with `createPrOnError: true`), exactly
like a script exiting non-zero.

## Requirements

- **PowerShell 7.2+** (`pwsh`), cross-platform (Windows / Linux / macOS)
- **Git** on the `PATH`
- For development: `Pester` (v5), `PSScriptAnalyzer`, and (from phase 1) `powershell-yaml`:

```powershell
Install-Module Pester -MinimumVersion 5.5.0 -Scope CurrentUser -Force -SkipPublisherCheck
Install-Module PSScriptAnalyzer -Scope CurrentUser -Force
Install-Module powershell-yaml -Scope CurrentUser -Force
```

## Module layout

```
powershell/
  GitBulk.psd1                # module manifest
  GitBulk.psm1                # loader (dot-sources src/, exports Public)
  src/
    Public/                   # exported functions (the public API)
    Private/                  # internal helpers
  tests/                      # Pester v5 tests
  PSScriptAnalyzerSettings.psd1
  build.ps1                   # local lint + test runner
```

## Develop

```powershell
cd powershell
./build.ps1            # runs PSScriptAnalyzer + Pester
./build.ps1 -Lint      # analyzer only
./build.ps1 -Test      # tests only

Import-Module ./GitBulk.psd1 -Force
Get-GitBulkVersion
```

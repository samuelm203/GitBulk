# GitBulk (PowerShell)

A **native PowerShell port** of [GitBulk](../README.md) — same bulk Git workflow
(code change → commit → push feature branch → open PR across many repos), with no
Node runtime required.

> **Status:** functionally on par with the Node version. The end-to-end flow works
> (config → run across RUs → commit/push → open PRs on GitHub/GitLab/Bitbucket), all ten
> declarative `operations:` are ported (file, npm, json, yaml, maven and gradle), discoverable via
> `-ListOperations`, an interactive `-Init` generator scaffolds an `operations:`
> config, and `-Template` prints a ready-to-edit config without prompts. (The Node
> `init` can also emit a standalone script; the PowerShell port only generates the
> operations config.) See [ROADMAP.md](./ROADMAP.md); the reference
> implementation is [`../node_ts/`](../node_ts).

## Usage

```powershell
# Run from a config file (JSON or YAML). Token via env var, never in the config:
$env:GITBULK_GITHUB_TOKEN = '…'      # or GITBULK_BITBUCKET_TOKEN

./gitbulk.ps1 -Config ./gitbulk.config.yaml -DryRun        # preview, nothing pushed
./gitbulk.ps1 -Config ./gitbulk.config.json                # real run
./gitbulk.ps1 -Config ./gitbulk.config.yaml -Only repo-a,repo-b   # subset of RUs

# Discover the available declarative operations + their parameters:
./gitbulk.ps1 -ListOperations            # human-readable
./gitbulk.ps1 -ListOperations -Json      # machine-readable (pipe / redirect)

# Scaffold a new operations config interactively:
./gitbulk.ps1 -Init                      # writes ./gitbulk.config.yaml
./gitbulk.ps1 -Init -Output ./my.yaml -Force

# Print a ready-to-edit config template (no prompts):
./gitbulk.ps1 -Template                          # full template to stdout
./gitbulk.ps1 -Template -Minimal                 # only the required fields
./gitbulk.ps1 -Template -Minimal > gitbulk.yaml  # redirect to a file
./gitbulk.ps1 -Template -Output gitbulk.yaml -Force   # or write it directly

# Store a PR token once (instead of exporting the env var every time):
./gitbulk.ps1 -Auth login -Platform github   # prompts (hidden) and saves the token
./gitbulk.ps1 -Auth status                   # shows which platforms have a token
./gitbulk.ps1 -Auth logout -Platform github  # remove it again (omit -Platform = all)

# Show the PR status of a config's RUs (read-only — no git, no writes):
./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml            # table per RU
./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml -Only a,b  # subset
./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml -Json      # machine-readable

# Or via the module functions:
Import-Module ./GitBulk.psd1
Invoke-GitBulk -ConfigPath ./gitbulk.config.yaml -DryRun
Get-GitBulkOperationInfo | Where-Object Type -eq 'add-file'   # operation metadata
```

Exit codes: `0` success · `1` a PR failed · `2` a fatal per-RU error · `3` setup
error (bad config, unknown `-Only` RU). The config format matches the Node version
(see the repo root [README](../README.md)); the code change is defined via `script:`
**or** a declarative `operations:` chain.

For CI pipelines, `-Report run.json` writes a machine-readable JSON report after the
run (per-RU outcome + PR link/error, totals, exit code; versioned via `reportVersion`,
never contains tokens) and `-RetryFailed run.json` re-runs only the RUs that failed
(`pr-failed`, `fatal`, `push-failed` — node-report outcomes are accepted too, so the
reports are interchangeable between both implementations). `-RetryFailed` excludes
`-Only`.

PR platforms: **Bitbucket** (Cloud/Server), **GitHub** (`.com`/Enterprise),
**GitLab** (`.com`/self-hosted) and **Azure DevOps** (Services/Server) — create
PRs/MRs and `-Status`. For GitLab use `prPlatform: gitlab` with a
`gitlab: { namespace, targetBranch, reviewers, apiBaseUrl? }` block (project =
`namespace/repo`, reviewers = numeric user IDs, token from `GITBULK_GITLAB_TOKEN`).
For Azure DevOps use `prPlatform: azure-devops` with an
`azureDevOps: { organization, project, targetBranch, reviewers, apiBaseUrl? }` block
(repo = `organization/project/<repo>`, reviewers = user GUIDs, PAT from
`GITBULK_AZURE_DEVOPS_TOKEN`; on-prem: `apiBaseUrl` = instance root **without** the
collection, the collection goes in `organization`).

**PR tokens** are never read from the config. At run time the resolution order is
**environment variable → stored token → interactive prompt** (a `-DryRun` needs no
token). The stored token lives outside any repo in `~/.gitbulk/credentials.json`
(file mode `0600`; relocatable via `GITBULK_HOME`) and is written by
`-Auth login`; tokens are never logged.

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
| `yaml-patch` | Set a value at a dot-path in a YAML file (`value` parsed as JSON if possible; requires `powershell-yaml`, re-serializes — comments are not preserved, unlike the Node version) |
| `maven-add-dependency` | Add a Maven dependency to `pom.xml` (before the project `</dependencies>`) |
| `gradle-add-dependency` | Add a Gradle dependency to the top-level `dependencies` block (Groovy or Kotlin DSL via `buildFilePath` ending) |

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

### Multiple workspaces in one run

By default every RU uses the global `bitbucket.workspace` (or `github.owner`). To
process repos from **different** workspaces/owners in a single run, write an entry
as `{ repo, workspace }` instead of a plain name — the override flows into the repo
path, the clone URL and the PR target:

```yaml
rus:
  - repo-a                              # uses the global workspace below
  - { repo: repo-b, workspace: other-ws }   # overrides just for repo-b
bitbucket:
  workspace: my-workspace               # default for all RUs without an override
```

With an override the repo is checked out under `workspaceDir/<workspace>/<repo>` so
that same-named repos from different workspaces don't collide locally. The workspace
must be a plain segment (no `/`, `\` or `..`).

### Checking PR status after a run

`-Status` queries the platform for the **same config** and shows, per RU, the state
of its PR — without touching any local repo or performing a single write. It
re-derives the feature branch exactly like a run (`<ticket>-<branch>`) and looks the
PR up by its source branch (per-RU workspace overrides are honoured):

```text
Ticket AKB-1234 · branch AKB-1234-feature/x · github · 3 RUs

RU              PR   STATE   APPROVALS  CI       URL
service-api     #11  open    2/3        passed   https://github.com/org/service-api/pull/11
service-worker  #12  merged  2          running  https://github.com/org/service-worker/pull/12
legacy-tool     -    none    -          -

Summary: 1 merged · 1 open · 0 declined · 1 none
```

Each RU is reported as **open**, **merged**, **declined** or **none**, with its
**approvals** (`approved/required` where the platform exposes a required count) and a
best-effort **CI** rollup (passed / failed / running / none). API errors are listed
per RU without aborting the rest. `-Json` emits the report for scripting; the same
data is available programmatically via `Get-GitBulkStatusReport`. Token resolution is
identical to a run (env var → stored token → prompt). Bitbucket Cloud/Server and
GitHub are supported.

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

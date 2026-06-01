# GitBulk (PowerShell)

A **native PowerShell port** of [GitBulk](../README.md) — same bulk Git workflow
(code change → commit → push feature branch → open PR across many repos), with no
Node runtime required.

> **Status:** in development. The end-to-end flow works (config → run across RUs →
> commit/push → open PRs on GitHub/Bitbucket). Declarative `operations:` are not yet
> ported (use `script:`). See [ROADMAP.md](./ROADMAP.md); the reference implementation
> is [`../node_ts/`](../node_ts).

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
(see the repo root [README](../README.md)); the code change is defined via `script:`.

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

# GitBulk (PowerShell)

A **native PowerShell port** of [GitBulk](../README.md) — same bulk Git workflow
(code change → commit → push feature branch → open PR across many repos), with no
Node runtime required.

> **Status:** early development. See [ROADMAP.md](./ROADMAP.md) for the plan and
> which phases are done. The reference implementation is [`../node_ts/`](../node_ts).

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

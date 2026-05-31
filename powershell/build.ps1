<#
.SYNOPSIS
    Lokaler Lint- und Test-Runner für den GitBulk-PowerShell-Port.

.DESCRIPTION
    Führt PSScriptAnalyzer (Lint) und Pester (Tests) aus. Ohne Schalter laufen
    beide. Bricht mit Exit-Code 1 ab, wenn Analyzer-Issues oder Testfehler
    auftreten — geeignet für CI und lokale Pre-Commit-Prüfung.

.PARAMETER Lint
    Nur PSScriptAnalyzer ausführen.

.PARAMETER Test
    Nur Pester ausführen.

.EXAMPLE
    ./build.ps1
    Führt Lint + Tests aus.
#>
[CmdletBinding()]
param(
    [switch]$Lint,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
$runAll = -not ($Lint -or $Test)
$failed = $false

Push-Location $PSScriptRoot
try {
    if ($Lint -or $runAll) {
        Write-Host '== PSScriptAnalyzer ==' -ForegroundColor Cyan
        $issues = Invoke-ScriptAnalyzer -Path . -Recurse -Settings ./PSScriptAnalyzerSettings.psd1
        if ($issues) {
            $issues | Format-Table -AutoSize | Out-String | Write-Host
            Write-Host "PSScriptAnalyzer found $($issues.Count) issue(s)." -ForegroundColor Red
            $failed = $true
        } else {
            Write-Host 'Analyzer clean.' -ForegroundColor Green
        }
    }

    if ($Test -or $runAll) {
        Write-Host '== Pester ==' -ForegroundColor Cyan
        # Pester 5 explizit laden — Windows bringt noch das alte Pester 3.4 mit,
        # das `New-PesterConfiguration` nicht kennt.
        Import-Module Pester -MinimumVersion 5.0.0 -Force
        $config = New-PesterConfiguration
        $config.Run.Path = './tests'
        $config.Run.Exit = $false
        $config.Output.Verbosity = 'Detailed'
        $result = Invoke-Pester -Configuration $config
        if ($result.FailedCount -gt 0) {
            $failed = $true
        }
    }
} finally {
    Pop-Location
}

if ($failed) {
    exit 1
}

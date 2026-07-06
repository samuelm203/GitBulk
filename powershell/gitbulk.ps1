#!/usr/bin/env pwsh
<#
.SYNOPSIS
    GitBulk-CLI-Einstiegsskript. Lädt das Modul und führt einen Lauf aus oder
    listet die verfügbaren Operationen.

.EXAMPLE
    ./gitbulk.ps1 -Config ./gitbulk.config.yaml -DryRun
    ./gitbulk.ps1 -Config ./gitbulk.config.json -Only repo-a,repo-b

.EXAMPLE
    ./gitbulk.ps1 -Config ./gitbulk.config.yaml -Report run.json
    ./gitbulk.ps1 -Config ./gitbulk.config.yaml -RetryFailed run.json -Report retry.json

.EXAMPLE
    ./gitbulk.ps1 -ListOperations
    ./gitbulk.ps1 -ListOperations -Json

.EXAMPLE
    ./gitbulk.ps1 -Init
    ./gitbulk.ps1 -Init -Output ./gitbulk.config.yaml -Force

.EXAMPLE
    ./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml
    ./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml -Json
    ./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml -Watch -Interval 10

.EXAMPLE
    ./gitbulk.ps1 -Close -Config ./gitbulk.config.yaml -DryRun
    ./gitbulk.ps1 -Close -Config ./gitbulk.config.yaml -Yes
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [Parameter(Mandatory, ParameterSetName = 'Status')]
    [Parameter(Mandatory, ParameterSetName = 'Close')]
    [string]$Config,

    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Close')]
    [switch]$DryRun,

    [Parameter(ParameterSetName = 'Run')]
    [string]$Report,

    [Parameter(ParameterSetName = 'Run')]
    [string]$RetryFailed,

    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Status')]
    [Parameter(ParameterSetName = 'Close')]
    [string]$Only,

    [Parameter(Mandatory, ParameterSetName = 'Status')]
    [switch]$Status,

    [Parameter(ParameterSetName = 'Status')]
    [switch]$Watch,

    [Parameter(ParameterSetName = 'Status')]
    [ValidateRange(1, 86400)]
    [int]$Interval = 30,

    [Parameter(Mandatory, ParameterSetName = 'Close')]
    [switch]$Close,

    [Parameter(ParameterSetName = 'Close')]
    [switch]$Yes,

    [Parameter(Mandatory, ParameterSetName = 'List')]
    [switch]$ListOperations,

    [Parameter(ParameterSetName = 'List')]
    [Parameter(ParameterSetName = 'Status')]
    [Parameter(ParameterSetName = 'Close')]
    [switch]$Json,

    [Parameter(Mandatory, ParameterSetName = 'Init')]
    [switch]$Init,

    [Parameter(Mandatory, ParameterSetName = 'Template')]
    [switch]$Template,

    [Parameter(ParameterSetName = 'Template')]
    [switch]$Minimal,

    [Parameter(Mandatory, ParameterSetName = 'Auth')]
    [ValidateSet('login', 'logout', 'status')]
    [string]$Auth,

    [Parameter(ParameterSetName = 'Auth')]
    [Parameter(ParameterSetName = 'Template')]
    [ValidateSet('bitbucket', 'github', 'gitlab', 'azure-devops')]
    [string]$Platform,

    [Parameter(ParameterSetName = 'Init')]
    [Parameter(ParameterSetName = 'Template')]
    [string]$Output,

    [Parameter(ParameterSetName = 'Init')]
    [Parameter(ParameterSetName = 'Template')]
    [switch]$Force,

    [switch]$NoColor
)

Import-Module (Join-Path $PSScriptRoot 'GitBulk.psd1') -Force

if ($ListOperations) {
    Show-GitBulkOperationList -Json:$Json -NoColor:$NoColor
    exit 0
}

if ($Template) {
    $tplArgs = @{ Kind = if ($Minimal) { 'minimal' } else { 'full' } }
    # -Platform nur durchreichen, wenn gesetzt — sonst lehnt das ValidateSet '' ab.
    if (-not [string]::IsNullOrEmpty($Platform)) { $tplArgs.Platform = $Platform }
    if ([string]::IsNullOrEmpty($Output)) {
        # stdout-Modus: YAML auf den Success-Stream, damit `> datei.yaml` greift.
        New-GitBulkTemplate @tplArgs
        exit 0
    }
    $code = Invoke-GitBulkTemplate @tplArgs -OutputPath $Output -Force:$Force -NoColor:$NoColor
    exit $code
}

if ($Auth) {
    $interactive = -not [Console]::IsInputRedirected
    $authArgs = @{ Action = $Auth; Interactive = $interactive; NoColor = [bool]$NoColor }
    # -Platform nur durchreichen, wenn gesetzt — sonst lehnt das ValidateSet '' ab.
    if (-not [string]::IsNullOrEmpty($Platform)) { $authArgs.Platform = $Platform }
    $code = Invoke-GitBulkAuth @authArgs
    exit $code
}

if ($Init) {
    $code = Invoke-GitBulkInit -OutputPath $Output -Force:$Force -NoColor:$NoColor
    exit $code
}

if ($Status) {
    if ($Watch -and $Json) {
        [Console]::Error.WriteLine('gitbulk: -Watch and -Json are mutually exclusive.')
        exit 3
    }
    if ($Watch) {
        # Poll-Loop: neu rendern, bis kein PR mehr offen ist und kein API-Fehler
        # vorliegt (`none` gilt als terminal). Ctrl+C beendet pwsh-üblich.
        for (;;) {
            $report = Get-GitBulkStatusReport -ConfigPath $Config -Only $Only
            if (-not $report) { exit 3 }
            if (-not [Console]::IsOutputRedirected) { Clear-Host }
            Format-GitBulkStatusTable -Report $report
            Write-Host "`n[watch] $(Get-Date -Format 'HH:mm:ss') — refreshing every ${Interval}s (Ctrl+C to stop)"
            if ($report.Totals.Open -eq 0 -and $report.Totals.Errored -eq 0) {
                Write-Host "`nAll pull requests are settled — done."
                exit 0
            }
            Start-Sleep -Seconds $Interval
        }
    }
    $report = Get-GitBulkStatusReport -ConfigPath $Config -Only $Only
    if (-not $report) { exit 3 }   # Setup-Fehler wurden bereits nach stderr geschrieben
    if ($Json) { Format-GitBulkStatusJson -Report $report }
    else { Format-GitBulkStatusTable -Report $report }
    exit 0
}

if ($Close) {
    $code = Invoke-GitBulkClose -ConfigPath $Config -Only $Only -DryRun:$DryRun -Yes:$Yes -Json:$Json -NoColor:$NoColor
    exit $code
}

$code = Invoke-GitBulk -ConfigPath $Config -DryRun:$DryRun -Only $Only `
    -Report $Report -RetryFailed $RetryFailed -NoColor:$NoColor
exit $code

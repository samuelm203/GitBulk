#!/usr/bin/env pwsh
<#
.SYNOPSIS
    GitBulk-CLI-Einstiegsskript. Lädt das Modul und führt einen Lauf aus oder
    listet die verfügbaren Operationen.

.EXAMPLE
    ./gitbulk.ps1 -Config ./gitbulk.config.yaml -DryRun
    ./gitbulk.ps1 -Config ./gitbulk.config.json -Only repo-a,repo-b

.EXAMPLE
    ./gitbulk.ps1 -ListOperations
    ./gitbulk.ps1 -ListOperations -Json

.EXAMPLE
    ./gitbulk.ps1 -Init
    ./gitbulk.ps1 -Init -Output ./gitbulk.config.yaml -Force

.EXAMPLE
    ./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml
    ./gitbulk.ps1 -Status -Config ./gitbulk.config.yaml -Json
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [Parameter(Mandatory, ParameterSetName = 'Status')]
    [string]$Config,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$DryRun,

    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Status')]
    [string]$Only,

    [Parameter(Mandatory, ParameterSetName = 'Status')]
    [switch]$Status,

    [Parameter(Mandatory, ParameterSetName = 'List')]
    [switch]$ListOperations,

    [Parameter(ParameterSetName = 'List')]
    [Parameter(ParameterSetName = 'Status')]
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
    [ValidateSet('bitbucket', 'github', 'gitlab')]
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
    $kind = if ($Minimal) { 'minimal' } else { 'full' }
    if ([string]::IsNullOrEmpty($Output)) {
        # stdout-Modus: YAML auf den Success-Stream, damit `> datei.yaml` greift.
        New-GitBulkTemplate -Kind $kind
        exit 0
    }
    $code = Invoke-GitBulkTemplate -Kind $kind -OutputPath $Output -Force:$Force -NoColor:$NoColor
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
    $report = Get-GitBulkStatusReport -ConfigPath $Config -Only $Only
    if (-not $report) { exit 3 }   # Setup-Fehler wurden bereits nach stderr geschrieben
    if ($Json) { Format-GitBulkStatusJson -Report $report }
    else { Format-GitBulkStatusTable -Report $report }
    exit 0
}

$code = Invoke-GitBulk -ConfigPath $Config -DryRun:$DryRun -Only $Only -NoColor:$NoColor
exit $code

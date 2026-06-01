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
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [string]$Config,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$DryRun,

    [Parameter(ParameterSetName = 'Run')]
    [string]$Only,

    [Parameter(Mandatory, ParameterSetName = 'List')]
    [switch]$ListOperations,

    [Parameter(ParameterSetName = 'List')]
    [switch]$Json,

    [Parameter(Mandatory, ParameterSetName = 'Init')]
    [switch]$Init,

    [Parameter(ParameterSetName = 'Init')]
    [string]$Output,

    [Parameter(ParameterSetName = 'Init')]
    [switch]$Force,

    [switch]$NoColor
)

Import-Module (Join-Path $PSScriptRoot 'GitBulk.psd1') -Force

if ($ListOperations) {
    Show-GitBulkOperationList -Json:$Json -NoColor:$NoColor
    exit 0
}

if ($Init) {
    $code = Invoke-GitBulkInit -OutputPath $Output -Force:$Force -NoColor:$NoColor
    exit $code
}

$code = Invoke-GitBulk -ConfigPath $Config -DryRun:$DryRun -Only $Only -NoColor:$NoColor
exit $code

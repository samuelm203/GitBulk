#!/usr/bin/env pwsh
<#
.SYNOPSIS
    GitBulk-CLI-Einstiegsskript. Lädt das Modul und führt Invoke-GitBulk aus.

.EXAMPLE
    ./gitbulk.ps1 -Config ./gitbulk.config.yaml -DryRun
    ./gitbulk.ps1 -Config ./gitbulk.config.json -Only repo-a,repo-b
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Config,

    [switch]$DryRun,
    [string]$Only,
    [switch]$NoColor
)

Import-Module (Join-Path $PSScriptRoot 'GitBulk.psd1') -Force

$code = Invoke-GitBulk -ConfigPath $Config -DryRun:$DryRun -Only $Only -NoColor:$NoColor
exit $code

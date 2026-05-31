function Get-GitBulkVersion {
    <#
    .SYNOPSIS
        Liefert die Version des GitBulk-PowerShell-Moduls.

    .DESCRIPTION
        Liest die ModuleVersion aus dem Modul-Manifest (GitBulk.psd1). Dient
        zugleich als Smoke-Test, dass das Modul korrekt geladen und das Manifest
        gültig ist.

    .OUTPUTS
        System.String — die Versionsnummer, z. B. "0.1.0".

    .EXAMPLE
        Get-GitBulkVersion
        0.1.0
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    $manifestPath = Join-Path $PSScriptRoot '..' '..' 'GitBulk.psd1'
    $manifest = Import-PowerShellDataFile -Path $manifestPath
    return [string]$manifest.ModuleVersion
}

function Invoke-GitBulkTemplate {
    <#
    .SYNOPSIS
        Schreibt eine GitBulk-Config-Vorlage in eine Datei (Datei-Modus von
        `gitbulk template`). Die reine Text-Erzeugung liegt in New-GitBulkTemplate.

    .DESCRIPTION
        Für die Ausgabe nach stdout ruft das CLI-Skript New-GitBulkTemplate direkt
        auf (damit `> datei.yaml` sauber umgeleitet wird). Diese Funktion deckt den
        Datei-Modus (-Output) ab und ist dadurch unit-testbar (Exit-Code +
        Überschreib-Schutz).

    .PARAMETER Kind
        'full' (Default) oder 'minimal'.

    .PARAMETER Platform
        PR-Plattform des emittierten Blocks (Default: bitbucket).

    .PARAMETER OutputPath
        Zieldatei. Pflicht in dieser Funktion.

    .PARAMETER Force
        Vorhandene Zieldatei ohne Rückfrage überschreiben.

    .PARAMETER NoColor
        Ausgabe ohne Farben.

    .OUTPUTS
        [int] Exit-Code: 0 = geschrieben, 3 = Datei existiert ohne -Force.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [ValidateSet('full', 'minimal')]
        [string]$Kind = 'full',

        [ValidateSet('bitbucket', 'github', 'gitlab', 'azure-devops')]
        [string]$Platform = 'bitbucket',

        [Parameter(Mandatory)]
        [string]$OutputPath,

        [switch]$Force,
        [switch]$NoColor
    )

    $text = New-GitBulkTemplate -Kind $Kind -Platform $Platform

    $target = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
        $OutputPath
    } else {
        Join-Path (Get-Location).Path $OutputPath
    }

    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        [Console]::Error.WriteLine("Error: $target already exists. Use -Force to overwrite.")
        return 3
    }

    [System.IO.File]::WriteAllText($target, $text)
    Write-GitBulkLine -Message "Wrote $Kind config template to $target" -Color 'Green' -NoColor:$NoColor
    return 0
}

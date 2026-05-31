function Get-GitBulkConfig {
    <#
    .SYNOPSIS
        Lädt und validiert eine GitBulk-Konfiguration (JSON oder YAML).

    .DESCRIPTION
        Liest eine Config-Datei (.json/.yaml/.yml) oder nimmt ein bereits
        geparstes Hashtable entgegen, validiert die Pflichtfelder (mit denselben
        Regeln wie die Node-Version) und füllt Defaults auf. Bei Problemen wird
        ein Fehler mit ALLEN gesammelten Meldungen geworfen.

        YAML benötigt das Modul 'powershell-yaml'.

    .PARAMETER Path
        Pfad zur Config-Datei (.json, .yaml oder .yml).

    .PARAMETER InputObject
        Bereits geparstes Config-Hashtable (Alternative zu -Path; v. a. für Tests).

    .PARAMETER BaseDir
        Basisverzeichnis für relative Pfade (z. B. das `script`-Feld).
        Default: aktuelles Verzeichnis.

    .OUTPUTS
        System.Collections.Specialized.OrderedDictionary — die normalisierte Config.

    .EXAMPLE
        Get-GitBulkConfig -Path ./gitbulk.config.yaml
    #>
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Path', Position = 0)]
        [string]$Path,

        [Parameter(Mandatory, ParameterSetName = 'InputObject')]
        [System.Collections.IDictionary]$InputObject,

        [string]$BaseDir = (Get-Location).Path
    )

    if ($PSCmdlet.ParameterSetName -eq 'InputObject') {
        return ConvertTo-GitBulkConfig -Raw $InputObject -BaseDir $BaseDir
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "GitBulk config file not found: $Path"
    }

    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    $text = Get-Content -LiteralPath $Path -Raw

    switch ($ext) {
        '.json' {
            $raw = $text | ConvertFrom-Json -AsHashtable
        }
        { $_ -in '.yaml', '.yml' } {
            if (-not (Get-Module -ListAvailable -Name 'powershell-yaml')) {
                throw "Loading YAML configs requires the 'powershell-yaml' module (Install-Module powershell-yaml)."
            }
            Import-Module powershell-yaml -ErrorAction Stop
            $raw = ConvertFrom-Yaml $text
        }
        default {
            throw "Unsupported config file extension '$ext' (use .json, .yaml or .yml)."
        }
    }

    if ($null -eq $raw) {
        throw "GitBulk config file is empty or invalid: $Path"
    }

    # BaseDir für relative script-Pfade: standardmäßig das Verzeichnis der Config.
    $effectiveBase = if ($PSBoundParameters.ContainsKey('BaseDir')) {
        $BaseDir
    } else {
        Split-Path -Parent (Resolve-Path -LiteralPath $Path).Path
    }

    return ConvertTo-GitBulkConfig -Raw $raw -BaseDir $effectiveBase
}

# Operation: yaml-patch — setzt einen Wert an einem Dot-Pfad (z. B. image.tag)
# in einer YAML-Datei. Pendant zu node_ts/src/operations/yaml-patch.ts.
#
# Der value wird als JSON interpretiert, wenn möglich (true → boolean, 42 → Zahl),
# sonst als roher String. Fehlende Zwischen-Maps werden angelegt.
#
# Hinweis zur Parität: die Node-Version editiert das YAML-Dokument in place
# (Kommentare bleiben erhalten); powershell-yaml kann das nicht — hier wird
# re-serialisiert, Kommentare gehen also verloren (im README dokumentiert).
#
# Verhalten:
#   Datei fehlt        → Changed=$false (übersprungen).
#   Wert schon gleich  → Changed=$false (idempotent).
#   Ungültiges YAML    → Error (kein Teil-Schreiben).
#   Sonst              → setzt den Wert, Changed=$true.

Register-GitBulkOperation @{
    Type        = 'yaml-patch'
    Description = 'Set a value at a dot-path in a YAML file (value parsed as JSON if possible)'
    Params      = @(
        @{ Name = 'path'; Kind = 'string'; Required = $true }
        @{ Name = 'pointer'; Kind = 'string'; Required = $true }
        @{ Name = 'value'; Kind = 'string'; Required = $true }
    )
    Apply       = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $pointer = [string]$Params['pointer']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $rel found — skipping." }
        }

        if (-not (Get-Module -ListAvailable -Name 'powershell-yaml')) {
            $err = "yaml-patch requires the 'powershell-yaml' module (Install-Module powershell-yaml)."
            return @{ Changed = $false; Message = $err; Error = $err }
        }
        Import-Module powershell-yaml -ErrorAction Stop

        $text = [System.IO.File]::ReadAllText($file)
        try {
            $data = ConvertFrom-Yaml $text -Ordered
        } catch {
            $err = "invalid YAML in ${rel}: $($_.Exception.Message)"
            return @{ Changed = $false; Message = $err; Error = $err }
        }
        if ($null -eq $data) { $data = [ordered]@{} }
        if ($data -isnot [System.Collections.IDictionary]) {
            $err = "expected a YAML mapping in $rel"
            return @{ Changed = $false; Message = $err; Error = $err }
        }

        $value = Resolve-GitBulkJsonValue ([string]$Params['value'])
        $newCompact = ConvertTo-GitBulkJson -Value $value -Compact
        $got = Get-GitBulkJsonDotValue -Data $data -DotPath $pointer
        if ($got.Found) {
            $curCompact = ConvertTo-GitBulkJson -Value $got.Value -Compact
            if ($curCompact -ceq $newCompact) {
                return @{ Changed = $false; Message = "$rel $pointer already set — skipping." }
            }
        }

        Set-GitBulkJsonDotValue -Data $data -DotPath $pointer -Value $value

        [System.IO.File]::WriteAllText($file, (ConvertTo-Yaml $data))
        return @{ Changed = $true; Message = "Set $pointer in $rel" }
    }
}

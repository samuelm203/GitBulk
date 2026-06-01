# Operation: json-patch — setzt einen Wert an einem Dot-Pfad (z. B. scripts.build)
# in einer JSON-Datei. Pendant zu node_ts/src/operations/json-patch.ts.
#
# Der value wird als JSON interpretiert, wenn möglich (true → boolean, 42 → Zahl,
# "x" → String), sonst als roher String. Fehlende Zwischenobjekte werden angelegt.
#
# Verhalten:
#   Datei fehlt        → Changed=$false (übersprungen).
#   Wert schon gleich  → Changed=$false (idempotent).
#   Sonst              → setzt den Wert, Changed=$true.

Register-GitBulkOperation @{
    Type           = 'json-patch'
    Description    = 'Set a value at a dot-path in a JSON file (value parsed as JSON if possible)'
    Params      = @(
        @{ Name = 'path'; Kind = 'string'; Required = $true }
        @{ Name = 'pointer'; Kind = 'string'; Required = $true }
        @{ Name = 'value'; Kind = 'string'; Required = $true }
    )
    Apply          = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $pointer = [string]$Params['pointer']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $rel found — skipping." }
        }

        $text = [System.IO.File]::ReadAllText($file)
        try {
            $data = ConvertFrom-GitBulkJson $text
        } catch {
            $err = "invalid JSON in ${rel}: $($_.Exception.Message)"
            return @{ Changed = $false; Message = $err; Error = $err }
        }
        if ($data -isnot [System.Collections.IDictionary]) {
            $err = "expected a JSON object in $rel"
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

        $indent = Get-GitBulkJsonIndent $text
        $trailing = if ($text.EndsWith("`n")) { "`n" } else { '' }
        [System.IO.File]::WriteAllText($file, (ConvertTo-GitBulkJson -Value $data -Indent $indent) + $trailing)
        return @{ Changed = $true; Message = "Set $pointer in $rel" }
    }
}

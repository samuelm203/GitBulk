# Operation: add-file — legt eine Datei mit dem angegebenen Inhalt an (inkl.
# fehlender Zwischenverzeichnisse). Pendant zu node_ts/src/operations/add-file.ts.
#
# Verhalten:
#   Datei fehlt              → schreibt sie, Changed=$true.
#   Datei existiert, gleich  → Changed=$false (idempotent).
#   Datei existiert, anders  → nur überschreiben wenn overwrite=$true,
#                              sonst Changed=$false (kein Fehler, übersprungen).

Register-GitBulkOperation @{
    Type           = 'add-file'
    Description    = 'Create a file with given content (skips an existing file unless overwrite)'
    Params      = @(
        @{ Name = 'path'; Kind = 'string'; Required = $true }
        @{ Name = 'content'; Kind = 'string'; Required = $false; Default = '' }
        @{ Name = 'overwrite'; Kind = 'boolean'; Required = $false; Default = $false }
    )
    Apply          = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        $content = if ($null -ne $Params['content']) { [string]$Params['content'] } else { '' }
        $overwrite = [bool]$Params['overwrite']

        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $current = [System.IO.File]::ReadAllText($file)
            if ($current -ceq $content) { return @{ Changed = $false; Message = "$rel already up to date — skipping." } }
            if (-not $overwrite) {
                return @{ Changed = $false; Message = "$rel already exists — skipping (set overwrite: true to replace)." }
            }
        }

        # .NET-API statt New-Item: nimmt einen LITERALEN Pfad (keine Wildcard-
        # Interpretation von [ ] * ?), ist idempotent und legt fehlende
        # Zwischenverzeichnisse an — konsistent zum WriteAllText darunter.
        $dir = [System.IO.Path]::GetDirectoryName($file)
        if ($dir) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
        [System.IO.File]::WriteAllText($file, $content)
        return @{ Changed = $true; Message = "Wrote $rel" }
    }
}

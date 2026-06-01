# Operation: replace-file — ersetzt den gesamten Inhalt einer EXISTIERENDEN
# Datei. Pendant zu node_ts/src/operations/replace-file.ts.
#
# Verhalten:
#   Datei fehlt              → Changed=$false (kein Fehler; übersprungen).
#   Inhalt bereits identisch → Changed=$false (idempotent).
#   Sonst                    → schreibt neuen Inhalt, Changed=$true.
#
# Abgrenzung zu add-file: replace-file legt KEINE neue Datei an.

Register-GitBulkOperation @{
    Type           = 'replace-file'
    Description    = 'Replace the full content of an existing file (skips if missing)'
    RequiredParams = @('path', 'content')
    Apply          = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $rel found — skipping." }
        }

        $content = [string]$Params['content']
        $current = [System.IO.File]::ReadAllText($file)
        if ($current -ceq $content) { return @{ Changed = $false; Message = "$rel already up to date — skipping." } }

        [System.IO.File]::WriteAllText($file, $content)
        return @{ Changed = $true; Message = "Replaced $rel" }
    }
}

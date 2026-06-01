# Operation: delete-file — löscht eine Datei im Repo. Pendant zu
# node_ts/src/operations/delete-file.ts.
#
# Verhalten:
#   Datei fehlt          → Changed=$false (idempotent; nichts zu tun).
#   Ziel ist Verzeichnis → Error (delete-file löscht bewusst keine Verzeichnisse).
#   Sonst                → löscht sie, Changed=$true.

Register-GitBulkOperation @{
    Type           = 'delete-file'
    Description    = 'Delete a file (no-op if it is already gone)'
    Params      = @(
        @{ Name = 'path'; Kind = 'string'; Required = $true }
    )
    Apply          = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file)) {
            return @{ Changed = $false; Message = "$rel does not exist — nothing to delete." }
        }
        if (Test-Path -LiteralPath $file -PathType Container) {
            $err = "$rel is a directory — delete-file refuses to delete directories."
            return @{ Changed = $false; Message = $err; Error = $err }
        }

        Remove-Item -LiteralPath $file -Force
        return @{ Changed = $true; Message = "Deleted $rel" }
    }
}

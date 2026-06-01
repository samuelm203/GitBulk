# Operation: npm-update — setzt die Version einer BEREITS vorhandenen Abhängigkeit
# in der package.json. Pendant zu node_ts/src/operations/npm-update.ts.
# Sucht in dependencies, devDependencies und peerDependencies.
#
# Verhalten:
#   Keine package.json   → Changed=$false (übersprungen).
#   Name nicht vorhanden → Changed=$false (kein Fehler; nichts zu updaten).
#   Version schon gleich → Changed=$false (idempotent).
#   Sonst                → setzt die neue Version (in allen Fundstellen), Changed=$true.

Register-GitBulkOperation @{
    Type           = 'npm-update'
    Description    = 'Update the version of an existing dependency in package.json'
    RequiredParams = @('name', 'version')
    Apply          = {
        param($Params, $Ctx)

        $name = [string]$Params['name']
        $version = [string]$Params['version']
        $pkgRel = if ($Params.Contains('packagePath') -and $Params['packagePath']) { [string]$Params['packagePath'] } else { 'package.json' }

        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $pkgRel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $pkgRel found — skipping." }
        }

        $text = [System.IO.File]::ReadAllText($file)
        try {
            $pkg = ConvertFrom-GitBulkJson $text
        } catch {
            $err = "invalid JSON in ${pkgRel}: $($_.Exception.Message)"
            return @{ Changed = $false; Message = $err; Error = $err }
        }
        if ($pkg -isnot [System.Collections.IDictionary]) {
            $err = "expected a JSON object in $pkgRel"
            return @{ Changed = $false; Message = $err; Error = $err }
        }

        $found = $false
        $changed = $false
        foreach ($f in @('dependencies', 'devDependencies', 'peerDependencies')) {
            if ($pkg.Contains($f) -and $pkg[$f] -is [System.Collections.IDictionary]) {
                $section = $pkg[$f]
                if ($section.Contains($name)) {
                    $found = $true
                    if ([string]$section[$name] -cne $version) { $section[$name] = $version; $changed = $true }
                }
            }
        }

        if (-not $found) { return @{ Changed = $false; Message = "$name not found in $pkgRel — skipping." } }
        if (-not $changed) { return @{ Changed = $false; Message = "$name already at $version — skipping." } }

        $indent = Get-GitBulkJsonIndent $text
        $trailing = if ($text.EndsWith("`n")) { "`n" } else { '' }
        [System.IO.File]::WriteAllText($file, (ConvertTo-GitBulkJson -Value $pkg -Indent $indent) + $trailing)
        return @{ Changed = $true; Message = "Updated $name to $version" }
    }
}

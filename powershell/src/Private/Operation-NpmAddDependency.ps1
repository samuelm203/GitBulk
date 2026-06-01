# Operation: npm-add-dependency — fügt eine Abhängigkeit in die package.json ein.
# Pendant zu node_ts/src/operations/npm-add-dependency.ts.
#
# Verhalten:
#   Keine package.json   → Changed=$false (übersprungen).
#   Bereits vorhanden    → Changed=$false (idempotent, egal welche Version).
#   Sonst                → fügt "name": "version" ein, Changed=$true.
#
# Die vorhandene Einrückung + Schlüssel-Reihenfolge der Datei bleibt erhalten.

Register-GitBulkOperation @{
    Type           = 'npm-add-dependency'
    Description    = 'Add a dependency to package.json (skips if already present)'
    Params      = @(
        @{ Name = 'name'; Kind = 'string'; Required = $true }
        @{ Name = 'version'; Kind = 'string'; Required = $true }
        @{ Name = 'field'; Kind = 'enum'; Required = $false; Default = 'dependencies'; Enum = @('dependencies', 'devDependencies', 'peerDependencies') }
        @{ Name = 'packagePath'; Kind = 'string'; Required = $false; Default = 'package.json' }
    )
    Apply          = {
        param($Params, $Ctx)

        $name = [string]$Params['name']
        $version = [string]$Params['version']
        $field = if ($Params.Contains('field') -and $Params['field']) { [string]$Params['field'] } else { 'dependencies' }
        $pkgRel = if ($Params.Contains('packagePath') -and $Params['packagePath']) { [string]$Params['packagePath'] } else { 'package.json' }

        if ($field -notin @('dependencies', 'devDependencies', 'peerDependencies')) {
            $err = "invalid field '$field' (must be dependencies, devDependencies or peerDependencies)"
            return @{ Changed = $false; Message = $err; Error = $err }
        }

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

        $section = if ($pkg.Contains($field) -and $pkg[$field] -is [System.Collections.IDictionary]) { $pkg[$field] } else { [ordered]@{} }
        if ($section.Contains($name)) {
            return @{ Changed = $false; Message = "$name already in $field — skipping." }
        }

        $section[$name] = $version
        $pkg[$field] = $section

        $indent = Get-GitBulkJsonIndent $text
        $trailing = if ($text.EndsWith("`n")) { "`n" } else { '' }
        [System.IO.File]::WriteAllText($file, (ConvertTo-GitBulkJson -Value $pkg -Indent $indent) + $trailing)
        return @{ Changed = $true; Message = "Added $name@$version to $field" }
    }
}

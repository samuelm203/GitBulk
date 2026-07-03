# Operation: gradle-add-dependency — fügt eine Gradle-Abhängigkeit in den
# TOP-LEVEL-`dependencies { }`-Block ein (direkt nach der öffnenden Zeile).
# Pendant zu node_ts/src/operations/gradle-add-dependency.ts.
#
# Der Block muss am Zeilenanfang stehen — eingerückte Blöcke (z. B. in
# `buildscript { }`) werden bewusst ignoriert. DSL über die Dateiendung:
# `.kts` → Kotlin (configuration("g:n:v")), sonst Groovy (configuration 'g:n:v').
#
# Verhalten:
#   Build-Datei fehlt      → Changed=$false (übersprungen).
#   group:name vorhanden   → Changed=$false (idempotent, Version egal).
#   Kein Top-Level-Block   → Error (im Report sichtbar).
#   Sonst                  → fügt ein, Changed=$true.

Register-GitBulkOperation @{
    Type        = 'gradle-add-dependency'
    Description = 'Add a Gradle dependency to the top-level dependencies block (Groovy or Kotlin DSL)'
    Params      = @(
        @{ Name = 'group'; Kind = 'string'; Required = $true }
        @{ Name = 'name'; Kind = 'string'; Required = $true }
        @{ Name = 'version'; Kind = 'string'; Required = $true }
        @{ Name = 'configuration'; Kind = 'string'; Required = $false; Default = 'implementation' }
        @{ Name = 'buildFilePath'; Kind = 'string'; Required = $false; Default = 'build.gradle' }
    )
    Apply       = {
        param($Params, $Ctx)

        $group = [string]$Params['group']
        $name = [string]$Params['name']
        $version = [string]$Params['version']
        $configuration = if ($Params.Contains('configuration') -and $Params['configuration']) { [string]$Params['configuration'] } else { 'implementation' }
        $rel = if ($Params.Contains('buildFilePath') -and $Params['buildFilePath']) { [string]$Params['buildFilePath'] } else { 'build.gradle' }

        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $rel found — skipping." }
        }

        $text = [System.IO.File]::ReadAllText($file)

        # Idempotenz: group:name bereits als Dependency-Notation vorhanden
        # (beliebige Version, beliebige Configuration)?
        $notationPattern = "['""]" + [regex]::Escape($group) + ':' + [regex]::Escape($name) + "(:[^'""]*)?['""]"
        if ($text -match $notationPattern) {
            return @{ Changed = $false; Message = "Dependency ${group}:$name already present — skipping." }
        }

        # Top-Level-Block: `dependencies {` am Zeilenanfang (Spalte 0).
        $block = [regex]::Match($text, '(?m)^dependencies\s*\{[^\n]*\n')
        if (-not $block.Success) {
            $err = "Could not find a top-level dependencies block in $rel."
            return @{ Changed = $false; Message = 'no top-level dependencies block'; Error = $err }
        }

        $insertPos = $block.Index + $block.Length
        # Einrückung von der nächsten Inhalts-Zeile übernehmen, sonst 4 Spaces.
        $rest = $text.Substring($insertPos)
        $indentMatch = [regex]::Match($rest, '^([ \t]+)(?=\S)')
        $indent = if ($indentMatch.Success) { $indentMatch.Groups[1].Value } else { '    ' }

        $notation = "${group}:${name}:$version"
        $line = if ($rel.EndsWith('.kts')) { "$configuration(`"$notation`")" } else { "$configuration '$notation'" }

        $updated = $text.Substring(0, $insertPos) + $indent + $line + "`n" + $rest
        [System.IO.File]::WriteAllText($file, $updated)
        return @{ Changed = $true; Message = "Added $configuration $notation" }
    }
}

# Operation: maven-add-dependency — fügt eine Maven-Abhängigkeit in die pom.xml
# ein, direkt vor dem schließenden </dependencies> des PROJEKT-Blocks (nicht in
# <dependencyManagement>). Pendant zu node_ts/src/operations/maven-add-dependency.ts.
#
# Verhalten:
#   Keine pom.xml      → Changed=$false (übersprungen).
#   Bereits vorhanden  → Changed=$false (idempotent).
#   Kein Projekt-Block → Error (im Report sichtbar).
#   Sonst              → fügt ein, Changed=$true.
#
# Hinweis: Der PowerShell-Port leitet pomPath über Resolve-InRepoPath ab (Pfad-
# Sicherheit), während die Node-Version pomPath direkt joint.

Register-GitBulkOperation @{
    Type           = 'maven-add-dependency'
    Description    = 'Add a Maven dependency to pom.xml (before </dependencies>)'
    RequiredParams = @('groupId', 'artifactId', 'version')
    Apply          = {
        param($Params, $Ctx)

        $groupId = [string]$Params['groupId']
        $artifactId = [string]$Params['artifactId']
        $version = [string]$Params['version']
        $scope = if ($Params.Contains('scope') -and -not [string]::IsNullOrEmpty([string]$Params['scope'])) { [string]$Params['scope'] } else { $null }
        $pomRel = if ($Params.Contains('pomPath') -and $Params['pomPath']) { [string]$Params['pomPath'] } else { 'pom.xml' }

        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $pomRel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $pomRel found — skipping." }
        }

        $original = [System.IO.File]::ReadAllText($file)

        # Idempotenz: groupId + artifactId zusammen im SELBEN <dependency>-Element?
        # (Beide Tags nur unabhängig voneinander zu suchen wäre ein False Positive,
        # wenn sie aus verschiedenen <dependency>-Blöcken stammen.)
        $alreadyPresent = $false
        foreach ($dep in [regex]::Matches($original, '(?s)<dependency\s*>.*?</dependency>')) {
            if ($dep.Value.Contains("<groupId>$groupId</groupId>") -and $dep.Value.Contains("<artifactId>$artifactId</artifactId>")) {
                $alreadyPresent = $true
                break
            }
        }
        if ($alreadyPresent) {
            return @{ Changed = $false; Message = "Dependency ${groupId}:${artifactId} already present — skipping." }
        }

        # Schließendes </dependencies> des Projekt-Blocks finden (nicht innerhalb
        # von <dependencyManagement>).
        $closeTag = '</dependencies>'
        $closeIdx = -1
        foreach ($mOpen in [regex]::Matches($original, '<dependencies\s*>')) {
            $ci = $original.IndexOf($closeTag, $mOpen.Index)
            if ($ci -lt 0) { continue }
            $before = $original.Substring(0, $mOpen.Index)
            if ($before.LastIndexOf('<dependencyManagement>') -le $before.LastIndexOf('</dependencyManagement>')) {
                $closeIdx = $ci
                break
            }
        }
        if ($closeIdx -lt 0) {
            $err = "Could not find a project-level <dependencies> block in $pomRel."
            return @{ Changed = $false; Message = 'no project-level <dependencies> block'; Error = $err }
        }

        # Einrückung aus dem Zielblock ableiten.
        $lineStart = $original.LastIndexOf([char]10, $closeIdx) + 1
        $closeLine = $original.Substring($lineStart, $closeIdx - $lineStart)
        $closeIndent = ([regex]::Match($closeLine, '^\s*')).Value
        $blockOpenIdx = $original.LastIndexOf('<dependencies>', $closeIdx)
        $blockContent = if ($blockOpenIdx -ge 0) { $original.Substring($blockOpenIdx, $closeIdx - $blockOpenIdx) } else { '' }
        $depMatch = [regex]::Match($blockContent, "`n([ `t]*)<dependency\s*>")
        $existingDepIndent = if ($depMatch.Success) { $depMatch.Groups[1].Value } else { "$closeIndent  " }
        $step = if ($existingDepIndent.Length -gt $closeIndent.Length) { $existingDepIndent.Substring($closeIndent.Length) } else { '  ' }
        $itemIndent = $existingDepIndent
        $fieldIndent = "$itemIndent$step"

        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add("$itemIndent<dependency>")
        $lines.Add("$fieldIndent<groupId>$groupId</groupId>")
        $lines.Add("$fieldIndent<artifactId>$artifactId</artifactId>")
        $lines.Add("$fieldIndent<version>$version</version>")
        if ($scope) { $lines.Add("$fieldIndent<scope>$scope</scope>") }
        $lines.Add("$itemIndent</dependency>")
        $dependencyBlock = ($lines -join "`n") + "`n"

        $updated = $original.Substring(0, $lineStart) + $dependencyBlock + $original.Substring($lineStart)
        [System.IO.File]::WriteAllText($file, $updated)
        return @{ Changed = $true; Message = "Added ${groupId}:${artifactId}:${version}" }
    }
}

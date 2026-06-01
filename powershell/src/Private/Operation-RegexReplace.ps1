# Operation: regex-replace — sucht in einer Datei per regulärem Ausdruck und
# ersetzt die Treffer. Pendant zu node_ts/src/operations/regex-replace.ts.
#
# Verhalten:
#   Datei fehlt            → Changed=$false (kein Fehler; übersprungen).
#   Ungültiges Pattern     → Error.
#   Kein Treffer           → Changed=$false (bzw. Error, wenn requireMatch).
#   Ersetzung ohne Wirkung → Changed=$false (idempotent).
#   Sonst                  → schreibt das Ergebnis, Changed=$true.
#
# Hinweis: Der PowerShell-Port nutzt die .NET-Regex-Engine. Pattern und
# replacement folgen daher .NET-Syntax ($1, ${name}); die Flags g/i/m/s werden
# auf RegexOptions abgebildet, wobei 'g' (global) in .NET kein Options-Flag ist,
# sondern entscheidet, ob ALLE oder nur der erste Treffer ersetzt werden.

Register-GitBulkOperation @{
    Type           = 'regex-replace'
    Description    = 'Search & replace in a file via a regular expression'
    Params      = @(
        @{ Name = 'path'; Kind = 'string'; Required = $true }
        @{ Name = 'pattern'; Kind = 'string'; Required = $true }
        @{ Name = 'replacement'; Kind = 'string'; Required = $true }
        @{ Name = 'flags'; Kind = 'string'; Required = $false; Default = 'g' }
        @{ Name = 'requireMatch'; Kind = 'boolean'; Required = $false; Default = $false }
    )
    Apply          = {
        param($Params, $Ctx)

        $rel = [string]$Params['path']
        $resolved = Resolve-InRepoPath -RepoDir $Ctx.RepoDir -RelativePath $rel
        if (-not $resolved.Ok) { return @{ Changed = $false; Message = $resolved.Error; Error = $resolved.Error } }
        $file = $resolved.Path

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return @{ Changed = $false; Message = "No $rel found — skipping." }
        }

        $pattern = [string]$Params['pattern']
        $replacement = [string]$Params['replacement']
        $flagsStr = if ($null -ne $Params['flags']) { [string]$Params['flags'] } else { 'g' }
        $requireMatch = [bool]$Params['requireMatch']

        $isGlobal = $flagsStr.Contains('g')
        $options = [System.Text.RegularExpressions.RegexOptions]::None
        if ($flagsStr.Contains('i')) { $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::IgnoreCase }
        if ($flagsStr.Contains('m')) { $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::Multiline }
        if ($flagsStr.Contains('s')) { $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::Singleline }

        try {
            $re = [System.Text.RegularExpressions.Regex]::new($pattern, $options)
        } catch {
            $err = "invalid regex (/$pattern/$flagsStr): $($_.Exception.Message)"
            return @{ Changed = $false; Message = $err; Error = $err }
        }

        $current = [System.IO.File]::ReadAllText($file)
        if (-not $re.IsMatch($current)) {
            if ($requireMatch) {
                $err = "pattern /$pattern/$flagsStr did not match in $rel"
                return @{ Changed = $false; Message = $err; Error = $err }
            }
            return @{ Changed = $false; Message = "No match in $rel — skipping." }
        }

        $updated = if ($isGlobal) { $re.Replace($current, $replacement) } else { $re.Replace($current, $replacement, 1) }
        if ($updated -ceq $current) { return @{ Changed = $false; Message = "$rel unchanged after replace — skipping." } }

        [System.IO.File]::WriteAllText($file, $updated)
        return @{ Changed = $true; Message = "Replaced pattern in $rel" }
    }
}

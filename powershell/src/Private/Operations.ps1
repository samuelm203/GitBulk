# Operations-Fundament für den PowerShell-Port (Pendant zu
# node_ts/src/operations/types.ts + paths.ts).
#
# Eine "Operation" ist ein wiederverwendbarer, deklarativer Code-Change-Baustein
# (z. B. "lege eine Datei an", "ersetze per Regex"). Statt eines frei
# geschriebenen `script:` kann die Config eine verkettbare `operations:`-Liste
# enthalten, die GitBulk im Repo-Verzeichnis ausführt.
#
# Eine Operation ist eine Hashtable mit:
#   Type           [string]      eindeutiger Name, wie er in der Config steht
#   Description    [string]      Kurzbeschreibung (für Hilfe/Generator)
#   RequiredParams [string[]]    Parameter, die in der Config vorhanden sein MÜSSEN
#   Apply          [scriptblock] param($Params, $Ctx) → @{ Changed; Message; Error }
#
# Registriert werden Operationen per Register-GitBulkOperation (im Modul-Loader
# GitBulk.psm1 definiert, damit es schon beim Dot-Sourcing der Operation-Dateien
# verfügbar ist). Die Registry-Hashtable $script:GitBulkOperations lebt ebenfalls
# im Modul-Scope.

# ── Pfad-Sicherheit ──────────────────────────────────────────────────
# Operationen dürfen nur INNERHALB des Repo-Verzeichnisses schreiben/löschen.
# Resolve-InRepoPath weist absolute Pfade und Pfade ab, die über `..` aus dem
# Repo herausführen — so kann eine fehlerhafte/bösartige Config keine Dateien
# außerhalb des Ziel-Repos anfassen (Pendant zu resolveInRepo in paths.ts).
function Resolve-InRepoPath {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$RepoDir,
        [Parameter(Mandatory)][AllowEmptyString()][string]$RelativePath
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        return @{ Ok = $false; Error = "path must be relative to the repo, got absolute '$RelativePath'" }
    }

    $root = [System.IO.Path]::GetFullPath($RepoDir)
    $abs = [System.IO.Path]::GetFullPath((Join-Path $RepoDir $RelativePath))

    # Robuster Präfix-Vergleich: das Wurzelverzeichnis mit angehängtem Separator,
    # damit "<root>foo" nicht fälschlich als innerhalb von "<root>" gilt. Der
    # aufgelöste Pfad muss echt UNTERHALB des Repos liegen (nicht das Repo selbst).
    $rootWithSep = $root.TrimEnd([char]'\', [char]'/') + [System.IO.Path]::DirectorySeparatorChar
    if ($abs -eq $root -or -not $abs.StartsWith($rootWithSep, [System.StringComparison]::Ordinal)) {
        return @{ Ok = $false; Error = "path '$RelativePath' escapes the repo directory" }
    }

    return @{ Ok = $true; Path = $abs }
}

# ── Registry-Zugriff ─────────────────────────────────────────────────
# Liefert die registrierte Operation für einen Typ, oder $null.
function Get-GitBulkOperation {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$Type)

    if ($script:GitBulkOperations.Contains($Type)) {
        return $script:GitBulkOperations[$Type]
    }
    return $null
}

# Liefert alle registrierten Operationen (Typ + Beschreibung), nach Typ sortiert —
# für list-operations / den interaktiven Generator (Phase 6c).
function Get-GitBulkOperationList {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    return @(
        $script:GitBulkOperations.Values |
            Sort-Object -Property Type |
            ForEach-Object { [pscustomobject]@{ Type = $_.Type; Description = $_.Description } }
    )
}

# ── Ausführung ───────────────────────────────────────────────────────
# Führt eine Operation aus und normalisiert das Ergebnis auf
# @{ Changed; Message; Error }. Wirft NIE — ein in Apply geworfener Fehler wird
# zu einem Result mit gesetztem Error (entspricht Exit-Code != 0 bei einem Skript).
function Invoke-GitBulkOperation {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][hashtable]$Operation,
        [Parameter(Mandatory)]$Params,
        [Parameter(Mandatory)]$Context
    )

    try {
        $res = & $Operation.Apply $Params $Context
    } catch {
        $msg = $_.Exception.Message
        return @{ Changed = $false; Message = $msg; Error = $msg }
    }

    $err = if ($res -is [System.Collections.IDictionary] -and $res.Contains('Error')) { $res['Error'] } else { $null }
    return @{
        Changed = [bool]$res.Changed
        Message = [string]$res.Message
        Error   = if ([string]::IsNullOrEmpty([string]$err)) { $null } else { [string]$err }
    }
}

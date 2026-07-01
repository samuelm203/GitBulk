# Persistenter Token-Speicher (Pendant zu node_ts/src/cli/credentials.ts).
#
# Tokens werden NICHT in der Projekt-Config abgelegt, sondern in einer
# nutzereigenen Datei AUSSERHALB jedes Repos:
#   ~/.gitbulk/credentials.json   (Verzeichnis 0700, Datei 0600 — best effort)
#
# Auflösungs-Reihenfolge zur Laufzeit (siehe Resolve-GitBulkToken):
#   1. Env-Variable (hat IMMER Vorrang)
#   2. hier gespeicherter Token
#   3. interaktive Abfrage
#
# Speicherort über GITBULK_HOME umlenkbar (auch für Tests). Tokens werden NIE
# geloggt.

# Plattformen mit Token-Unterstützung (Azure DevOps: noch kein Adapter).
$script:GitBulkTokenPlatforms = @('bitbucket', 'github', 'gitlab')

function Get-GitBulkCredentialDir {
    # GITBULK_HOME übersteuert ~/.gitbulk (für Tests / Custom-Setups).
    $override = [Environment]::GetEnvironmentVariable('GITBULK_HOME')
    if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.gitbulk'
}

function Get-GitBulkCredentialPath {
    return Join-Path (Get-GitBulkCredentialDir) 'credentials.json'
}

function Read-GitBulkCredentialStore {
    # Liest die Datei defensiv; bei Fehlen/Korruptheit → leerer Store (@{}).
    $path = Get-GitBulkCredentialPath
    if (-not (Test-Path -LiteralPath $path)) { return @{} }
    try {
        $raw = Get-Content -Raw -LiteralPath $path -ErrorAction Stop
        $data = $raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if ($data -is [System.Collections.IDictionary] -and $data['tokens'] -is [System.Collections.IDictionary]) {
            return $data['tokens']
        }
    } catch {
        # Korrupt → wie leer behandeln (nicht crashen).
        Write-Verbose "Ignoring unreadable credential store: $_"
    }
    return @{}
}

function Set-GitBulkCredentialPermission {
    param([string]$Path, [string]$Mode)
    # Restriktive Rechte best effort. Unter Windows weitgehend wirkungslos
    # (wie das mode-Flag von Node) → dort übersprungen.
    if ($IsWindows) { return }
    try { & chmod $Mode $Path 2>$null } catch { Write-Verbose "chmod best-effort failed: $_" }
}

function Get-GitBulkStoredToken {
    param([Parameter(Mandatory)][string]$Platform)
    $token = (Read-GitBulkCredentialStore)[$Platform]
    if ($null -ne $token -and -not [string]::IsNullOrWhiteSpace([string]$token)) {
        return [string]$token
    }
    return $null
}

function Set-GitBulkStoredToken {
    param(
        [Parameter(Mandatory)][string]$Platform,
        [Parameter(Mandatory)][string]$Token
    )
    $dir = Get-GitBulkCredentialDir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-GitBulkCredentialPermission -Path $dir -Mode '700'
    }
    $tokens = Read-GitBulkCredentialStore
    $tokens[$Platform] = $Token
    $path = Get-GitBulkCredentialPath
    $json = [ordered]@{ tokens = $tokens } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($path, $json + "`n")
    Set-GitBulkCredentialPermission -Path $path -Mode '600'
    return $path
}

function Remove-GitBulkStoredToken {
    # Entfernt einen Token; 'all' löscht die gesamte Datei. $true, wenn etwas weg ist.
    param([Parameter(Mandatory)][string]$Platform)
    $path = Get-GitBulkCredentialPath
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    if ($Platform -eq 'all') {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        return $true
    }
    $tokens = Read-GitBulkCredentialStore
    if (-not $tokens.Contains($Platform)) { return $false }
    $tokens.Remove($Platform)
    if ($tokens.Count -eq 0) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    } else {
        $json = [ordered]@{ tokens = $tokens } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($path, $json + "`n")
        Set-GitBulkCredentialPermission -Path $path -Mode '600'
    }
    return $true
}

function Get-GitBulkStoredPlatform {
    # Plattformen mit gespeichertem (nicht-leerem) Token.
    $tokens = Read-GitBulkCredentialStore
    return @($script:GitBulkTokenPlatforms | Where-Object {
            $t = $tokens[$_]
            $null -ne $t -and -not [string]::IsNullOrWhiteSpace([string]$t)
        })
}

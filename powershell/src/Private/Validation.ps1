# Validierungs-Helfer für die GitBulk-Config.
#
# Parität zu node_ts/src/utils/validators.ts: dieselben Regeln und
# Fehlermeldungen, damit JSON-/YAML-Configs sich wie in der Node-Version
# verhalten. Jede Funktion liefert ein Result-Objekt:
#   [pscustomobject]@{ Ok = [bool]; Value = <normalisiert>; Error = [string] }

function Test-GitBulkRuList {
    # Akzeptiert komma-separierten String ODER Array; trimmt, entfernt Leere.
    param([AllowNull()] $InputObject)
    $raw = if ($InputObject -is [string]) { $InputObject -split ',' } else { @($InputObject) }
    $cleaned = @($raw | ForEach-Object { "$_".Trim() } | Where-Object { $_.Length -gt 0 })
    if ($cleaned.Count -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: RU list is missing' }
    }
    [pscustomobject]@{ Ok = $true; Value = $cleaned; Error = $null }
}

function ConvertTo-GitBulkBranchName {
    # Sanitisiert einen Branch-Namen (Whitespace→-, verbotene Zeichen weg, …).
    param([string]$InputString)
    $s = $InputString.Trim()
    $s = $s -replace '\s+', '-'
    $s = $s -replace '[~^:?*\[\\]', ''
    $s = $s -replace '-+', '-'
    $s = $s -replace '^-+|-+$', ''
    $s
}

function Test-GitBulkBranchName {
    param([string]$InputString)
    $sanitized = ConvertTo-GitBulkBranchName -InputString $InputString
    $pattern = '^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$|^[A-Za-z0-9]$'
    $forbidden = @('..', '@{', '//', '.lock')

    $invalid = ($sanitized.Length -eq 0 -or $sanitized.Length -gt 255 -or $sanitized -notmatch $pattern)
    if (-not $invalid) {
        foreach ($seq in $forbidden) {
            if ($sanitized.Contains($seq)) { $invalid = $true; break }
        }
    }
    if ($invalid) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: Invalid branch name' }
    }
    [pscustomobject]@{ Ok = $true; Value = $sanitized; Error = $null }
}

function Test-GitBulkTicket {
    param([string]$InputString)
    $t = $InputString.Trim().ToUpperInvariant()
    if ($t.Length -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: Ticket is missing' }
    }
    if ($t -notmatch '^[A-Z0-9][A-Z0-9-]*$') {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: Invalid ticket format' }
    }
    [pscustomobject]@{ Ok = $true; Value = $t; Error = $null }
}

function Test-GitBulkMessage {
    param([string]$InputString)
    $m = $InputString.Trim()
    if ($m.Length -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: Message is empty' }
    }
    [pscustomobject]@{ Ok = $true; Value = $m; Error = $null }
}

function Test-GitBulkFilePath {
    # Prüft, dass eine Datei existiert (relativ zu BaseDir bzw. absolut).
    param([string]$InputString, [string]$BaseDir = (Get-Location).Path)
    $trimmed = $InputString.Trim()
    if ($trimmed.Length -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: File path is missing' }
    }
    $absolute = if ([System.IO.Path]::IsPathRooted($trimmed)) { $trimmed } else { Join-Path $BaseDir $trimmed }
    if (-not (Test-Path -LiteralPath $absolute)) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: File not found!' }
    }
    if (Test-Path -LiteralPath $absolute -PathType Container) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Error: Path is not a file' }
    }
    [pscustomobject]@{ Ok = $true; Value = ((Resolve-Path -LiteralPath $absolute).Path); Error = $null }
}

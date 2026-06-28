# Validierungs-Helfer für die GitBulk-Config.
#
# Parität zu node_ts/src/utils/validators.ts: dieselben Regeln und
# Fehlermeldungen, damit JSON-/YAML-Configs sich wie in der Node-Version
# verhalten. Jede Funktion liefert ein Result-Objekt:
#   [pscustomobject]@{ Ok = [bool]; Value = <normalisiert>; Error = [string] }

function Test-GitBulkRuList {
    # Akzeptiert: komma-separierten String, Array von Namen ODER Array mit
    # gemischten Einträgen (Name ODER { repo, workspace }). Liefert die RU-Namen
    # plus eine optionale Workspace-Map (Per-RU-Override für Bitbucket/GitHub),
    # damit RUs aus mehreren Workspaces in EINEM Lauf landen können.
    param([AllowNull()] $InputObject)

    $raw = if ($InputObject -is [string]) { $InputObject -split ',' } else { @($InputObject) }

    $names = [System.Collections.Generic.List[string]]::new()
    $workspaces = @{}

    foreach ($entry in $raw) {
        $repo = $null
        $ws = $null

        if ($entry -is [string]) {
            $repo = $entry.Trim()
        } elseif ($entry -is [System.Collections.IDictionary]) {
            $repo = "$($entry['repo'])".Trim()
            if (-not [string]::IsNullOrWhiteSpace([string]$entry['workspace'])) { $ws = ([string]$entry['workspace']).Trim() }
        } elseif ($null -ne $entry -and ($entry.PSObject.Properties.Name -contains 'repo')) {
            $repo = "$($entry.repo)".Trim()
            $wsProp = $entry.PSObject.Properties['workspace']
            if ($wsProp -and -not [string]::IsNullOrWhiteSpace([string]$wsProp.Value)) { $ws = ([string]$wsProp.Value).Trim() }
        } else {
            $repo = "$entry".Trim()
        }

        if ([string]::IsNullOrEmpty($repo)) { continue }

        if ($null -ne $ws) {
            # Workspace landet in Pfaden und URLs → Path-Traversal/Injection abwehren.
            if ($ws -match '[\\/]' -or $ws.Contains('..')) {
                return [pscustomobject]@{ Ok = $false; Value = $null; Workspaces = @{}
                    Error = "Error: invalid workspace '$ws' for RU '$repo' (no '/', '\' or '..')"
                }
            }
            $workspaces[$repo] = $ws
        }
        $names.Add($repo)
    }

    if ($names.Count -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Workspaces = @{}; Error = 'Error: RU list is missing' }
    }
    [pscustomobject]@{ Ok = $true; Value = $names.ToArray(); Workspaces = $workspaces; Error = $null }
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

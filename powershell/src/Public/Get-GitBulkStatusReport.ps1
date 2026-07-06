function Get-GitBulkStatusReport {
    <#
    .SYNOPSIS
        Sammelt den PR-Status aller RUs einer Config (read-only, Pendant zu
        collectPrStatus/runStatus in node_ts/src/git/pr-status.ts + cli/status.ts).

    .DESCRIPTION
        Lädt die Config, wendet optional -Only an, stellt den Token sicher
        (env > store > prompt) und schlägt pro RU den PR über den Source-Branch
        nach (`<ticket>-<branch>`, wie im Lauf). Per-RU-Workspace-Overrides werden
        berücksichtigt. Führt KEINE Git- oder Schreib-Operationen aus.

        Bei einem Setup-Fehler (Config, unbekannter -Only-RU, fehlender Token,
        nicht unterstützte Plattform) wird nach stderr geschrieben und `$null`
        zurückgegeben — der Aufrufer endet dann mit Exit 3.

    .PARAMETER ConfigPath
        Pfad zur Config-Datei (.json / .yaml / .yml).

    .PARAMETER Only
        Nur diese RUs prüfen (komma-separierte Teilmenge).

    .OUTPUTS
        [pscustomobject] mit Ticket, SourceBranch, Platform, Results[] und Totals,
        oder `$null` bei einem Setup-Fehler.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string]$ConfigPath,

        [string]$Only
    )

    function writeErr([string]$Message) { [Console]::Error.WriteLine("gitbulk: $Message") }

    try {
        $config = Get-GitBulkConfig -Path $ConfigPath
    } catch {
        writeErr "config error: $($_.Exception.Message)"
        return $null
    }

    if ($Only) {
        $wanted = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $unknown = @($wanted | Where-Object { $_ -notin $config.rus })
        if ($unknown.Count -gt 0) {
            writeErr "--only: unknown RU(s): $($unknown -join ', '). Configured: $($config.rus -join ', ')"
            return $null
        }
        $config.rus = @($config.rus | Where-Object { $_ -in $wanted })
        if ($config.rus.Count -eq 0) { writeErr '--only: no RUs left after filtering'; return $null }
    }

    # Token-Guard: status ruft die PR-API → IMMER ein Token nötig (kein Dry-Run).
    $interactive = -not [Console]::IsInputRedirected
    $tok = Resolve-GitBulkToken -Platform ([string]$config.prPlatform) -Interactive:$interactive
    if (-not $tok.Ok) { writeErr $tok.Error; return $null }

    $sourceBranch = "$($config.ticket)-$($config.branch)"
    $results = [System.Collections.Generic.List[object]]::new()
    $totals = [ordered]@{ Open = 0; Merged = 0; Declined = 0; None = 0; Errored = 0 }

    foreach ($ru in @($config.rus)) {
        $ws = ''
        if ($config.Contains('ruWorkspaces') -and $config.ruWorkspaces.Contains($ru)) {
            $ws = [string]$config.ruWorkspaces[$ru]
        }
        $st = Get-GitBulkPrStatus -Config $config -Ru $ru -SourceBranch $sourceBranch -Workspace $ws

        $row = [ordered]@{ Ru = $ru; State = [string]$st.State }
        if ($st.Contains('Id')) { $row.Id = $st.Id }
        if ($st.Contains('Url')) { $row.Url = $st.Url }
        if ($st.Contains('Approvals')) { $row.Approvals = $st.Approvals }
        if ($st.Contains('Ci')) { $row.Ci = $st.Ci }
        if ($st.Contains('Error') -and $st.Error) { $row.Error = $st.Error }
        $results.Add([pscustomobject]$row)

        if ($st.Contains('Error') -and $st.Error) {
            $totals.Errored++
        } else {
            switch ([string]$st.State) {
                'open' { $totals.Open++ }
                'merged' { $totals.Merged++ }
                'declined' { $totals.Declined++ }
                default { $totals.None++ }
            }
        }
    }

    return [pscustomobject]@{
        Ticket       = [string]$config.ticket
        SourceBranch = $sourceBranch
        Platform     = [string]$config.prPlatform
        Results      = $results.ToArray()
        Totals       = [pscustomobject]$totals
    }
}

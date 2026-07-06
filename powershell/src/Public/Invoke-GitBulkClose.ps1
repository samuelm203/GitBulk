function Invoke-GitBulkClose {
    <#
    .SYNOPSIS
        Schließt die offenen PRs eines Ticket/Branch über alle RUs und löscht
        die Remote-Feature-Branches (Pendant zu `gitbulk close` der Node-CLI).

    .DESCRIPTION
        Das Aufräum-Gegenstück zum Lauf (z. B. nach einem Fehl-Lauf): pro RU wird
        der PR-Status nachgeschlagen, ein offener PR über die Plattform-API
        geschlossen/declined und der Remote-Feature-Branch aus dem lokalen Repo
        gelöscht (`git push origin --delete`). Destruktiv → ohne -DryRun wird im
        Terminal bestätigt (oder -Yes für CI).

    .PARAMETER ConfigPath
        Pfad zur Config-Datei (.json / .yaml / .yml).

    .PARAMETER Only
        Nur diese RUs verarbeiten (komma-separierte Teilmenge).

    .PARAMETER DryRun
        Nur anzeigen, was passieren würde (keine API-/Push-Aufrufe).

    .PARAMETER Yes
        Bestätigung überspringen (für CI; Pflicht in Nicht-TTY-Umgebungen).

    .PARAMETER Json
        Report als JSON statt Tabelle ausgeben.

    .PARAMETER NoColor
        Ausgabe ohne Farben.

    .OUTPUTS
        [int] Exit-Code: 0 = ok, 1 = mind. ein Close/Delete schlug fehl,
        3 = Setup-Fehler oder abgebrochen.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [string]$ConfigPath,

        [string]$Only,
        [switch]$DryRun,
        [switch]$Yes,
        [switch]$Json,
        [switch]$NoColor
    )

    function writeErrLine([string]$Message) { [Console]::Error.WriteLine("gitbulk: $Message") }

    # ── Config laden + -Only ────────────────────────────────────────
    try {
        $config = Get-GitBulkConfig -Path $ConfigPath
    } catch {
        writeErrLine "config error: $($_.Exception.Message)"
        return 3
    }
    if ($Only) {
        $wanted = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $unknown = @($wanted | Where-Object { $_ -notin $config.rus })
        if ($unknown.Count -gt 0) {
            writeErrLine "-Only: unknown RU(s): $($unknown -join ', '). Configured: $($config.rus -join ', ')"
            return 3
        }
        $config.rus = @($config.rus | Where-Object { $_ -in $wanted })
    }

    $isDryRun = [bool]$DryRun -or [bool]$config.dryRun

    # ── Bestätigung (destruktiv) ────────────────────────────────────
    $interactive = -not [Console]::IsInputRedirected
    if (-not $isDryRun -and -not $Yes) {
        if (-not $interactive) {
            writeErrLine 'gitbulk -Close is destructive — pass -Yes in non-interactive mode (or preview with -DryRun first).'
            return 3
        }
        $answer = ([string](Read-Host -Prompt "Close all open PRs for ticket $($config.ticket) ($(@($config.rus).Count) RUs) and delete the remote feature branches? [y/N]")).Trim().ToLowerInvariant()
        if ($answer -notin @('y', 'yes')) {
            [Console]::Error.WriteLine('Aborted — nothing was changed.')
            return 3
        }
    }

    # ── Token sicherstellen (Status-Lookup braucht ihn auch im Dry-Run) ──
    $tok = Resolve-GitBulkToken -Platform ([string]$config.prPlatform) -Interactive:$interactive
    if (-not $tok.Ok) { writeErrLine $tok.Error; return 3 }

    # ── Pro RU: Status → Close → Branch-Delete ─────────────────────
    $sourceBranch = "$($config.ticket)-$($config.branch)"
    $workspaceDir = if ($config.Contains('workspaceDir')) { [string]$config.workspaceDir } else { (Get-Location).Path }
    $timeout = if ($config.Contains('commandTimeoutMs')) { [int]$config.commandTimeoutMs } else { 120000 }
    $results = [System.Collections.Generic.List[object]]::new()
    $totals = [ordered]@{ PrsClosed = 0; NoOpenPr = 0; BranchesDeleted = 0; Failed = 0 }

    foreach ($ru in @($config.rus)) {
        $ws = ''
        if ($config.Contains('ruWorkspaces') -and $config.ruWorkspaces.Contains($ru)) {
            $ws = [string]$config.ruWorkspaces[$ru]
        }
        $row = [ordered]@{ Ru = $ru; Pr = 'no-open-pr'; Branch = 'repo-missing' }

        # 1. Status nachschlagen.
        $st = Get-GitBulkPrStatus -Config $config -Ru $ru -SourceBranch $sourceBranch -Workspace $ws
        if ($st.Contains('Id')) { $row.PrId = $st.Id }
        if ($st.Contains('Url')) { $row.PrUrl = $st.Url }

        if ($st.Contains('Error') -and $st.Error) {
            $row.Pr = 'error'; $row.Error = [string]$st.Error
            $totals.Failed++
            $results.Add([pscustomobject]$row)
            continue
        }

        # 2. Offenen PR schließen.
        if ([string]$st.State -eq 'open' -and $st.Contains('Id')) {
            if ($isDryRun) {
                $row.Pr = 'would-close'
            } else {
                $closed = Close-GitBulkPr -Config $config -Ru $ru -Id $st.Id -Workspace $ws
                if ($closed.Ok) { $row.Pr = 'closed' } else { $row.Pr = 'close-failed'; $row.Error = [string]$closed.Error }
            }
        }

        # 3. Remote-Feature-Branch löschen (auch ohne offenen PR — Aufräumen).
        $repoPath = if ($ws) { Join-Path (Join-Path $workspaceDir $ws) $ru } else { Join-Path $workspaceDir $ru }
        if (-not (Test-Path -LiteralPath (Join-Path $repoPath '.git'))) {
            $row.Branch = 'repo-missing'
        } elseif ($isDryRun) {
            $row.Branch = 'would-delete'
        } else {
            $del = Invoke-Git -Arguments @('push', 'origin', '--delete', $sourceBranch) -Cwd $repoPath -TimeoutMs $timeout
            if ($del.ExitCode -eq 0) {
                $row.Branch = 'deleted'
            } elseif ($del.Stderr -match 'remote ref does not exist') {
                # Branch existiert remote (schon) nicht — Ziel erreicht.
                $row.Branch = 'not-found'
            } else {
                $row.Branch = 'delete-failed'
                if (-not $row.Contains('Error')) { $row.Error = ($del.Stderr).Trim() }
            }
        }

        if ($row.Pr -in @('closed', 'would-close')) { $totals.PrsClosed++ }
        if ($row.Pr -eq 'no-open-pr') { $totals.NoOpenPr++ }
        if ($row.Branch -in @('deleted', 'would-delete')) { $totals.BranchesDeleted++ }
        if ($row.Pr -eq 'close-failed' -or $row.Branch -eq 'delete-failed') { $totals.Failed++ }
        $results.Add([pscustomobject]$row)
    }

    $report = [pscustomobject]@{
        Ticket       = [string]$config.ticket
        SourceBranch = $sourceBranch
        Platform     = [string]$config.prPlatform
        DryRun       = $isDryRun
        Results      = $results.ToArray()
        Totals       = [pscustomobject]$totals
    }

    # ── Ausgabe ─────────────────────────────────────────────────────
    # JSON via [Console]::Out (nicht Pipeline) — der Rückgabewert der Funktion
    # ist der Exit-Code und darf sich nicht mit der Ausgabe mischen.
    if ($Json) {
        [Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 6))
    } else {
        $mode = if ($isDryRun) { ' · DRY-RUN' } else { '' }
        Write-GitBulkLine -Message "Ticket $($report.Ticket) · branch $($report.SourceBranch) · $($report.Platform) · $(@($report.Results).Count) RUs$mode" -NoColor:$NoColor
        Write-GitBulkLine -Message '' -NoColor:$NoColor
        foreach ($r in @($report.Results)) {
            $pr = if ($null -ne $r.PSObject.Properties['PrId']) { "#$($r.PrId)" } else { '-' }
            $note = if ($null -ne $r.PSObject.Properties['Error']) { "(error: $($r.Error))" } elseif ($null -ne $r.PSObject.Properties['PrUrl']) { [string]$r.PrUrl } else { '' }
            $line = '  {0,-22} {1,-6} {2,-12} {3,-13} {4}' -f $r.Ru, $pr, $r.Pr, $r.Branch, $note
            $color = switch ([string]$r.Pr) {
                'closed' { 'Green' } 'would-close' { 'Green' }
                'close-failed' { 'Red' } 'error' { 'Red' }
                default { 'DarkGray' }
            }
            if ($NoColor) { Write-GitBulkLine -Message $line -NoColor } else { Write-GitBulkLine -Message $line -Color $color }
        }
        $t = $report.Totals
        $verb = if ($isDryRun) { 'would be closed' } else { 'closed' }
        $bverb = if ($isDryRun) { 'would be deleted' } else { 'deleted' }
        $summary = "Summary: $($t.PrsClosed) PRs $verb · $($t.NoOpenPr) without open PR · $($t.BranchesDeleted) branches $bverb"
        if ($t.Failed -gt 0) { $summary += " · $($t.Failed) failed" }
        Write-GitBulkLine -Message '' -NoColor:$NoColor
        Write-GitBulkLine -Message $summary -NoColor:$NoColor
    }

    if ($report.Totals.Failed -gt 0) { return 1 }
    return 0
}

function Invoke-GitBulkRun {
    <#
    .SYNOPSIS
        Führt den GitBulk-Lauf über alle RUs aus (Pendant zu node_ts/src/core/runner.ts).

    .DESCRIPTION
        Verarbeitet jede RU der Config über Invoke-GitBulkRu — parallel mit
        `ForEach-Object -Parallel` (ThrottleLimit = config.concurrency). Liefert
        eine Zusammenfassung mit den Einzel-Ergebnissen und Zählern.

        Hinweis: Parallele Runspaces haben das Modul nicht geladen; der Block
        importiert es daher neu und ruft die (private) Invoke-GitBulkRu im
        Modul-Scope auf. Ein Fehler in einer RU isoliert sich auf deren Ergebnis.

    .PARAMETER Config
        Eine validierte Config (Ausgabe von Get-GitBulkConfig).

    .OUTPUTS
        Ein Summary-Objekt mit Results (pro RU) und Totals.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        $Config
    )

    $modulePath = $MyInvocation.MyCommand.Module.Path
    if (-not $modulePath) { $modulePath = (Get-Module GitBulk).Path }
    $throttle = [Math]::Max(1, [int]$Config.concurrency)
    $rus = @($Config.rus)

    $results = $rus | ForEach-Object -ThrottleLimit $throttle -Parallel {
        $ru = $_
        $cfg = $using:Config
        $modPath = $using:modulePath
        try {
            Import-Module $modPath -Force -ErrorAction Stop
            # Private Funktion → im Modul-Scope aufrufen.
            & (Get-Module GitBulk) { param($c, $r) Invoke-GitBulkRu -Config $c -Ru $r } $cfg $ru
        } catch {
            [pscustomobject]@{
                Ru = $ru; Branch = ''; Outcome = 'fatal'; CodeChangeOk = $false
                Message = ''; Error = "runner error: $($_.Exception.Message)"
            }
        }
    }

    $results = @($results)

    # ── Zusammenfassung ──────────────────────────────────────────────
    $countBy = { param($o) @($results | Where-Object { $_.Outcome -eq $o }).Count }

    [pscustomobject]@{
        Results   = $results
        Total     = $results.Count
        PrCreated = (& $countBy 'pr-created')
        PrFailed  = (& $countBy 'pr-failed')
        Pushed    = (& $countBy 'pushed')       # gepusht ohne PR (z. B. Code-Change-Fehler ohne createPrOnError)
        Committed = (& $countBy 'committed')    # Dry-Run
        NoChanges = (& $countBy 'no-changes')
        Skipped   = (& $countBy 'skipped')
        Fatal     = @($results | Where-Object { $_.Outcome -in @('fatal', 'push-failed') }).Count
    }
}

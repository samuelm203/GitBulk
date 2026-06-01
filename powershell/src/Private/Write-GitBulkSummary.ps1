# Druckt den Abschluss-Report eines GitBulk-Laufs (Pendant zu reporter.ts):
# eine Zeile pro RU mit Outcome + Detail, danach die Gesamt-Zähler.

function Write-GitBulkSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Summary,
        [switch]$NoColor
    )

    # Farbe je Outcome (nur bei Farb-Ausgabe).
    $color = {
        param([string]$outcome)
        switch ($outcome) {
            'pr-created' { 'Green' }
            'pushed' { 'Green' }
            'committed' { 'Cyan' }
            'no-changes' { 'DarkGray' }
            'skipped' { 'DarkGray' }
            'pr-failed' { 'Yellow' }
            default { 'Red' }   # fatal / push-failed
        }
    }

    Write-Host ''
    Write-Host '── GitBulk Run Summary ──────────────────────────────────────────'

    foreach ($r in @($Summary.Results)) {
        $detail = if ($r.PrUrl) { $r.PrUrl } elseif ($r.Error) { $r.Error } else { $r.Message }
        $line = '  {0,-22} {1,-12} {2}' -f $r.Ru, $r.Outcome, $detail
        if ($NoColor) {
            Write-Host $line
        } else {
            Write-Host $line -ForegroundColor (& $color $r.Outcome)
        }
    }

    Write-Host ''
    $totals = "Total: $($Summary.Total) RUs — $($Summary.PrCreated) PR created, " +
        "$($Summary.Pushed) pushed (no PR), $($Summary.Committed) committed (dry-run), " +
        "$($Summary.NoChanges) no-changes, $($Summary.Skipped) skipped, " +
        "$($Summary.PrFailed) PR failed, $($Summary.Fatal) fatal"
    Write-Host $totals
}

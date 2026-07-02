# Maschinenlesbarer Lauf-Report (`-Report out.json`) — Pendant zu
# node_ts/src/core/report-file.ts. Baut aus Config + Summary ein JSON-
# serialisierbares Objekt (pro RU Outcome/PR-Link/Fehler, Totals, Metadaten,
# Exit-Code) und schreibt es pretty-printed auf Platte.
#
# Format via reportVersion versioniert; der Report enthält NIE Tokens — nur
# Summary-Daten und unkritische Config-Felder (Plattform, Ticket, Branch).

function Get-GitBulkRunReport {
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $Summary,
        [Parameter(Mandatory)][int]$ExitCode,
        [Parameter(Mandatory)][datetime]$StartedAt,
        [Parameter(Mandatory)][datetime]$FinishedAt
    )

    $results = @(foreach ($r in @($Summary.Results)) {
            $entry = [ordered]@{ ru = [string]$r.Ru; outcome = [string]$r.Outcome }
            if ($r.Branch) { $entry.branch = [string]$r.Branch }
            if ($r.PrUrl) { $entry.prUrl = [string]$r.PrUrl }
            if ($r.Error) { $entry.error = [string]$r.Error }
            if ($r.Message) { $entry.message = [string]$r.Message }
            [pscustomobject]$entry
        })

    return [ordered]@{
        reportVersion   = 1
        gitbulkVersion  = [string](Get-GitBulkVersion)
        startedAt       = $StartedAt.ToUniversalTime().ToString('o')
        finishedAt      = $FinishedAt.ToUniversalTime().ToString('o')
        totalDurationMs = [long]($FinishedAt - $StartedAt).TotalMilliseconds
        dryRun          = [bool]$Config.dryRun
        prPlatform      = [string]$Config.prPlatform
        ticket          = [string]$Config.ticket
        branch          = [string]$Config.branch
        sourceBranch    = [string]$Config.sourceBranch
        exitCode        = $ExitCode
        totals          = [ordered]@{
            total     = [int]$Summary.Total
            prCreated = [int]$Summary.PrCreated
            prFailed  = [int]$Summary.PrFailed
            pushed    = [int]$Summary.Pushed
            committed = [int]$Summary.Committed
            noChanges = [int]$Summary.NoChanges
            skipped   = [int]$Summary.Skipped
            fatal     = [int]$Summary.Fatal
        }
        results         = $results
    }
}

function Write-GitBulkRunReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)] $Report
    )
    $json = $Report | ConvertTo-Json -Depth 10
    Set-Content -LiteralPath $Path -Value $json -Encoding utf8
}

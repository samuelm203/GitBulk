# `-RetryFailed <report.json>` — liest die zu wiederholenden RUs aus einem
# `-Report`-JSON (Pendant zu node_ts/src/cli/retry-failed.ts).
#
# Wiederholt werden Outcomes, die einen erneuten Lauf rechtfertigen. Neben dem
# PS-Vokabular (pr-failed / fatal / push-failed) werden auch die node-Pendants
# (fatal-error / not-processed) akzeptiert, damit Reports beider
# Implementierungen austauschbar sind. `pr-created`, `committed`, `no-changes`
# und `skipped` (Repo fehlt) werden NICHT wiederholt.

$script:GitBulkRetryOutcomes = @('pr-failed', 'fatal', 'push-failed', 'fatal-error', 'not-processed')

function Get-GitBulkRetryRus {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string]$ReportPath)

    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        throw "-RetryFailed: cannot read report file: $ReportPath"
    }
    $raw = Get-Content -LiteralPath $ReportPath -Raw

    try {
        $data = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "-RetryFailed: '$ReportPath' is not valid JSON."
    }

    $resultsProp = if ($null -ne $data) { $data.PSObject.Properties['results'] } else { $null }
    if ($null -eq $resultsProp -or $resultsProp.Value -isnot [System.Array]) {
        throw ("-RetryFailed: '$ReportPath' is not a GitBulk run report (missing 'results' array). " +
            'Generate one with ./gitbulk.ps1 -Config ... -Report out.json.')
    }
    # Vorwärts-Kompatibilität: eine höhere reportVersion klar ablehnen statt
    # still falsch zu interpretieren.
    $versionProp = $data.PSObject.Properties['reportVersion']
    if ($null -ne $versionProp -and $versionProp.Value -is [ValueType] -and [int]$versionProp.Value -gt 1) {
        throw "-RetryFailed: report version $($versionProp.Value) is newer than supported (1). Update gitbulk."
    }

    # Malformierte Einträge defensiv überspringen (kein Crash bei Fremd-JSON).
    return @(foreach ($e in @($resultsProp.Value)) {
            if ($null -ne $e -and $e.ru -is [string] -and $e.outcome -is [string] -and
                $e.outcome -in $script:GitBulkRetryOutcomes) { $e.ru }
        })
}

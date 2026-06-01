function Invoke-GitBulk {
    <#
    .SYNOPSIS
        Die GitBulk-CLI: lädt eine Config, führt den Lauf aus und druckt den Report.

    .DESCRIPTION
        End-to-End-Einstiegspunkt (Pendant zu node_ts/src/cli/index.ts):
          1. Config laden + validieren (Get-GitBulkConfig).
          2. -DryRun / -Only anwenden.
          3. Lauf über alle RUs (Invoke-GitBulkRun).
          4. Abschluss-Report (Write-GitBulkSummary).
        Liefert einen Exit-Code (0 ok, 1 PR-Fehler, 2 fatal, 3 Setup-Fehler).

    .PARAMETER ConfigPath
        Pfad zur Config-Datei (.json / .yaml / .yml).

    .PARAMETER DryRun
        Keine schreibenden Operationen (kein push, kein PR) — überschreibt die Config.

    .PARAMETER Only
        Nur diese RUs verarbeiten (komma-separierte Teilmenge der konfigurierten RUs).

    .PARAMETER NoColor
        Report ohne Farben ausgeben.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [string]$ConfigPath,

        [switch]$DryRun,
        [string]$Only,
        [switch]$NoColor
    )

    # ── 1. Config laden ──────────────────────────────────────────────
    try {
        $config = Get-GitBulkConfig -Path $ConfigPath
    } catch {
        Write-Error "Config error: $($_.Exception.Message)"
        return 3
    }

    # ── 2. Overrides ─────────────────────────────────────────────────
    if ($DryRun) { $config.dryRun = $true }

    if ($Only) {
        $wanted = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $unknown = @($wanted | Where-Object { $_ -notin $config.rus })
        if ($unknown.Count -gt 0) {
            Write-Error "--only: unknown RU(s): $($unknown -join ', '). Configured: $($config.rus -join ', ')"
            return 3
        }
        $filtered = @($config.rus | Where-Object { $_ -in $wanted })
        if ($filtered.Count -eq 0) {
            Write-Error '--only: no RUs left after filtering'
            return 3
        }
        $config.rus = $filtered
    }

    # ── 3. Lauf ──────────────────────────────────────────────────────
    $summary = Invoke-GitBulkRun -Config $config

    # ── 4. Report ────────────────────────────────────────────────────
    Write-GitBulkSummary -Summary $summary -NoColor:$NoColor

    # ── 5. Exit-Code ─────────────────────────────────────────────────
    if ($summary.Fatal -gt 0) { return 2 }
    if ($summary.PrFailed -gt 0) { return 1 }
    return 0
}

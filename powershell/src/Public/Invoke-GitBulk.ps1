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
        Liefert IMMER einen Exit-Code (0 ok, 1 PR-Fehler, 2 fatal, 3 Setup-Fehler) —
        Fehler werden nach stderr geschrieben (via [Console]::Error, nie terminating),
        damit der CLI-Kontrakt auch unter $ErrorActionPreference='Stop' gilt.

    .PARAMETER ConfigPath
        Pfad zur Config-Datei (.json / .yaml / .yml).

    .PARAMETER DryRun
        Keine schreibenden Operationen (kein push, kein PR) — überschreibt die Config.

    .PARAMETER Only
        Nur diese RUs verarbeiten (komma-separierte Teilmenge der konfigurierten RUs).

    .PARAMETER Report
        Schreibt nach dem Lauf einen maschinenlesbaren JSON-Report (für CI):
        pro RU Outcome + PR-Link/Fehler, Totals, Metadaten und Exit-Code.

    .PARAMETER RetryFailed
        Pfad zu einem früheren -Report-JSON: nur die dort fehlgeschlagenen RUs
        (pr-failed / fatal / push-failed) erneut verarbeiten. Schließt -Only aus.

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
        [string]$Report,
        [string]$RetryFailed,
        [switch]$NoColor
    )

    # Fehler nach stderr — NICHT Write-Error: das Modul setzt
    # $ErrorActionPreference='Stop', wodurch Write-Error terminating würde und
    # den garantierten Exit-Code verhinderte.
    function writeErrLine([string]$Message) { [Console]::Error.WriteLine("gitbulk: $Message") }

    if ($RetryFailed -and $Only) {
        writeErrLine '-RetryFailed and -Only are mutually exclusive.'
        return 3
    }

    # ── 1. Config laden ──────────────────────────────────────────────
    try {
        $config = Get-GitBulkConfig -Path $ConfigPath
    } catch {
        writeErrLine "config error: $($_.Exception.Message)"
        return 3
    }

    # ── 2. Overrides ─────────────────────────────────────────────────
    if ($DryRun) { $config.dryRun = $true }

    if ($Only) {
        $wanted = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $unknown = @($wanted | Where-Object { $_ -notin $config.rus })
        if ($unknown.Count -gt 0) {
            writeErrLine "--only: unknown RU(s): $($unknown -join ', '). Configured: $($config.rus -join ', ')"
            return 3
        }
        $filtered = @($config.rus | Where-Object { $_ -in $wanted })
        if ($filtered.Count -eq 0) {
            writeErrLine '--only: no RUs left after filtering'
            return 3
        }
        $config.rus = $filtered
    }

    # ── 2a. -RetryFailed: nur die Fehlschläge eines früheren Reports ──
    if ($RetryFailed) {
        try {
            $retryRus = @(Get-GitBulkRetryRus -ReportPath $RetryFailed)
        } catch {
            writeErrLine $_.Exception.Message
            return 3
        }
        if ($retryRus.Count -eq 0) {
            Write-GitBulkLine -Message 'Nothing to retry — the report contains no failed RUs.' -NoColor:$NoColor
            return 0
        }
        $unknown = @($retryRus | Where-Object { $_ -notin $config.rus })
        if ($unknown.Count -gt 0) {
            writeErrLine "-RetryFailed: unknown RU(s): $($unknown -join ', '). Configured: $($config.rus -join ', ')"
            return 3
        }
        $config.rus = @($config.rus | Where-Object { $_ -in $retryRus })
    }

    # ── 2b. Token-Guard: env > gespeicherter Token > interaktive Abfrage ──
    # Im Dry-Run wird kein Token verlangt (keine PR-API-Aufrufe).
    $interactive = -not [Console]::IsInputRedirected
    $tokenResult = Resolve-GitBulkToken -Platform ([string]$config.prPlatform) `
        -Interactive:$interactive -DryRun:([bool]$config.dryRun)
    if (-not $tokenResult.Ok) {
        writeErrLine $tokenResult.Error
        return 3
    }

    # ── 3./4. Lauf + Report ──────────────────────────────────────────
    # Unerwartete Fehler werden zu Exit 2 (fatal) — der CLI-Einstiegspunkt
    # soll nie unkontrolliert werfen.
    $startedAt = [DateTime]::UtcNow
    try {
        $summary = Invoke-GitBulkRun -Config $config
        Write-GitBulkSummary -Summary $summary -NoColor:$NoColor
    } catch {
        writeErrLine "unexpected error during run: $($_.Exception.Message)"
        return 2
    }
    $finishedAt = [DateTime]::UtcNow

    # ── 5. Exit-Code ─────────────────────────────────────────────────
    $exitCode = if ($summary.Fatal -gt 0) { 2 } elseif ($summary.PrFailed -gt 0) { 1 } else { 0 }

    # ── 6. -Report: maschinenlesbaren JSON-Report schreiben ─────────
    if ($Report) {
        try {
            $reportObj = Get-GitBulkRunReport -Config $config -Summary $summary -ExitCode $exitCode `
                -StartedAt $startedAt -FinishedAt $finishedAt
            Write-GitBulkRunReport -Path $Report -Report $reportObj
            Write-GitBulkLine -Message "Run report written to $Report" -NoColor:$NoColor
        } catch {
            # CI hat den Report explizit angefordert — ein Schreibfehler darf einen
            # sonst grünen Lauf nicht still passieren lassen. Echte Lauf-Fehler
            # (1/2) behalten aber Vorrang vor dem Setup-Fehler 3.
            writeErrLine "-Report: cannot write '$Report': $($_.Exception.Message)"
            if ($exitCode -ne 0) { return $exitCode }
            return 3
        }
    }

    return $exitCode
}

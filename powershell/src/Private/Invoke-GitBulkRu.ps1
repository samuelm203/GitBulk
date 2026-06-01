# Verarbeitet EINE Repository-Unit (RU) — das Pendant zu node_ts/src/git/phase3.ts.
#
# Ablauf: Repo sicherstellen → Source-Branch aktualisieren → Feature-Branch
# anlegen → Code-Change ausführen → Diff prüfen → committen → pushen (mit Retry).
# Die Pull-Request-Erstellung (Phase 4) ist hier NOCH NICHT enthalten.
#
# Liefert ein Result-Objekt mit `Outcome`:
#   skipped       Repo fehlt lokal und cloneIfMissing ist aus
#   no-changes    Code-Change erzeugte keinen Diff → Feature-Branch gelöscht
#   committed     Dry-Run: committed, aber nicht gepusht
#   pushed        committet und gepusht
#   push-failed   Push nach allen Retries fehlgeschlagen
#   fatal         Git-Schritt fehlgeschlagen (fetch/checkout/commit …)
# `CodeChangeOk` zeigt zusätzlich an, ob der Code-Change selbst erfolgreich war
# (bei Fehler + Diff lautet die Commit-Message "ERROR WHILE CODE CHANGE").

function Invoke-GitBulkRu {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        $Config,

        [Parameter(Mandatory)]
        [string]$Ru
    )

    $timeout = [int]$Config.commandTimeoutMs
    $skipHooks = [bool]$Config.skipHooks
    $sourceBranch = [string]$Config.sourceBranch
    $workspaceDir = if ($Config.Contains('workspaceDir')) { [string]$Config.workspaceDir } else { (Get-Location).Path }
    $repoPath = Join-Path $workspaceDir $Ru
    $branchName = "$($Config.ticket)-$($Config.branch)"

    $result = [ordered]@{
        Ru           = $Ru
        Branch       = $branchName
        Outcome      = ''
        CodeChangeOk = $true
        PrUrl        = $null
        Message      = ''
        Error        = $null
    }
    function fail([string]$msg) {
        $result.Outcome = 'fatal'; $result.Error = $msg
        return [pscustomobject]$result
    }

    # ── 1. Repo sicherstellen ────────────────────────────────────────
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath '.git'))) {
        if ($Config.cloneIfMissing -and $Config.Contains('cloneBaseUrl')) {
            $cloneUrl = "$(([string]$Config.cloneBaseUrl).TrimEnd('/'))/$Ru"
            $r = Invoke-Git -Arguments @('clone', $cloneUrl, $repoPath) -Cwd $workspaceDir -TimeoutMs $timeout
            if ($r.ExitCode -ne 0) { return (fail "clone failed: $($r.Stderr.Trim())") }
        } else {
            $result.Outcome = 'skipped'
            $result.Message = "$Ru not found locally"
            return [pscustomobject]$result
        }
    }

    # ── 2. Source-Branch aktualisieren ───────────────────────────────
    foreach ($step in @(
            @('fetch', 'origin'),
            @('checkout', $sourceBranch),
            @('reset', '--hard', "origin/$sourceBranch"),
            @('clean', '-fd')
        )) {
        $r = Invoke-Git -Arguments $step -Cwd $repoPath -TimeoutMs $timeout
        if ($r.ExitCode -ne 0) { return (fail "git $($step -join ' ') failed: $($r.Stderr.Trim())") }
    }

    # ── 3. Feature-Branch ────────────────────────────────────────────
    $r = Invoke-Git -Arguments @('checkout', '-B', $branchName) -Cwd $repoPath -TimeoutMs $timeout
    if ($r.ExitCode -ne 0) { return (fail "git checkout -B $branchName failed: $($r.Stderr.Trim())") }

    # ── 4. Code-Change ───────────────────────────────────────────────
    if (-not $Config.Contains('script')) {
        # Deklarative `operations` kommen in Phase 6.
        return (fail 'operations are not yet supported in the PowerShell port (use script:)')
    }
    $cc = Invoke-CodeChange -ScriptPath ([string]$Config.script) -Cwd $repoPath -TimeoutMs $timeout -Context @{
        Ru = $Ru; Ticket = $Config.ticket; Branch = $branchName; SourceBranch = $sourceBranch
    }
    $result.CodeChangeOk = ($cc.ExitCode -eq 0 -and -not $cc.TimedOut)

    # ── 5. Diff prüfen ───────────────────────────────────────────────
    $status = Invoke-Git -Arguments @('status', '--porcelain') -Cwd $repoPath -TimeoutMs $timeout
    if ($status.ExitCode -ne 0) { return (fail "git status failed: $($status.Stderr.Trim())") }
    $hasDiff = -not [string]::IsNullOrWhiteSpace($status.Stdout)

    if (-not $hasDiff) {
        # Kein Diff → Feature-Branch wieder entfernen, kein PR.
        Invoke-Git -Arguments @('checkout', $sourceBranch) -Cwd $repoPath -TimeoutMs $timeout | Out-Null
        Invoke-Git -Arguments @('branch', '-D', $branchName) -Cwd $repoPath -TimeoutMs $timeout | Out-Null
        $result.Outcome = 'no-changes'
        $result.Message = if ($result.CodeChangeOk) { 'no changes produced' } else { 'code change failed, no diff' }
        return [pscustomobject]$result
    }

    # ── 6. Commit ────────────────────────────────────────────────────
    $commitMsg = if ($result.CodeChangeOk) { [string]$Config.commitMessage } else { 'ERROR WHILE CODE CHANGE' }
    $add = Invoke-Git -Arguments @('add', '-A') -Cwd $repoPath -TimeoutMs $timeout -SkipHooks:$skipHooks
    if ($add.ExitCode -ne 0) { return (fail "git add failed: $($add.Stderr.Trim())") }
    $commit = Invoke-Git -Arguments @('commit', '-m', $commitMsg) -Cwd $repoPath -TimeoutMs $timeout -SkipHooks:$skipHooks
    if ($commit.ExitCode -ne 0) { return (fail "git commit failed: $($commit.Stderr.Trim())") }

    # ── 7. Push (Dry-Run überspringt) ────────────────────────────────
    if ($Config.dryRun) {
        $result.Outcome = 'committed'
        $result.Message = 'dry-run: committed, not pushed'
        return [pscustomobject]$result
    }

    # Push mit Retry + exponentiellem Backoff (inline gehalten — ein Scriptblock
    # mit GetNewClosure() würde den Modul-Scope und damit Invoke-Git verlieren).
    $maxAttempts = [int]$Config.retry.maxAttempts
    $backoffMs = [int]$Config.retry.backoffMs
    $maxBackoffMs = [int]$Config.retry.maxBackoffMs
    $pushed = $false
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $p = Invoke-Git -Arguments @('push', '-u', '--force-with-lease', 'origin', $branchName) -Cwd $repoPath -TimeoutMs $timeout
        if ($p.ExitCode -eq 0) { $pushed = $true; break }
        if ($attempt -lt $maxAttempts -and $backoffMs -gt 0) {
            $delay = [Math]::Min($backoffMs * [Math]::Pow(2, $attempt - 1), $maxBackoffMs)
            Start-Sleep -Milliseconds ([int]$delay)
        }
    }

    if (-not $pushed) {
        $result.Outcome = 'push-failed'
        $result.Error = 'git push failed after all retries'
        return [pscustomobject]$result
    }

    # ── 8. Pull Request erstellen (Phase 4 Adapter) ──────────────────
    # Bei fehlgeschlagenem Code-Change nur, wenn createPrOnError gesetzt ist.
    if (-not $result.CodeChangeOk -and -not $Config.createPrOnError) {
        $result.Outcome = 'pushed'
        $result.Message = 'pushed with code-change error (no PR — createPrOnError is false)'
        return [pscustomobject]$result
    }

    $pr = New-GitBulkPullRequest -Config $Config -Ru $Ru -SourceBranch $branchName `
        -Title ([string]$Config.prSummary) -Description ([string]$Config.prSummary)
    if ($pr.Ok) {
        $result.Outcome = 'pr-created'
        $result.PrUrl = [string]$pr.Url
        $result.Message = if ($result.CodeChangeOk) { "PR created: $($pr.Url)" } else { "PR created (code-change error): $($pr.Url)" }
    } else {
        $result.Outcome = 'pr-failed'
        $result.Error = $pr.Error
        $result.Message = 'pushed, but PR creation failed'
    }
    return [pscustomobject]$result
}

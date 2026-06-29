# GitHub-PR-Status (read-only, Pendant zu getPullRequestStatus in
# node_ts/src/git/pr-github.ts). Wirft NIE — liefert
# @{ State; Id; Url; Approvals; Ci; Error }.

# Rollt GitHub-Check-Runs des Source-Commits zu einem CI-State zusammen.
function Get-GitBulkCheckRunRollup {
    param($CheckRuns)
    $runs = @($CheckRuns)
    if ($runs.Count -eq 0) { return 'none' }
    $failing = @('failure', 'timed_out', 'cancelled', 'action_required')
    $anyRunning = $false
    $anySuccess = $false
    foreach ($r in $runs) {
        if ($r.conclusion -and ($failing -contains $r.conclusion)) { return 'failed' }
        if ($r.status -ne 'completed') { $anyRunning = $true }
        if ($r.conclusion -eq 'success') { $anySuccess = $true }
    }
    if ($anyRunning) { return 'running' }
    if ($anySuccess) { return 'passed' }
    return 'none'
}

function Get-GitHubPrStatus {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $GitHubConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [string]$Workspace = ''
    )

    $apiBase = if ($GitHubConfig.Contains('apiBaseUrl') -and $GitHubConfig.apiBaseUrl) {
        ([string]$GitHubConfig.apiBaseUrl).TrimEnd('/')
    } else { 'https://api.github.com' }
    $owner = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$GitHubConfig.owner }
    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'gitbulk'
    }

    # ── 1) PR über alle States nachschlagen ──────────────────────────
    $head = [uri]::EscapeDataString("$owner`:$SourceBranch")
    $listUrl = "$apiBase/repos/$owner/$Ru/pulls?head=$head&state=all&sort=created&direction=desc"
    $http = Invoke-GitBulkHttp -Uri $listUrl -Method Get -Headers $headers
    if ($http.Error) { return @{ State = 'none'; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -ne 200) { return @{ State = 'none'; Error = "HTTP $($http.StatusCode)" } }

    $pr = @($http.Body)[0]
    if ($null -eq $pr) { return @{ State = 'none' } }

    $state = if ($pr.state -eq 'open') { 'open' } elseif ($pr.merged_at) { 'merged' } else { 'declined' }
    $info = @{ State = $state }
    if ($null -ne $pr.number) {
        $info.Id = $pr.number
        $info.Url = if ($pr.html_url) { [string]$pr.html_url } else { "https://github.com/$owner/$Ru/pull/$($pr.number)" }

        # ── 2) Approvals (best-effort): jüngstes Review pro User zählt ──
        $reviews = Invoke-GitBulkHttp -Uri "$apiBase/repos/$owner/$Ru/pulls/$($pr.number)/reviews" -Method Get -Headers $headers
        if (-not $reviews.Error -and $reviews.StatusCode -eq 200) {
            $latest = @{}
            foreach ($rev in @($reviews.Body)) {
                if ($rev.user.login -and $rev.state) { $latest[[string]$rev.user.login] = [string]$rev.state }
            }
            $info.Approvals = @{ Approved = @($latest.Values | Where-Object { $_ -eq 'APPROVED' }).Count }
        }

        # ── 3) CI-Rollup (best-effort) über die Check-Runs ─────────────
        $sha = [string]$pr.head.sha
        if (-not [string]::IsNullOrEmpty($sha)) {
            $checks = Invoke-GitBulkHttp -Uri "$apiBase/repos/$owner/$Ru/commits/$sha/check-runs" -Method Get -Headers $headers
            if (-not $checks.Error -and $checks.StatusCode -eq 200) {
                $info.Ci = Get-GitBulkCheckRunRollup -CheckRuns $checks.Body.check_runs
            }
        }
    }

    return $info
}

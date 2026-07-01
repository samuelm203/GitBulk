# GitLab-MR-Status (read-only, Pendant zu getPullRequestStatus in
# node_ts/src/git/pr-gitlab.ts). Wirft NIE — liefert
# @{ State; Id; Url; Approvals; Ci; Error }.

# Mappt einen GitLab-Pipeline-Status auf den agnostischen CI-State.
function Get-GitLabPipelineRollup {
    param($Status)
    switch ("$Status") {
        'success' { 'passed' }
        'failed' { 'failed' }
        'canceled' { 'failed' }
        'running' { 'running' }
        'pending' { 'running' }
        'created' { 'running' }
        'preparing' { 'running' }
        'waiting_for_resource' { 'running' }
        'scheduled' { 'running' }
        default { 'none' }   # skipped / manual / unbekannt
    }
}

function Get-GitLabPrStatus {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $GitLabConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [string]$Workspace = ''
    )

    $apiBase = if ($GitLabConfig.Contains('apiBaseUrl') -and $GitLabConfig.apiBaseUrl) {
        ([string]$GitLabConfig.apiBaseUrl).TrimEnd('/')
    } else {
        'https://gitlab.com/api/v4'
    }
    $ns = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$GitLabConfig.namespace }
    $project = [uri]::EscapeDataString("$ns/$Ru")
    $headers = @{ 'PRIVATE-TOKEN' = $Token; Accept = 'application/json' }

    # ── 1) MR über alle States nachschlagen ──────────────────────────
    $listUrl = "$apiBase/projects/$project/merge_requests?source_branch=$([uri]::EscapeDataString($SourceBranch))&state=all&order_by=created_at&sort=desc"
    $http = Invoke-GitBulkHttp -Uri $listUrl -Method Get -Headers $headers
    if ($http.Error) { return @{ State = 'none'; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -ne 200) { return @{ State = 'none'; Error = "HTTP $($http.StatusCode)" } }

    $mr = @($http.Body)[0]
    if ($null -eq $mr) { return @{ State = 'none' } }

    $state = switch ("$($mr.state)") {
        'opened' { 'open' }
        'merged' { 'merged' }
        default { 'declined' }   # closed / locked / sonstiges
    }
    $info = @{ State = $state }
    if ($null -ne $mr.iid) {
        $info.Id = $mr.iid
        if ($mr.web_url) { $info.Url = [string]$mr.web_url }

        # ── 2) Approvals (best-effort) ───────────────────────────────
        $appr = Invoke-GitBulkHttp -Uri "$apiBase/projects/$project/merge_requests/$($mr.iid)/approvals" -Method Get -Headers $headers
        if (-not $appr.Error -and $appr.StatusCode -eq 200) {
            $approved = if ($appr.Body.approved_by) { @($appr.Body.approved_by).Count } else { 0 }
            $a = @{ Approved = $approved }
            if ($null -ne $appr.Body.approvals_required) { $a.Required = [int]$appr.Body.approvals_required }
            $info.Approvals = $a
        }

        # ── 3) CI-Rollup (best-effort) über die jüngste MR-Pipeline ──
        $pipe = Invoke-GitBulkHttp -Uri "$apiBase/projects/$project/merge_requests/$($mr.iid)/pipelines" -Method Get -Headers $headers
        if (-not $pipe.Error -and $pipe.StatusCode -eq 200) {
            $first = @($pipe.Body)[0]
            $info.Ci = if ($null -eq $first) { 'none' } else { Get-GitLabPipelineRollup $first.status }
        }
    }

    return $info
}

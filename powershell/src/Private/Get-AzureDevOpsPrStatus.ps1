# Azure-DevOps-PR-Status (read-only, Pendant zu getPullRequestStatus in
# node_ts/src/git/pr-azure.ts). Wirft NIE — liefert
# @{ State; Id; Url; Approvals; Ci; Error }.
# Nutzt die Helfer aus New-AzureDevOpsPullRequest.ps1 (OrgBase/Headers/PrUrl).

# Aggregiert die PR-Status-Liste zu einem CI-Rollup (fail > running > passed).
function Get-AzureDevOpsCiRollup {
    param($StatusList)
    $hasFailed = $false; $hasRunning = $false; $hasPassed = $false
    foreach ($s in @($StatusList)) {
        switch ("$($s.state)") {
            'succeeded' { $hasPassed = $true }
            'failed' { $hasFailed = $true }
            'error' { $hasFailed = $true }
            'pending' { $hasRunning = $true }
            default { }   # notApplicable / notSet / unbekannt
        }
    }
    if ($hasFailed) { return 'failed' }
    if ($hasRunning) { return 'running' }
    if ($hasPassed) { return 'passed' }
    return 'none'
}

function Get-AzureDevOpsPrStatus {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $AzureConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [string]$Workspace = ''
    )

    $orgBase = Get-AzureDevOpsOrgBase -AzureConfig $AzureConfig
    $project = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$AzureConfig.project }
    $headers = Get-AzureDevOpsAuthHeader -Token $Token
    $prsUrl = "$orgBase/$([uri]::EscapeDataString($project))/_apis/git/repositories/$([uri]::EscapeDataString($Ru))/pullrequests"

    # ── 1) PR über alle States nachschlagen ──────────────────────────
    $srcRef = [uri]::EscapeDataString("refs/heads/$SourceBranch")
    $listUrl = "${prsUrl}?searchCriteria.sourceRefName=$srcRef&searchCriteria.status=all&api-version=7.1"
    $http = Invoke-GitBulkHttp -Uri $listUrl -Method Get -Headers $headers
    if ($http.Error) { return @{ State = 'none'; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -ne 200) { return @{ State = 'none'; Error = "HTTP $($http.StatusCode)" } }

    $pr = @($http.Body.value)[0]
    if ($null -eq $pr) { return @{ State = 'none' } }

    $state = switch ("$($pr.status)") {
        'active' { 'open' }
        'completed' { 'merged' }
        default { 'declined' }   # abandoned / notSet / sonstiges
    }
    $info = @{ State = $state }
    if ($null -ne $pr.pullRequestId) {
        $info.Id = $pr.pullRequestId
        $info.Url = Get-AzureDevOpsPrUrl -OrgBase $orgBase -Project $project -Ru $Ru -Id $pr.pullRequestId

        # ── 2) Approvals aus den eingebetteten Reviewer-Votes ────────
        # Votes: 10 = approved, 5 = approved with suggestions, 0 = kein Vote,
        # -5 = waiting for author, -10 = rejected → ab vote >= 5 zählt es.
        # Required = Anzahl der als "required" markierten Reviewer (best-effort).
        if ($null -ne $pr.reviewers) {
            $approved = 0; $required = 0
            foreach ($r in @($pr.reviewers)) {
                if ($null -ne $r.vote -and [int]$r.vote -ge 5) { $approved++ }
                if ($r.isRequired -eq $true) { $required++ }
            }
            $a = @{ Approved = $approved }
            if ($required -gt 0) { $a.Required = $required }
            $info.Approvals = $a
        }

        # ── 3) CI-Rollup (best-effort) über die PR-Statuses ──────────
        $st = Invoke-GitBulkHttp -Uri "$prsUrl/$($pr.pullRequestId)/statuses?api-version=7.1" -Method Get -Headers $headers
        if (-not $st.Error -and $st.StatusCode -eq 200) {
            $list = @($st.Body.value)
            $info.Ci = if ($list.Count -eq 0) { 'none' } else { Get-AzureDevOpsCiRollup $list }
        }
    }

    return $info
}

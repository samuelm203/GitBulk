# Bitbucket-PR-Status (read-only, Pendant zu getPullRequestStatus in
# node_ts/src/git/pr-bitbucket.ts). Schlägt den PR zum Source-Branch über ALLE
# States nach und ergänzt best-effort Approvals + CI-Rollup. Wirft NIE — liefert
# @{ State; Id; Url; Approvals; Ci; Error }.

# Mappt Bitbuckets PR-state (Cloud & Server, Großschreibung) auf den agnostischen State.
function ConvertTo-GitBulkBitbucketState {
    param($Raw)
    switch ("$Raw".ToUpperInvariant()) {
        'OPEN' { 'open' }
        'MERGED' { 'merged' }
        default { 'declined' }   # DECLINED / SUPERSEDED / sonstiges Geschlossene
    }
}

# Rollt Bitbucket-Build-/Commit-Stati zu einem CI-State zusammen
# (Cloud /statuses und Server build-status nutzen dieselben State-Strings).
function Get-GitBulkBuildRollup {
    param([string[]]$States)
    if ($States.Count -eq 0) { return 'none' }
    if ($States -contains 'FAILED' -or $States -contains 'STOPPED') { return 'failed' }
    if ($States -contains 'INPROGRESS') { return 'running' }
    if ($States -contains 'SUCCESSFUL') { return 'passed' }
    return 'none'
}

function Get-BitbucketPrStatus {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $BitbucketConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [string]$Workspace = ''
    )

    $cloud = ([string]$BitbucketConfig.apiVariant) -ne 'server'
    $hasBaseUrl = $BitbucketConfig.Contains('apiBaseUrl') -and $BitbucketConfig.apiBaseUrl
    if (-not $cloud -and -not $hasBaseUrl) {
        return @{ State = 'none'; Error = 'Bitbucket Server mode (apiVariant: server) requires apiBaseUrl' }
    }
    $apiBase = if ($hasBaseUrl) { ([string]$BitbucketConfig.apiBaseUrl).TrimEnd('/') } else { 'https://api.bitbucket.org/2.0' }
    $ws = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$BitbucketConfig.workspace }

    $authHeader = if ($Token.Contains(':')) {
        'Basic ' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Token))
    } else { "Bearer $Token" }
    $headers = @{ Authorization = $authHeader; Accept = 'application/json' }

    # ── 1) PR über alle States nachschlagen ──────────────────────────
    if ($cloud) {
        $q = [uri]::EscapeDataString("source.branch.name=`"$SourceBranch`"")
        $listUrl = "$apiBase/repositories/$ws/$Ru/pullrequests?q=$q&sort=-created_on"
    } else {
        $at = [uri]::EscapeDataString("refs/heads/$SourceBranch")
        $listUrl = "$apiBase/rest/api/1.0/projects/$ws/repos/$Ru/pull-requests?state=ALL&at=$at&direction=OUTGOING"
    }
    $http = Invoke-GitBulkHttp -Uri $listUrl -Method Get -Headers $headers
    if ($http.Error) { return @{ State = 'none'; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -ne 200) { return @{ State = 'none'; Error = "HTTP $($http.StatusCode)" } }

    $first = @($http.Body.values)[0]
    if ($null -eq $first) { return @{ State = 'none' } }

    $info = @{ State = ConvertTo-GitBulkBitbucketState $first.state }
    if ($null -ne $first.id) { $info.Id = $first.id }
    if ($cloud) {
        $prUrl = if ($first.links.html.href) { [string]$first.links.html.href }
        elseif ($null -ne $first.id) { "https://bitbucket.org/$ws/$Ru/pull-requests/$($first.id)" } else { $null }
    } else {
        $prUrl = if ($first.links.self -and $first.links.self[0].href) { [string]$first.links.self[0].href } else { $null }
    }
    if ($prUrl) { $info.Url = $prUrl }

    # ── 2) Approvals (best-effort) ───────────────────────────────────
    $approvals = $null
    if ($cloud -and $null -ne $first.id) {
        $detail = Invoke-GitBulkHttp -Uri "$apiBase/repositories/$ws/$Ru/pullrequests/$($first.id)" -Method Get -Headers $headers
        if (-not $detail.Error -and $detail.StatusCode -eq 200 -and $detail.Body.participants) {
            $approved = @($detail.Body.participants | Where-Object { $_.approved -eq $true }).Count
            $required = @($detail.Body.participants | Where-Object { $_.role -eq 'REVIEWER' }).Count
            $approvals = @{ Approved = $approved }
            if ($required -gt 0) { $approvals.Required = $required }
        }
    } elseif (-not $cloud -and $first.reviewers) {
        $approved = @($first.reviewers | Where-Object { $_.approved -eq $true }).Count
        $approvals = @{ Approved = $approved; Required = @($first.reviewers).Count }
    }
    if ($approvals) { $info.Approvals = $approvals }

    # ── 3) CI-Rollup (best-effort) ───────────────────────────────────
    $sha = if ($cloud) { [string]$first.source.commit.hash } else { [string]$first.fromRef.latestCommit }
    if (-not [string]::IsNullOrEmpty($sha)) {
        $ciUrl = if ($cloud) { "$apiBase/repositories/$ws/$Ru/commit/$sha/statuses" } else { "$apiBase/rest/build-status/1.0/commits/$sha" }
        $ci = Invoke-GitBulkHttp -Uri $ciUrl -Method Get -Headers $headers
        if (-not $ci.Error -and $ci.StatusCode -eq 200) {
            $states = @(@($ci.Body.values) | ForEach-Object { "$($_.state)" })
            $info.Ci = Get-GitBulkBuildRollup -States $states
        }
    }

    return $info
}

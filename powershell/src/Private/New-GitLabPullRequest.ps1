# GitLab-Adapter für Merge Requests (Pendant zu node_ts/src/git/pr-gitlab.ts).
# Result-Style: wirft NIE — liefert @{ Ok; Id; Url; StatusCode; Error }.
# Auth via PRIVATE-TOKEN-Header (GITBULK_GITLAB_TOKEN, vom Dispatcher gereicht).
# Projekt = <namespace>/<repo> (URL-encoded); Per-RU-Workspace überschreibt namespace.

function New-GitLabPullRequest {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $GitLabConfig,   # config.gitlab (namespace/targetBranch/reviewers/apiBaseUrl)
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Description = '',

        # Per-RU-Namespace-Override (Vorrang vor GitLabConfig.namespace).
        [string]$Workspace = ''
    )

    $apiBase = if ($GitLabConfig.Contains('apiBaseUrl') -and $GitLabConfig.apiBaseUrl) {
        ([string]$GitLabConfig.apiBaseUrl).TrimEnd('/')
    } else {
        'https://gitlab.com/api/v4'
    }
    $ns = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$GitLabConfig.namespace }
    $targetBranch = [string]$GitLabConfig.targetBranch
    $project = [uri]::EscapeDataString("$ns/$Ru")
    $headers = @{ 'PRIVATE-TOKEN' = $Token; Accept = 'application/json' }

    $body = @{ source_branch = $SourceBranch; target_branch = $targetBranch; title = $Title }
    if ($Description) { $body.description = $Description }
    # GitLab erwartet numerische Reviewer-User-IDs; nicht-numerische werden übersprungen.
    $reviewerIds = @($GitLabConfig.reviewers | ForEach-Object {
            $n = 0
            if ([int]::TryParse([string]$_, [ref]$n) -and $n -gt 0) { $n }
        })
    if ($reviewerIds.Count -gt 0) { $body.reviewer_ids = $reviewerIds }

    $url = "$apiBase/projects/$project/merge_requests"
    $http = Invoke-GitBulkHttp -Uri $url -Method Post -Headers $headers -Body $body
    if ($http.Error) {
        return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = "network error: $($http.Error)" }
    }
    $status = $http.StatusCode
    $resp = $http.Body

    if ($status -eq 200 -or $status -eq 201) {
        $iid = if ($null -ne $resp.iid) { $resp.iid } else { 'unknown' }
        $prUrl = if ($resp.web_url) { [string]$resp.web_url } else { '' }
        return @{ Ok = $true; Id = $iid; Url = $prUrl; StatusCode = $status; Error = $null }
    }

    # Re-Run: GitLab lehnt einen Duplikat-MR mit 409 ab → bestehenden offenen MR
    # nachschlagen und als Erfolg melden (kein zweiter MR).
    if ($status -eq 409) {
        $existing = Get-GitLabOpenMr -ApiBase $apiBase -Project $project -Headers $headers -SourceBranch $SourceBranch
        if ($existing) {
            return @{ Ok = $true; Id = $existing.Id; Url = $existing.Url; StatusCode = 200; Error = $null }
        }
    }

    $msg = "HTTP $status"
    if ($resp.message) {
        $m = $resp.message
        $text = if ($m -is [System.Collections.IEnumerable] -and $m -isnot [string]) { ($m -join '; ') } else { [string]$m }
        $msg = "HTTP $status`: $text"
    }
    return @{ Ok = $false; Id = $null; Url = ''; StatusCode = $status; Error = $msg }
}

# Sucht den bereits offenen MR zum Source-Branch (best-effort).
function Get-GitLabOpenMr {
    param(
        [string]$ApiBase,
        [string]$Project,
        [hashtable]$Headers,
        [string]$SourceBranch
    )
    $url = "$ApiBase/projects/$Project/merge_requests?source_branch=$([uri]::EscapeDataString($SourceBranch))&state=opened"
    $http = Invoke-GitBulkHttp -Uri $url -Method Get -Headers $Headers
    if ($http.Error -or $http.StatusCode -ne 200) { return $null }
    $mr = @($http.Body)[0]
    if ($null -eq $mr -or $null -eq $mr.iid) { return $null }
    return @{ Id = $mr.iid; Url = if ($mr.web_url) { [string]$mr.web_url } else { '' } }
}

# Schließt einen offenen MR (gitbulk -Close). PUT /merge_requests/{iid} state_event=close.
# Result-Style: @{ Ok; StatusCode; Error }.
function Close-GitLabPullRequest {
    param(
        [Parameter(Mandatory)] $GitLabConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)] $Id,
        [string]$Workspace = ''
    )
    $apiBase = if ($GitLabConfig.Contains('apiBaseUrl') -and $GitLabConfig.apiBaseUrl) {
        ([string]$GitLabConfig.apiBaseUrl).TrimEnd('/')
    } else { 'https://gitlab.com/api/v4' }
    $ns = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$GitLabConfig.namespace }
    $project = [uri]::EscapeDataString("$ns/$Ru")
    $headers = @{ 'PRIVATE-TOKEN' = $Token; Accept = 'application/json' }
    $url = "$apiBase/projects/$project/merge_requests/$Id"
    $http = Invoke-GitBulkHttp -Uri $url -Method Put -Headers $headers -Body @{ state_event = 'close' }
    if ($http.Error) { return @{ Ok = $false; StatusCode = 0; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -eq 200) { return @{ Ok = $true; StatusCode = 200; Error = $null } }
    return @{ Ok = $false; StatusCode = $http.StatusCode; Error = "HTTP $($http.StatusCode)" }
}

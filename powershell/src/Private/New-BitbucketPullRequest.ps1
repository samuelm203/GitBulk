# Bitbucket-PR-Adapter (Pendant zu node_ts/src/git/pr-bitbucket.ts).
# Unterstützt Cloud (api.bitbucket.org/2.0) und Server/Data Center (/rest/api/1.0).
# Result-Style: wirft NIE — liefert @{ Ok; Id; Url; StatusCode; Error }.
# Auth: Bearer-Token; enthält der Token ein ':', wird Basic-Auth genutzt (App-Passwort).

function New-BitbucketPullRequest {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $BitbucketConfig,   # config.bitbucket (workspace/apiVariant/targetBranch/reviewers/apiBaseUrl)
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Description = ''
    )

    $cloud = ([string]$BitbucketConfig.apiVariant) -ne 'server'
    $defaultBase = 'https://api.bitbucket.org/2.0'
    $apiBase = if ($BitbucketConfig.Contains('apiBaseUrl') -and $BitbucketConfig.apiBaseUrl) {
        ([string]$BitbucketConfig.apiBaseUrl).TrimEnd('/')
    } else {
        $defaultBase
    }
    $workspace = [string]$BitbucketConfig.workspace
    $targetBranch = [string]$BitbucketConfig.targetBranch
    $reviewers = @($BitbucketConfig.reviewers)

    # Authorization-Header: App-Passwörter (user:pass) → Basic, sonst Bearer.
    $authHeader = if ($Token.Contains(':')) {
        'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Token))
    } else {
        "Bearer $Token"
    }
    $headers = @{ Authorization = $authHeader; Accept = 'application/json' }

    if ($cloud) {
        $url = "$apiBase/repositories/$workspace/$Ru/pullrequests"
        $body = @{
            title       = $Title
            source      = @{ branch = @{ name = $SourceBranch } }
            destination = @{ branch = @{ name = $targetBranch } }
        }
        if ($Description) { $body.description = $Description }
        if ($reviewers.Count -gt 0) {
            $body.reviewers = @($reviewers | ForEach-Object {
                    if ($_.StartsWith('{') -and $_.EndsWith('}')) { @{ uuid = $_ } } else { @{ account_id = $_ } }
                })
        }
    } else {
        $url = "$apiBase/rest/api/1.0/projects/$workspace/repos/$Ru/pull-requests"
        $body = @{
            title   = $Title
            fromRef = @{ id = "refs/heads/$SourceBranch" }
            toRef   = @{ id = "refs/heads/$targetBranch" }
        }
        if ($Description) { $body.description = $Description }
        if ($reviewers.Count -gt 0) {
            $body.reviewers = @($reviewers | ForEach-Object { @{ user = @{ name = $_ } } })
        }
    }

    $http = Invoke-GitBulkHttp -Uri $url -Method Post -Headers $headers -Body $body
    if ($http.Error) {
        return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = "network error: $($http.Error)" }
    }
    $status = $http.StatusCode
    $resp = $http.Body

    if ($status -eq 200 -or $status -eq 201) {
        $id = if ($null -ne $resp.id) { $resp.id } else { 'unknown' }
        $prUrl = ''
        if ($cloud) {
            if ($resp.links -and $resp.links.html -and $resp.links.html.href) { $prUrl = [string]$resp.links.html.href }
            else { $prUrl = "https://bitbucket.org/$workspace/$Ru/pull-requests/$id" }
        } else {
            if ($resp.links -and $resp.links.self -and $resp.links.self[0].href) { $prUrl = [string]$resp.links.self[0].href }
        }
        return @{ Ok = $true; Id = $id; Url = $prUrl; StatusCode = $status; Error = $null }
    }

    $msg = "HTTP $status"
    if ($cloud -and $resp.error -and $resp.error.message) { $msg = "HTTP $status`: $($resp.error.message)" }
    elseif ((-not $cloud) -and $resp.errors -and $resp.errors[0].message) { $msg = "HTTP $status`: $($resp.errors[0].message)" }
    return @{ Ok = $false; Id = $null; Url = ''; StatusCode = $status; Error = $msg }
}

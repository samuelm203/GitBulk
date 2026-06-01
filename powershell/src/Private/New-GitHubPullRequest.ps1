# GitHub-PR-Adapter (Pendant zu node_ts/src/git/pr-github.ts).
# Result-Style: wirft NIE — liefert @{ Ok; Id; Url; StatusCode; Error }.
# Auth via Bearer-Token (GITBULK_GITHUB_TOKEN, vom Dispatcher gereicht).

function New-GitHubPullRequest {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $GitHubConfig,   # config.github (owner/targetBranch/reviewers/apiBaseUrl)
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Description = ''
    )

    $apiBase = if ($GitHubConfig.Contains('apiBaseUrl') -and $GitHubConfig.apiBaseUrl) {
        ([string]$GitHubConfig.apiBaseUrl).TrimEnd('/')
    } else {
        'https://api.github.com'
    }
    $owner = [string]$GitHubConfig.owner
    $targetBranch = [string]$GitHubConfig.targetBranch
    $url = "$apiBase/repos/$owner/$Ru/pulls"

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'gitbulk'
    }
    $body = @{ title = $Title; head = $SourceBranch; base = $targetBranch }
    if ($Description) { $body.body = $Description }

    $http = Invoke-GitBulkHttp -Uri $url -Method Post -Headers $headers -Body $body
    if ($http.Error) {
        return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = "network error: $($http.Error)" }
    }
    $status = $http.StatusCode
    $resp = $http.Body

    if ($status -eq 201 -or $status -eq 200) {
        $prNumber = $resp.number
        $prUrl = if ($resp.html_url) { [string]$resp.html_url } else { "https://github.com/$owner/$Ru/pull/$prNumber" }

        # Reviewer best-effort — ein Fehler hier macht den PR NICHT ungültig.
        $reviewers = @($GitHubConfig.reviewers)
        if ($reviewers.Count -gt 0 -and $prNumber) {
            $rev = Invoke-GitBulkHttp -Uri "$apiBase/repos/$owner/$Ru/pulls/$prNumber/requested_reviewers" `
                -Method Post -Headers $headers -Body @{ reviewers = $reviewers }
            if ($rev.Error -or $rev.StatusCode -ge 300) {
                Write-Verbose "request reviewers failed (HTTP $($rev.StatusCode))"
            }
        }

        return @{ Ok = $true; Id = $prNumber; Url = $prUrl; StatusCode = $status; Error = $null }
    }

    $msg = if ($resp.message) { [string]$resp.message } else { "HTTP $status" }
    return @{ Ok = $false; Id = $null; Url = ''; StatusCode = $status; Error = "HTTP $status`: $msg" }
}

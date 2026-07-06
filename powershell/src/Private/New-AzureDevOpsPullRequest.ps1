# Azure-DevOps-Adapter für Pull Requests (Pendant zu node_ts/src/git/pr-azure.ts).
# Result-Style: wirft NIE — liefert @{ Ok; Id; Url; StatusCode; Error }.
# Auth: PAT als HTTP-Basic mit leerem Benutzernamen (base64(":"+PAT)),
# Env-Variable GITBULK_AZURE_DEVOPS_TOKEN (vom Dispatcher gereicht).
# API-Basis = {apiBaseUrl}/{organization} (Default https://dev.azure.com). Für
# on-prem zeigt apiBaseUrl auf die Instanz-Wurzel OHNE Collection (z. B.
# https://tfs.example.com/tfs), die Collection kommt in organization.
# Repo = <organization>/<project>/<repo>; Per-RU-Workspace überschreibt project.

# API-Basis inkl. Organisation (Default-Wurzel: dev.azure.com).
function Get-AzureDevOpsOrgBase {
    param([Parameter(Mandatory)] $AzureConfig)
    $root = if ($AzureConfig.Contains('apiBaseUrl') -and $AzureConfig.apiBaseUrl) {
        ([string]$AzureConfig.apiBaseUrl).TrimEnd('/')
    } else {
        'https://dev.azure.com'
    }
    return "$root/$([uri]::EscapeDataString([string]$AzureConfig.organization))"
}

# Gemeinsame Header: PAT als HTTP-Basic mit leerem Benutzernamen.
function Get-AzureDevOpsAuthHeader {
    param([Parameter(Mandatory)][string]$Token)
    $basic = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(":$Token"))
    return @{ Authorization = "Basic $basic"; Accept = 'application/json' }
}

# Web-Link zum PR (deterministisch aus orgBase/project/repo/id gebaut).
function Get-AzureDevOpsPrUrl {
    param([string]$OrgBase, [string]$Project, [string]$Ru, $Id)
    return "$OrgBase/$([uri]::EscapeDataString($Project))/_git/$([uri]::EscapeDataString($Ru))/pullrequest/$Id"
}

function New-AzureDevOpsPullRequest {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $AzureConfig,   # config.azureDevOps (organization/project/targetBranch/reviewers/apiBaseUrl)
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Description = '',

        # Per-RU-Project-Override (Vorrang vor AzureConfig.project).
        [string]$Workspace = ''
    )

    $orgBase = Get-AzureDevOpsOrgBase -AzureConfig $AzureConfig
    $project = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$AzureConfig.project }
    $targetBranch = [string]$AzureConfig.targetBranch
    $headers = Get-AzureDevOpsAuthHeader -Token $Token
    $prsUrl = "$orgBase/$([uri]::EscapeDataString($project))/_apis/git/repositories/$([uri]::EscapeDataString($Ru))/pullrequests"

    $body = @{
        sourceRefName = "refs/heads/$SourceBranch"
        targetRefName = "refs/heads/$targetBranch"
        title         = $Title
    }
    if ($Description) { $body.description = $Description }
    # Azure erwartet Reviewer als { id = <GUID/Descriptor> }; Strings werden
    # unverändert durchgereicht (keine numerische Konvertierung wie bei GitLab).
    $reviewerObjs = @($AzureConfig.reviewers | Where-Object { $_ } | ForEach-Object { @{ id = [string]$_ } })
    if ($reviewerObjs.Count -gt 0) { $body.reviewers = $reviewerObjs }

    $http = Invoke-GitBulkHttp -Uri "${prsUrl}?api-version=7.1" -Method Post -Headers $headers -Body $body
    if ($http.Error) {
        return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = "network error: $($http.Error)" }
    }
    $status = $http.StatusCode
    $resp = $http.Body

    if ($status -eq 200 -or $status -eq 201) {
        $id = if ($null -ne $resp.pullRequestId) { $resp.pullRequestId } else { 'unknown' }
        $prUrl = if ($null -ne $resp.pullRequestId) { Get-AzureDevOpsPrUrl -OrgBase $orgBase -Project $project -Ru $Ru -Id $id } else { '' }
        return @{ Ok = $true; Id = $id; Url = $prUrl; StatusCode = $status; Error = $null }
    }

    # Re-Run: Azure lehnt einen Duplikat-PR mit 409 (TF401179) ab → aktiven PR
    # zu Source+Target nachschlagen und als Erfolg melden (kein zweiter PR).
    if ($status -eq 409) {
        $srcRef = [uri]::EscapeDataString("refs/heads/$SourceBranch")
        $tgtRef = [uri]::EscapeDataString("refs/heads/$targetBranch")
        $findUrl = "${prsUrl}?searchCriteria.sourceRefName=$srcRef&searchCriteria.targetRefName=$tgtRef&searchCriteria.status=active&api-version=7.1"
        $find = Invoke-GitBulkHttp -Uri $findUrl -Method Get -Headers $headers
        if (-not $find.Error -and $find.StatusCode -eq 200) {
            $existing = @($find.Body.value)[0]
            if ($null -ne $existing -and $null -ne $existing.pullRequestId) {
                $exUrl = Get-AzureDevOpsPrUrl -OrgBase $orgBase -Project $project -Ru $Ru -Id $existing.pullRequestId
                return @{ Ok = $true; Id = $existing.pullRequestId; Url = $exUrl; StatusCode = 200; Error = $null }
            }
        }
    }

    $msg = "HTTP $status"
    if ($resp.message) { $msg = "HTTP $status`: $($resp.message)" }
    return @{ Ok = $false; Id = $null; Url = ''; StatusCode = $status; Error = $msg }
}

# Schließt einen offenen PR (gitbulk -Close → Azure: "abandoned").
# PATCH /pullrequests/{id}?api-version=7.1 status=abandoned.
function Close-AzureDevOpsPullRequest {
    param(
        [Parameter(Mandatory)] $AzureConfig,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)] $Id,
        [string]$Workspace = ''
    )
    $orgBase = Get-AzureDevOpsOrgBase -AzureConfig $AzureConfig
    $project = if (-not [string]::IsNullOrEmpty($Workspace)) { $Workspace } else { [string]$AzureConfig.project }
    $headers = Get-AzureDevOpsAuthHeader -Token $Token
    $url = "$orgBase/$([uri]::EscapeDataString($project))/_apis/git/repositories/$([uri]::EscapeDataString($Ru))/pullrequests/${Id}?api-version=7.1"
    $http = Invoke-GitBulkHttp -Uri $url -Method Patch -Headers $headers -Body @{ status = 'abandoned' }
    if ($http.Error) { return @{ Ok = $false; StatusCode = 0; Error = "network error: $($http.Error)" } }
    if ($http.StatusCode -eq 200) { return @{ Ok = $true; StatusCode = 200; Error = $null } }
    return @{ Ok = $false; StatusCode = $http.StatusCode; Error = "HTTP $($http.StatusCode)" }
}

# PR-Status-Dispatcher (read-only, Pendant zum Status-Teil von pr-adapter.ts).
# Wählt anhand config.prPlatform die passende Status-Funktion, liest den Token NUR
# aus der Umgebung und liefert deren @{ State; Id; Url; Approvals; Ci; Error }.
# Wirft NIE.

function Get-GitBulkPrStatus {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [string]$Workspace = ''
    )

    switch ([string]$Config.prPlatform) {
        'github' {
            if (-not $Config.Contains('github')) { return @{ State = 'none'; Error = 'github config is missing' } }
            $token = $env:GITBULK_GITHUB_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ State = 'none'; Error = 'Environment variable GITBULK_GITHUB_TOKEN is required for GitHub PR status' }
            }
            return Get-GitHubPrStatus -GitHubConfig $Config.github -Token $token -Ru $Ru -SourceBranch $SourceBranch -Workspace $Workspace
        }
        'bitbucket' {
            if (-not $Config.Contains('bitbucket')) { return @{ State = 'none'; Error = 'bitbucket config is missing' } }
            $token = $env:GITBULK_BITBUCKET_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ State = 'none'; Error = 'Environment variable GITBULK_BITBUCKET_TOKEN is required for Bitbucket PR status' }
            }
            return Get-BitbucketPrStatus -BitbucketConfig $Config.bitbucket -Token $token -Ru $Ru -SourceBranch $SourceBranch -Workspace $Workspace
        }
        'gitlab' {
            if (-not $Config.Contains('gitlab')) { return @{ State = 'none'; Error = 'gitlab config is missing' } }
            $token = $env:GITBULK_GITLAB_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ State = 'none'; Error = 'Environment variable GITBULK_GITLAB_TOKEN is required for GitLab MR status' }
            }
            return Get-GitLabPrStatus -GitLabConfig $Config.gitlab -Token $token -Ru $Ru -SourceBranch $SourceBranch -Workspace $Workspace
        }
        'azure-devops' {
            if (-not $Config.Contains('azureDevOps')) { return @{ State = 'none'; Error = 'azureDevOps config is missing' } }
            $token = $env:GITBULK_AZURE_DEVOPS_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ State = 'none'; Error = 'Environment variable GITBULK_AZURE_DEVOPS_TOKEN is required for Azure DevOps PR status' }
            }
            return Get-AzureDevOpsPrStatus -AzureConfig $Config.azureDevOps -Token $token -Ru $Ru -SourceBranch $SourceBranch -Workspace $Workspace
        }
        default {
            return @{ State = 'none'; Error = "status not supported for prPlatform '$($Config.prPlatform)'" }
        }
    }
}

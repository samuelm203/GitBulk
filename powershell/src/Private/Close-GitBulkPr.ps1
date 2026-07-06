# Close-Dispatcher (Pendant zum closePullRequest-Teil von pr-adapter.ts).
# Wählt anhand config.prPlatform die passende Close-Funktion, liest den Token
# NUR aus der Umgebung und liefert @{ Ok; StatusCode; Error }. Wirft NIE.

function Close-GitBulkPr {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)] $Id,
        [string]$Workspace = ''
    )

    switch ([string]$Config.prPlatform) {
        'github' {
            $token = $env:GITBULK_GITHUB_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; StatusCode = 0; Error = 'Environment variable GITBULK_GITHUB_TOKEN is required' }
            }
            return Close-GitHubPullRequest -GitHubConfig $Config.github -Token $token -Ru $Ru -Id $Id -Workspace $Workspace
        }
        'bitbucket' {
            $token = $env:GITBULK_BITBUCKET_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; StatusCode = 0; Error = 'Environment variable GITBULK_BITBUCKET_TOKEN is required' }
            }
            return Close-BitbucketPullRequest -BitbucketConfig $Config.bitbucket -Token $token -Ru $Ru -Id $Id -Workspace $Workspace
        }
        'gitlab' {
            $token = $env:GITBULK_GITLAB_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; StatusCode = 0; Error = 'Environment variable GITBULK_GITLAB_TOKEN is required' }
            }
            return Close-GitLabPullRequest -GitLabConfig $Config.gitlab -Token $token -Ru $Ru -Id $Id -Workspace $Workspace
        }
        'azure-devops' {
            $token = $env:GITBULK_AZURE_DEVOPS_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; StatusCode = 0; Error = 'Environment variable GITBULK_AZURE_DEVOPS_TOKEN is required' }
            }
            return Close-AzureDevOpsPullRequest -AzureConfig $Config.azureDevOps -Token $token -Ru $Ru -Id $Id -Workspace $Workspace
        }
        default {
            return @{ Ok = $false; StatusCode = 0; Error = "close not supported for prPlatform '$($Config.prPlatform)'" }
        }
    }
}

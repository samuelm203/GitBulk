# PR-Adapter-Dispatcher (Pendant zur Factory createPrAdapter in pr-adapter.ts).
# Wählt anhand config.prPlatform den passenden Adapter, liest den Token NUR aus
# der Umgebung (nie aus der Config) und liefert dessen Result-Objekt zurück.
# Wirft NIE — fehlende Tokens/Plattformen werden als @{ Ok=$false; Error=... } gemeldet.

function New-GitBulkPullRequest {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][string]$Ru,
        [Parameter(Mandatory)][string]$SourceBranch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Description = ''
    )

    switch ([string]$Config.prPlatform) {
        'github' {
            if (-not $Config.Contains('github')) {
                return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = 'github config is missing' }
            }
            $token = $env:GITBULK_GITHUB_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0
                    Error = 'Environment variable GITBULK_GITHUB_TOKEN is required for GitHub PR creation'
                }
            }
            return New-GitHubPullRequest -GitHubConfig $Config.github -Token $token `
                -Ru $Ru -SourceBranch $SourceBranch -Title $Title -Description $Description
        }
        'bitbucket' {
            if (-not $Config.Contains('bitbucket')) {
                return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0; Error = 'bitbucket config is missing' }
            }
            $token = $env:GITBULK_BITBUCKET_TOKEN
            if ([string]::IsNullOrWhiteSpace($token)) {
                return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0
                    Error = 'Environment variable GITBULK_BITBUCKET_TOKEN is required for Bitbucket PR creation'
                }
            }
            return New-BitbucketPullRequest -BitbucketConfig $Config.bitbucket -Token $token `
                -Ru $Ru -SourceBranch $SourceBranch -Title $Title -Description $Description
        }
        'azure-devops' {
            return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0
                Error = 'Azure DevOps adapter is not yet implemented'
            }
        }
        default {
            return @{ Ok = $false; Id = $null; Url = ''; StatusCode = 0
                Error = "unsupported prPlatform '$($Config.prPlatform)'"
            }
        }
    }
}

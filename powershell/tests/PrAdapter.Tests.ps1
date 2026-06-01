#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für die PR-Adapter (InModuleScope, private Funktionen). Statt echter
# HTTP-Calls wird der dünne Wrapper Invoke-GitBulkHttp gemockt.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

InModuleScope GitBulk {
    Describe 'New-GitHubPullRequest' {
        It 'posts to /repos/{owner}/{repo}/pulls and returns id + url' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ number = 7; html_url = 'https://github.com/o/r/pull/7' }; Error = $null } }

            $cfg = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
            $r = New-GitHubPullRequest -GitHubConfig $cfg -Token 'tok' -Ru 'r' -SourceBranch 'feat' -Title 'T' -Description 'd'

            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 7
            $r.Url | Should -Be 'https://github.com/o/r/pull/7'
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://api.github.com/repos/o/r/pulls' -and $Method -eq 'Post' -and
                $Body.head -eq 'feat' -and $Body.base -eq 'main' -and $Body.title -eq 'T'
            }
        }

        It 'returns a failure result with the API message on 422' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 422; Body = [pscustomobject]@{ message = 'Validation Failed' }; Error = $null } }
            $r = New-GitHubPullRequest -GitHubConfig @{ owner = 'o'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.StatusCode | Should -Be 422
            $r.Error | Should -Match 'Validation Failed'
        }

        It 'returns a network-error result when the http wrapper reports an error' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 0; Body = $null; Error = 'connection refused' } }
            $r = New-GitHubPullRequest -GitHubConfig @{ owner = 'o'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.StatusCode | Should -Be 0
            $r.Error | Should -Match 'network error'
        }

        It 'requests reviewers in a second call without failing the PR' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/requested_reviewers' } { @{ StatusCode = 422; Body = $null; Error = $null } }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls' } { @{ StatusCode = 201; Body = [pscustomobject]@{ number = 9; html_url = 'u' }; Error = $null } }

            $cfg = @{ owner = 'o'; targetBranch = 'main'; reviewers = @('octocat') }
            $r = New-GitHubPullRequest -GitHubConfig $cfg -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'

            $r.Ok | Should -BeTrue   # PR-Erstellung erfolgreich, Reviewer-Fehler ignoriert
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter { $Uri -eq 'https://api.github.com/repos/o/r/pulls/9/requested_reviewers' }
        }
    }

    Describe 'New-BitbucketPullRequest' {
        It 'posts the Cloud payload (source.branch.name) and returns id + url' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ id = 42; links = [pscustomobject]@{ html = [pscustomobject]@{ href = 'https://bb/pr/42' } } }; Error = $null } }

            $cfg = @{ workspace = 'ws'; apiVariant = 'cloud'; targetBranch = 'master'; reviewers = @() }
            $r = New-BitbucketPullRequest -BitbucketConfig $cfg -Token 'tok' -Ru 'r' -SourceBranch 'feat' -Title 'T'

            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 42
            $r.Url | Should -Be 'https://bb/pr/42'
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests' -and
                $Body.source.branch.name -eq 'feat' -and $Body.destination.branch.name -eq 'master'
            }
        }

        It 'uses the Server API path and payload for apiVariant server' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ id = 5; links = [pscustomobject]@{ self = @([pscustomobject]@{ href = 'https://bb.example.com/pr/5' }) } }; Error = $null } }

            $cfg = @{ workspace = 'PROJ'; apiVariant = 'server'; apiBaseUrl = 'https://bb.example.com'; targetBranch = 'main'; reviewers = @() }
            $r = New-BitbucketPullRequest -BitbucketConfig $cfg -Token 'tok' -Ru 'repo' -SourceBranch 'feat' -Title 'T'

            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://bb.example.com/rest/api/1.0/projects/PROJ/repos/repo/pull-requests' -and
                $Body.fromRef.id -eq 'refs/heads/feat' -and $Body.toRef.id -eq 'refs/heads/main'
            }
        }
    }

    Describe 'New-GitBulkPullRequest (dispatcher)' {
        AfterEach {
            Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue
        }

        It 'dispatches to GitHub and reads the token from the environment' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ number = 1; html_url = 'u' }; Error = $null } }
            $env:GITBULK_GITHUB_TOKEN = 'ghtok'
            $cfg = @{ prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() } }

            $r = New-GitBulkPullRequest -Config $cfg -Ru 'r' -SourceBranch 'feat' -Title 'T'
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1
        }

        It 'returns an error when the token env var is missing' {
            Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue
            $cfg = @{ prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() } }

            $r = New-GitBulkPullRequest -Config $cfg -Ru 'r' -SourceBranch 'feat' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_GITHUB_TOKEN'
        }

        It 'reports the not-implemented Azure DevOps adapter' {
            $cfg = @{ prPlatform = 'azure-devops' }
            $r = New-GitBulkPullRequest -Config $cfg -Ru 'r' -SourceBranch 'feat' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'not yet implemented'
        }
    }
}

#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den GitLab-Adapter (Merge Requests + Status). Statt echter HTTP-Calls
# wird der Wrapper Invoke-GitBulkHttp gemockt. Private Funktionen → InModuleScope.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

InModuleScope GitBulk {
    Describe 'New-GitLabPullRequest' {
        It 'posts to /projects/{ns%2Frepo}/merge_requests and returns iid + web_url' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ iid = 7; web_url = 'https://gitlab.com/g/r/-/merge_requests/7' }; Error = $null } }
            $r = New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 'glpat' -Ru 'r' -SourceBranch 'feat' -Title 'T' -Description 'd'
            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 7
            $r.Url | Should -Be 'https://gitlab.com/g/r/-/merge_requests/7'
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://gitlab.com/api/v4/projects/g%2Fr/merge_requests' -and $Method -eq 'Post' -and
                $Body.source_branch -eq 'feat' -and $Body.target_branch -eq 'main' -and $Body.title -eq 'T'
            }
        }

        It 'sends the PRIVATE-TOKEN header' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ iid = 1; web_url = 'u' }; Error = $null } }
            New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 'glpat' -Ru 'r' -SourceBranch 'f' -Title 'T' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter { $Headers['PRIVATE-TOKEN'] -eq 'glpat' }
        }

        It 'maps numeric reviewers to reviewer_ids and skips non-numeric' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ iid = 2; web_url = 'u' }; Error = $null } }
            New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @('42', 'x', '7') } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Body.reviewer_ids.Count -eq 2 -and $Body.reviewer_ids[0] -eq 42 -and $Body.reviewer_ids[1] -eq 7
            }
        }

        It 'treats a 409 conflict as an update by looking up the open MR' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Post' } { @{ StatusCode = 409; Body = [pscustomobject]@{ message = @('Another open merge request already exists') }; Error = $null } }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Get' } { @{ StatusCode = 200; Body = @([pscustomobject]@{ iid = 5; web_url = 'https://gl/5' }); Error = $null } }
            $r = New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 5
            $r.Url | Should -Be 'https://gl/5'
        }

        It 'returns a failure result with the API message on 400' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 400; Body = [pscustomobject]@{ message = 'branch not found' }; Error = $null } }
            $r = New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.StatusCode | Should -Be 400
            $r.Error | Should -Match 'branch not found'
        }

        It 'returns a network-error result when the http wrapper reports an error' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 0; Body = $null; Error = 'connection refused' } }
            $r = New-GitLabPullRequest -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'network error'
        }
    }

    Describe 'Get-GitLabPrStatus' {
        BeforeEach { Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } } }

        It 'maps opened → open with approvals + CI rollup' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } {
                @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ iid = 11; state = 'opened'; web_url = 'https://gl/11' }) }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests/11/approvals' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ approved_by = @([pscustomobject]@{ }, [pscustomobject]@{ }); approvals_required = 3 } }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests/11/pipelines' } {
                @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ status = 'success' }) }
            }
            $r = Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'AKB-1-feature/x'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 11
            $r.Url | Should -Be 'https://gl/11'
            $r.Approvals.Approved | Should -Be 2
            $r.Approvals.Required | Should -Be 3
            $r.Ci | Should -Be 'passed'
        }

        It 'maps merged and closed states' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } { @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ iid = 1; state = 'merged' }) } }
            (Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'merged'

            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } { @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ iid = 1; state = 'closed' }) } }
            (Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'declined'
        }

        It 'returns none for an empty list' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } { @{ StatusCode = 200; Error = $null; Body = @() } }
            (Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'none'
        }

        It 'reports an API error without throwing' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } { @{ StatusCode = 500; Error = $null; Body = $null } }
            $r = Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b'
            $r.State | Should -Be 'none'
            $r.Error | Should -Match 'HTTP 500'
        }

        It 'honors a per-RU namespace override in the project path' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/merge_requests?source_branch=*' } { @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ iid = 1; state = 'opened' }) } }
            Get-GitLabPrStatus -GitLabConfig @{ namespace = 'g'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b' -Workspace 'other-grp' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter { $Uri -like '*/projects/other-grp%2Fr/merge_requests?source_branch=*' }
        }
    }

    Describe 'GitLab config + dispatch' {
        AfterEach { Remove-Item Env:GITBULK_GITLAB_TOKEN -ErrorAction SilentlyContinue }

        It 'validates a gitlab config through Get-GitBulkConfig (targetBranch defaults to main)' {
            $cfg = @{
                rus = @('r'); ticket = 'AKB-1'; branch = 'feature/x'
                operations = @(@{ type = 'delete-file'; path = 'x' })
                commitMessage = 'm'; prSummary = 's'; createPrOnError = $false
                prPlatform = 'gitlab'; gitlab = @{ namespace = 'my-group' }
            }
            $out = Get-GitBulkConfig -InputObject $cfg
            $out.prPlatform | Should -Be 'gitlab'
            $out.gitlab.namespace | Should -Be 'my-group'
            $out.gitlab.targetBranch | Should -Be 'main'
        }

        It 'rejects prPlatform=gitlab without a gitlab block' {
            $cfg = @{
                rus = @('r'); ticket = 'AKB-1'; branch = 'b'
                operations = @(@{ type = 'delete-file'; path = 'x' })
                commitMessage = 'm'; prSummary = 's'; createPrOnError = $false
                prPlatform = 'gitlab'
            }
            { Get-GitBulkConfig -InputObject $cfg } | Should -Throw '*gitlab*'
        }

        It 'New-GitBulkPullRequest dispatches to GitLab with the env token' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ iid = 1; web_url = 'u' }; Error = $null } }
            $env:GITBULK_GITLAB_TOKEN = 'glpat'
            $r = New-GitBulkPullRequest -Config @{ prPlatform = 'gitlab'; gitlab = @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } } -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1
        }

        It 'errors when the GitLab token env var is missing' {
            Remove-Item Env:GITBULK_GITLAB_TOKEN -ErrorAction SilentlyContinue
            $r = New-GitBulkPullRequest -Config @{ prPlatform = 'gitlab'; gitlab = @{ namespace = 'g'; targetBranch = 'main'; reviewers = @() } } -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_GITLAB_TOKEN'
        }
    }
}

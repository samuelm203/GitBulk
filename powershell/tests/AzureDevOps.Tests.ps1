#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den Azure-DevOps-Adapter (Pull Requests + Status). Statt echter
# HTTP-Calls wird der Wrapper Invoke-GitBulkHttp gemockt. Private Funktionen
# → InModuleScope.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

InModuleScope GitBulk {
    Describe 'New-AzureDevOpsPullRequest' {
        BeforeAll {
            $script:azCfg = [ordered]@{ organization = 'my-org'; project = 'my-proj'; targetBranch = 'main'; reviewers = @() }
        }

        It 'posts to the repo pullrequests endpoint with refs/heads and returns id + web url' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ pullRequestId = 7 }; Error = $null } }
            $r = New-AzureDevOpsPullRequest -AzureConfig $azCfg -Token 'pat' -Ru 'repo-a' -SourceBranch 'feature/x' -Title 'T' -Description 'd'
            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 7
            $r.Url | Should -Be 'https://dev.azure.com/my-org/my-proj/_git/repo-a/pullrequest/7'
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://dev.azure.com/my-org/my-proj/_apis/git/repositories/repo-a/pullrequests?api-version=7.1' -and
                $Method -eq 'Post' -and
                $Body.sourceRefName -eq 'refs/heads/feature/x' -and $Body.targetRefName -eq 'refs/heads/main' -and $Body.title -eq 'T'
            }
        }

        It 'sends a Basic Authorization header built from the PAT' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ pullRequestId = 1 }; Error = $null } }
            New-AzureDevOpsPullRequest -AzureConfig $azCfg -Token 'pat' -Ru 'r' -SourceBranch 'f' -Title 'T' | Out-Null
            $expected = 'Basic ' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(':pat'))
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter { $Headers['Authorization'] -eq $expected }
        }

        It 'maps reviewers to Azure { id } objects (pass-through)' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ pullRequestId = 2 }; Error = $null } }
            $cfg = [ordered]@{ organization = 'my-org'; project = 'my-proj'; targetBranch = 'main'; reviewers = @('guid-1', 'guid-2') }
            New-AzureDevOpsPullRequest -AzureConfig $cfg -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                @($Body.reviewers).Count -eq 2 -and $Body.reviewers[0].id -eq 'guid-1' -and $Body.reviewers[1].id -eq 'guid-2'
            }
        }

        It 'treats a 409 conflict as an update by looking up the active PR' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Post' } { @{ StatusCode = 409; Body = [pscustomobject]@{ message = 'TF401179: An active pull request already exists' }; Error = $null } }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Get' } { @{ StatusCode = 200; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 5 }) }; Error = $null } }
            $r = New-AzureDevOpsPullRequest -AzureConfig $azCfg -Token 't' -Ru 'repo-a' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeTrue
            $r.Id | Should -Be 5
            $r.Url | Should -Be 'https://dev.azure.com/my-org/my-proj/_git/repo-a/pullrequest/5'
        }

        It 'returns a failure result with the API message on 400' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 400; Body = [pscustomobject]@{ message = 'branch not found' }; Error = $null } }
            $r = New-AzureDevOpsPullRequest -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.StatusCode | Should -Be 400
            $r.Error | Should -Match 'branch not found'
        }

        It 'returns a network-error result when the http wrapper reports an error' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 0; Body = $null; Error = 'connection refused' } }
            $r = New-AzureDevOpsPullRequest -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'network error'
        }

        It 'honors apiBaseUrl (on-prem: instance root, collection = organization)' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ pullRequestId = 3 }; Error = $null } }
            $cfg = [ordered]@{ organization = 'DefaultCollection'; project = 'p'; targetBranch = 'main'; reviewers = @(); apiBaseUrl = 'https://tfs.example.com/tfs/' }
            New-AzureDevOpsPullRequest -AzureConfig $cfg -Token 't' -Ru 'r' -SourceBranch 'f' -Title 'T' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -like 'https://tfs.example.com/tfs/DefaultCollection/p/_apis/git/repositories/r/pullrequests*'
            }
        }
    }

    Describe 'Get-AzureDevOpsPrStatus' {
        BeforeAll {
            $script:azCfg = [ordered]@{ organization = 'my-org'; project = 'my-proj'; targetBranch = 'main'; reviewers = @() }
        }
        BeforeEach { Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } } }

        It 'maps active -> open with approvals from embedded reviewer votes + CI rollup' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{
                            pullRequestId = 11; status = 'active'
                            reviewers     = @(
                                [pscustomobject]@{ vote = 10; isRequired = $true },
                                [pscustomobject]@{ vote = 5; isRequired = $true },
                                [pscustomobject]@{ vote = 0; isRequired = $true }
                            )
                        }) }
                }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests/11/statuses*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ state = 'succeeded' }) } }
            }
            $r = Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'repo-a' -SourceBranch 'AKB-1-feature/x'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 11
            $r.Url | Should -Be 'https://dev.azure.com/my-org/my-proj/_git/repo-a/pullrequest/11'
            $r.Approvals.Approved | Should -Be 2
            $r.Approvals.Required | Should -Be 3
            $r.Ci | Should -Be 'passed'
        }

        It 'rolls a failed status up to ci=failed' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 12; status = 'active' }) } }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests/12/statuses*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ state = 'succeeded' }, [pscustomobject]@{ state = 'failed' }) } }
            }
            (Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b').Ci | Should -Be 'failed'
        }

        It 'maps completed and abandoned states' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 1; status = 'completed' }) } }
            }
            (Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'merged'

            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 1; status = 'abandoned' }) } }
            }
            (Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'declined'
        }

        It 'picks the newest PR by creationDate when several exist for the branch' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @(
                            [pscustomobject]@{ pullRequestId = 1; status = 'abandoned'; creationDate = '2026-01-01T00:00:00Z' },
                            [pscustomobject]@{ pullRequestId = 2; status = 'active'; creationDate = '2026-06-01T00:00:00Z' }
                        ) }
                }
            }
            $r = Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 2
        }

        It 'returns none for an empty value list' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @() } }
            }
            (Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'none'
        }

        It 'reports an API error without throwing' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } { @{ StatusCode = 500; Error = $null; Body = $null } }
            $r = Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'r' -SourceBranch 'b'
            $r.State | Should -Be 'none'
            $r.Error | Should -Match 'HTTP 500'
        }

        It 'honors a per-RU workspace override as the project in the path' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*searchCriteria.sourceRefName=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 1; status = 'active' }) } }
            }
            Get-AzureDevOpsPrStatus -AzureConfig $azCfg -Token 't' -Ru 'repo-a' -SourceBranch 'b' -Workspace 'other-proj' | Out-Null
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -like '*/my-org/other-proj/_apis/git/repositories/repo-a/pullrequests?searchCriteria.sourceRefName=*'
            }
        }
    }

    Describe 'Azure DevOps config + dispatch' {
        AfterEach { Remove-Item Env:GITBULK_AZURE_DEVOPS_TOKEN -ErrorAction SilentlyContinue }

        It 'validates an azure-devops config through Get-GitBulkConfig (targetBranch defaults to master)' {
            $cfg = @{
                rus = @('r'); ticket = 'AKB-1'; branch = 'feature/x'
                operations = @(@{ type = 'delete-file'; path = 'x' })
                commitMessage = 'm'; prSummary = 's'; createPrOnError = $false
                prPlatform = 'azure-devops'; azureDevOps = @{ organization = 'my-org'; project = 'my-proj' }
            }
            $out = Get-GitBulkConfig -InputObject $cfg
            $out.prPlatform | Should -Be 'azure-devops'
            $out.azureDevOps.organization | Should -Be 'my-org'
            $out.azureDevOps.project | Should -Be 'my-proj'
            $out.azureDevOps.targetBranch | Should -Be 'master'
        }

        It 'rejects prPlatform=azure-devops without an azureDevOps block' {
            $cfg = @{
                rus = @('r'); ticket = 'AKB-1'; branch = 'b'
                operations = @(@{ type = 'delete-file'; path = 'x' })
                commitMessage = 'm'; prSummary = 's'; createPrOnError = $false
                prPlatform = 'azure-devops'
            }
            { Get-GitBulkConfig -InputObject $cfg } | Should -Throw '*azureDevOps*'
        }

        It 'New-GitBulkPullRequest dispatches to Azure DevOps with the env token' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 201; Body = [pscustomobject]@{ pullRequestId = 1 }; Error = $null } }
            $env:GITBULK_AZURE_DEVOPS_TOKEN = 'pat'
            $r = New-GitBulkPullRequest -Config @{ prPlatform = 'azure-devops'; azureDevOps = [ordered]@{ organization = 'o'; project = 'p'; targetBranch = 'main'; reviewers = @() } } -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1
        }

        It 'errors when the Azure DevOps token env var is missing' {
            Remove-Item Env:GITBULK_AZURE_DEVOPS_TOKEN -ErrorAction SilentlyContinue
            $r = New-GitBulkPullRequest -Config @{ prPlatform = 'azure-devops'; azureDevOps = [ordered]@{ organization = 'o'; project = 'p'; targetBranch = 'main'; reviewers = @() } } -Ru 'r' -SourceBranch 'f' -Title 'T'
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_AZURE_DEVOPS_TOKEN'
        }

        It 'Get-GitBulkPrStatus dispatches to Azure DevOps with the env token' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = [pscustomobject]@{ value = @([pscustomobject]@{ pullRequestId = 9; status = 'active' }) }; Error = $null } }
            $env:GITBULK_AZURE_DEVOPS_TOKEN = 'pat'
            $r = Get-GitBulkPrStatus -Config @{ prPlatform = 'azure-devops'; azureDevOps = [ordered]@{ organization = 'o'; project = 'p'; targetBranch = 'main'; reviewers = @() } } -Ru 'r' -SourceBranch 'f'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 9
        }
    }
}

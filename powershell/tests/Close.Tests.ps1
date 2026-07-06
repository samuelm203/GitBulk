#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für `gitbulk -Close` (PS-Parität zu node `gitbulk close`):
# Close-Funktionen der vier Adapter (HTTP gemockt), Dispatcher und die
# Invoke-GitBulkClose-Orchestrierung inkl. echtem Git-Branch-Delete.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

BeforeAll {
    function script:newWorkspace {
        $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-close-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $ws | Out-Null
        return $ws
    }
    function script:addRepo {
        param([string]$Workspace, [string]$Ru)
        $remote = Join-Path $Workspace "$Ru.git"
        New-Item -ItemType Directory -Path $remote | Out-Null
        & git -C $remote init --bare -q --initial-branch=master
        & git -C $Workspace clone -q $remote $Ru
        $repo = Join-Path $Workspace $Ru
        & git -C $repo config user.email 'test@example.com'
        & git -C $repo config user.name 'Test User'
        [System.IO.File]::WriteAllText((Join-Path $repo 'README.md'), "init`n")
        & git -C $repo add -A
        & git -C $repo commit -q -m 'init'
        & git -C $repo push -q origin master
        return $repo
    }
    function script:writeConfigFile {
        param([string]$Workspace, [string[]]$Rus)
        $script = Join-Path $Workspace 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfg = @{
            rus = $Rus; ticket = 'AKB-1'; branch = 'feature/x'; sourceBranch = 'master'
            script = $script; commitMessage = 'm'; prSummary = 's'
            createPrOnError = $false; workspaceDir = $Workspace; concurrency = 1
            prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
        }
        $path = Join-Path $Workspace 'gitbulk.config.json'
        $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $path
        return $path
    }
}

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-close-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'adapter close functions' {
        It 'GitHub: PATCH /pulls/{id} with state=closed' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } }
            $r = Close-GitHubPullRequest -GitHubConfig ([ordered]@{ owner = 'me' }) -Token 't' -Ru 'repo-a' -Id 7
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://api.github.com/repos/me/repo-a/pulls/7' -and $Method -eq 'Patch' -and $Body.state -eq 'closed'
            }
        }

        It 'GitLab: PUT /merge_requests/{iid} with state_event=close' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } }
            $r = Close-GitLabPullRequest -GitLabConfig ([ordered]@{ namespace = 'g' }) -Token 't' -Ru 'repo-a' -Id 5
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://gitlab.com/api/v4/projects/g%2Frepo-a/merge_requests/5' -and $Method -eq 'Put' -and $Body.state_event -eq 'close'
            }
        }

        It 'Azure: PATCH /pullrequests/{id} with status=abandoned' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } }
            $r = Close-AzureDevOpsPullRequest -AzureConfig ([ordered]@{ organization = 'o'; project = 'p' }) -Token 't' -Ru 'repo-a' -Id 9
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -like '*/o/p/_apis/git/repositories/repo-a/pullrequests/9?api-version=7.1' -and $Body.status -eq 'abandoned'
            }
        }

        It 'Bitbucket Cloud: POST /pullrequests/{id}/decline' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } }
            $r = Close-BitbucketPullRequest -BitbucketConfig ([ordered]@{ workspace = 'ws'; apiVariant = 'cloud' }) -Token 't' -Ru 'repo-a' -Id 3
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -like '*/repositories/ws/repo-a/pullrequests/3/decline' -and $Method -eq 'Post'
            }
        }

        It 'Bitbucket Server: fetches the PR version, then declines with it' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Get' } { @{ StatusCode = 200; Body = [pscustomobject]@{ version = 4 }; Error = $null } }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Method -eq 'Post' } { @{ StatusCode = 200; Body = $null; Error = $null } }
            $cfg = [ordered]@{ workspace = 'KEY'; apiVariant = 'server'; apiBaseUrl = 'https://bb.example.com' }
            $r = Close-BitbucketPullRequest -BitbucketConfig $cfg -Token 't' -Ru 'repo-a' -Id 3
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-GitBulkHttp -Times 1 -ParameterFilter {
                $Uri -eq 'https://bb.example.com/rest/api/1.0/projects/KEY/repos/repo-a/pull-requests/3/decline?version=4'
            }
        }

        It 'reports an HTTP failure as a result (no throw)' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 403; Body = $null; Error = $null } }
            $r = Close-GitHubPullRequest -GitHubConfig ([ordered]@{ owner = 'me' }) -Token 't' -Ru 'r' -Id 1
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'HTTP 403'
        }
    }

    Describe 'Close-GitBulkPr (dispatcher)' {
        AfterEach { Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue }

        It 'dispatches with the env token' {
            Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } }
            $env:GITBULK_GITHUB_TOKEN = 'gh-x'
            $r = Close-GitBulkPr -Config @{ prPlatform = 'github'; github = [ordered]@{ owner = 'o' } } -Ru 'r' -Id 1
            $r.Ok | Should -BeTrue
        }

        It 'errors when the token env var is missing' {
            Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue
            $r = Close-GitBulkPr -Config @{ prPlatform = 'github'; github = [ordered]@{ owner = 'o' } } -Ru 'r' -Id 1
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_GITHUB_TOKEN'
        }
    }
}

Describe 'Invoke-GitBulkClose (integration)' {
    BeforeAll {
    function script:invokeCloseJson {
        param([hashtable]$CloseArgs)
        $sw = [System.IO.StringWriter]::new()
        $orig = [Console]::Out
        [Console]::SetOut($sw)
        try { $script:lastExit = Invoke-GitBulkClose @CloseArgs -Json -NoColor } finally { [Console]::SetOut($orig) }
        return ($sw.ToString() | ConvertFrom-Json)
    }
    }
    BeforeEach { $env:GITBULK_GITHUB_TOKEN = 'dummy' }
    AfterEach { Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue }

    It 'returns 3 on a config error' {
        $code = Invoke-GitBulkClose -ConfigPath (Join-Path ([System.IO.Path]::GetTempPath()) 'nope-close.json') -NoColor
        $code | Should -Be 3
    }

    It 'aborts with 3 without -Yes (declined or non-interactive)' {
        $ws = newWorkspace
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')
        Mock -ModuleName GitBulk Read-Host { 'n' }
        $code = Invoke-GitBulkClose -ConfigPath $cfgFile -NoColor
        $code | Should -Be 3
    }

    It 'dry-run reports would-close/would-delete without calling the close API' {
        $ws = newWorkspace
        addRepo -Workspace $ws -Ru 'repo-a' | Out-Null
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')

        Mock -ModuleName GitBulk Get-GitBulkPrStatus { @{ State = 'open'; Id = 7; Url = 'http://pr/7' } }
        Mock -ModuleName GitBulk Close-GitBulkPr { throw 'must not be called in dry-run' }
        $report = invokeCloseJson -CloseArgs @{ ConfigPath = $cfgFile; DryRun = $true }
        $report.DryRun | Should -BeTrue
        $report.Results[0].Pr | Should -Be 'would-close'
        $report.Results[0].Branch | Should -Be 'would-delete'
    }

    It 'closes the open PR and really deletes the remote feature branch' {
        $ws = newWorkspace
        $repo = addRepo -Workspace $ws -Ru 'repo-a'
        & git -C $repo checkout -q -b 'AKB-1-feature/x'
        & git -C $repo push -q origin 'AKB-1-feature/x'
        & git -C $repo checkout -q master
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')

        Mock -ModuleName GitBulk Get-GitBulkPrStatus { @{ State = 'open'; Id = 7; Url = 'http://pr/7' } }
        Mock -ModuleName GitBulk Close-GitBulkPr { @{ Ok = $true; StatusCode = 200; Error = $null } }
        $report = invokeCloseJson -CloseArgs @{ ConfigPath = $cfgFile; Yes = $true }
        $report.Results[0].Pr | Should -Be 'closed'
        $report.Results[0].Branch | Should -Be 'deleted'
        $report.Totals.Failed | Should -Be 0

        (& git -C $repo ls-remote --heads origin) -join "`n" | Should -Not -Match 'AKB-1-feature/x'
    }

    It 'reports not-found when the remote branch never existed (exit 0)' {
        $ws = newWorkspace
        addRepo -Workspace $ws -Ru 'repo-a' | Out-Null
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')

        Mock -ModuleName GitBulk Get-GitBulkPrStatus { @{ State = 'none' } }
        $report = invokeCloseJson -CloseArgs @{ ConfigPath = $cfgFile; Yes = $true }
        $report.Results[0].Pr | Should -Be 'no-open-pr'
        $report.Results[0].Branch | Should -Be 'not-found'
    }
}

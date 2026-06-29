#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für `gitbulk -Status` (PowerShell-Port): die Adapter-Status-Funktionen
# (gegen den gemockten HTTP-Wrapper), den Report-Collector (mit gemocktem
# Dispatcher) und die Formatter. Tokens werden über die Env gesetzt; echte
# Terminal-Eingabe entfällt.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

InModuleScope GitBulk {
    Describe 'Get-GitHubPrStatus' {
        BeforeEach { Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } } }

        It 'maps open, counts approvals (latest per user) and rolls up check-runs' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls?head=*' } {
                @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ number = 11; state = 'open'; html_url = 'https://gh/11'; head = [pscustomobject]@{ sha = 'sha1' } }) }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls/11/reviews' } {
                @{ StatusCode = 200; Error = $null; Body = @(
                        [pscustomobject]@{ user = [pscustomobject]@{ login = 'a' }; state = 'COMMENTED' }
                        [pscustomobject]@{ user = [pscustomobject]@{ login = 'a' }; state = 'APPROVED' }   # jüngstes von a gewinnt
                        [pscustomobject]@{ user = [pscustomobject]@{ login = 'b' }; state = 'APPROVED' }
                    ) }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/commits/sha1/check-runs' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ check_runs = @([pscustomobject]@{ status = 'completed'; conclusion = 'success' }) } }
            }
            $r = Get-GitHubPrStatus -GitHubConfig @{ owner = 'o'; targetBranch = 'main'; reviewers = @() } -Token 't' -Ru 'repo' -SourceBranch 'AKB-1-feature/x'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 11
            $r.Approvals.Approved | Should -Be 2
            $r.Ci | Should -Be 'passed'
        }

        It 'maps closed + merged_at to merged' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls?head=*' } {
                @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ number = 2; state = 'closed'; merged_at = '2020-01-01'; html_url = 'u' }) }
            }
            (Get-GitHubPrStatus -GitHubConfig @{ owner = 'o'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'merged'
        }

        It 'maps closed without merged_at to declined' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls?head=*' } {
                @{ StatusCode = 200; Error = $null; Body = @([pscustomobject]@{ number = 3; state = 'closed'; merged_at = $null; html_url = 'u' }) }
            }
            (Get-GitHubPrStatus -GitHubConfig @{ owner = 'o'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'declined'
        }

        It 'returns none for an empty list' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls?head=*' } { @{ StatusCode = 200; Error = $null; Body = @() } }
            (Get-GitHubPrStatus -GitHubConfig @{ owner = 'o'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'none'
        }

        It 'reports an API error without throwing' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pulls?head=*' } { @{ StatusCode = 500; Error = $null; Body = $null } }
            $r = Get-GitHubPrStatus -GitHubConfig @{ owner = 'o'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b'
            $r.State | Should -Be 'none'
            $r.Error | Should -Match 'HTTP 500'
        }
    }

    Describe 'Get-BitbucketPrStatus (cloud)' {
        BeforeEach { Mock Invoke-GitBulkHttp { @{ StatusCode = 200; Body = $null; Error = $null } } }

        It 'maps OPEN, approvals from the PR detail and statuses rollup' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests?q=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ values = @([pscustomobject]@{
                                id = 5; state = 'OPEN'
                                links = [pscustomobject]@{ html = [pscustomobject]@{ href = 'https://bb/5' } }
                                source = [pscustomobject]@{ commit = [pscustomobject]@{ hash = 'abc' } }
                            }) } }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests/5' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ participants = @(
                            [pscustomobject]@{ approved = $true; role = 'REVIEWER' }
                            [pscustomobject]@{ approved = $false; role = 'REVIEWER' }
                            [pscustomobject]@{ approved = $true; role = 'PARTICIPANT' }
                        ) } }
            }
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/commit/abc/statuses' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ values = @([pscustomobject]@{ state = 'SUCCESSFUL' }) } }
            }
            $r = Get-BitbucketPrStatus -BitbucketConfig @{ workspace = 'ws'; apiVariant = 'cloud'; targetBranch = 'master'; reviewers = @() } -Token 't' -Ru 'repo' -SourceBranch 'AKB-1-feature/x'
            $r.State | Should -Be 'open'
            $r.Id | Should -Be 5
            $r.Approvals.Approved | Should -Be 2
            $r.Approvals.Required | Should -Be 2
            $r.Ci | Should -Be 'passed'
        }

        It 'maps MERGED and DECLINED' {
            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests?q=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ values = @([pscustomobject]@{ id = 9; state = 'MERGED' }) } }
            }
            (Get-BitbucketPrStatus -BitbucketConfig @{ workspace = 'ws'; apiVariant = 'cloud'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'merged'

            Mock Invoke-GitBulkHttp -ParameterFilter { $Uri -like '*/pullrequests?q=*' } {
                @{ StatusCode = 200; Error = $null; Body = [pscustomobject]@{ values = @([pscustomobject]@{ id = 9; state = 'DECLINED' }) } }
            }
            (Get-BitbucketPrStatus -BitbucketConfig @{ workspace = 'ws'; apiVariant = 'cloud'; reviewers = @() } -Token 't' -Ru 'r' -SourceBranch 'b').State | Should -Be 'declined'
        }
    }

    Describe 'Get-GitBulkStatusReport' {
        BeforeAll {
            $script:origTok = $env:GITBULK_GITHUB_TOKEN
            $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('gb-st-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $script:tmp | Out-Null
        }
        AfterAll {
            if ($null -eq $script:origTok) { Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue }
            else { $env:GITBULK_GITHUB_TOKEN = $script:origTok }
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:tmp
        }
        BeforeEach { $env:GITBULK_GITHUB_TOKEN = 'live' }

        It 'derives the source branch, aggregates totals and passes per-RU workspaces' {
            $cfg = @{
                rus = @('repo-a', @{ repo = 'repo-b'; workspace = 'ws2' }, 'repo-c', 'repo-d')
                ticket = 'AKB-1'; branch = 'feature/x'
                operations = @(@{ type = 'delete-file'; path = 'x' })
                commitMessage = 'm'; prSummary = 's'; createPrOnError = $false
                prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
            }
            $cfgFile = Join-Path $script:tmp 'gb.json'
            $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $cfgFile

            Mock Get-GitBulkPrStatus {
                switch ($Ru) {
                    'repo-a' { @{ State = 'open'; Id = 1; Url = 'u1' } }
                    'repo-b' { @{ State = 'merged'; Id = 2 } }
                    'repo-c' { @{ State = 'none' } }
                    'repo-d' { @{ State = 'none'; Error = 'boom' } }
                }
            }

            $report = Get-GitBulkStatusReport -ConfigPath $cfgFile
            $report.SourceBranch | Should -Be 'AKB-1-feature/x'
            $report.Platform | Should -Be 'github'
            $report.Totals.Open | Should -Be 1
            $report.Totals.Merged | Should -Be 1
            $report.Totals.None | Should -Be 1
            $report.Totals.Errored | Should -Be 1
            Should -Invoke Get-GitBulkPrStatus -Times 1 -ParameterFilter { $Ru -eq 'repo-b' -and $Workspace -eq 'ws2' -and $SourceBranch -eq 'AKB-1-feature/x' }
        }

        It 'returns $null on a config error' {
            Get-GitBulkStatusReport -ConfigPath (Join-Path $script:tmp 'nope.json') | Should -BeNullOrEmpty
        }
    }
}

Describe 'Status formatters' {
    BeforeAll {
        Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force
        $script:report = [pscustomobject]@{
            Ticket = 'AKB-1'; SourceBranch = 'AKB-1-feature/x'; Platform = 'github'
            Results = @(
                [pscustomobject]@{ Ru = 'repo-a'; State = 'open'; Id = 11; Url = 'https://x/11'; Approvals = @{ Approved = 2; Required = 3 }; Ci = 'passed' }
                [pscustomobject]@{ Ru = 'repo-b'; State = 'merged'; Id = 12; Url = 'https://x/12'; Approvals = @{ Approved = 2 }; Ci = 'passed' }
                [pscustomobject]@{ Ru = 'repo-c'; State = 'none' }
                [pscustomobject]@{ Ru = 'repo-d'; State = 'none'; Error = 'boom' }
            )
            Totals = [pscustomobject]@{ Open = 1; Merged = 1; Declined = 0; None = 1; Errored = 1 }
        }
    }

    It 'renders a table with header, columns and a summary' {
        $t = Format-GitBulkStatusTable -Report $script:report
        $t | Should -Match 'Ticket AKB-1'
        $t | Should -Match 'APPROVALS'
        $t | Should -Match 'repo-a.*#11.*open.*2/3.*passed'
        $t | Should -Match 'repo-b.*#12.*merged.*2\s.*passed'   # approved-only → nur "2"
        $t | Should -Match 'repo-d.*error.*\(error: boom\)'
        $t | Should -Match 'Summary: 1 merged .* 1 open .* 0 declined .* 1 none .* 1 error'
    }

    It 'serializes to JSON that round-trips' {
        $obj = Format-GitBulkStatusJson -Report $script:report | ConvertFrom-Json
        $obj.Ticket | Should -Be 'AKB-1'
        $obj.SourceBranch | Should -Be 'AKB-1-feature/x'
        $obj.Results.Count | Should -Be 4
        $obj.Totals.Errored | Should -Be 1
    }
}

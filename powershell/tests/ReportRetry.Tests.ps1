#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für -Report (JSON-Lauf-Report) und -RetryFailed (nur Fehlschläge erneut)
# — Pendants zu node_ts --report/--retry-failed.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

BeforeAll {
    function script:newWorkspace {
        $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-rr-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
    }
    function script:writeConfigFile {
        param([string]$Workspace, [string[]]$Rus)
        $script = Join-Path $Workspace 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfg = @{
            rus = $Rus; ticket = 'AKB-1'; branch = 'feature/x'; sourceBranch = 'master'
            script = $script; commitMessage = 'test commit'; prSummary = 'summary'
            createPrOnError = $false; dryRun = $true; workspaceDir = $Workspace; concurrency = 1
            prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
        }
        $path = Join-Path $Workspace 'gitbulk.config.json'
        $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $path
        return $path
    }
}

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-rr-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Get-GitBulkRunReport' {
        BeforeAll {
            $script:cfg = @{
                dryRun = $false; prPlatform = 'github'; ticket = 'AKB-1'
                branch = 'feature/x'; sourceBranch = 'master'
            }
            $script:sum = [pscustomobject]@{
                Results   = @(
                    [pscustomobject]@{ Ru = 'a'; Branch = 'AKB-1-feature/x'; Outcome = 'pr-created'; PrUrl = 'http://pr/1'; Message = ''; Error = $null }
                    [pscustomobject]@{ Ru = 'b'; Branch = ''; Outcome = 'pr-failed'; PrUrl = $null; Message = ''; Error = 'HTTP 500' }
                )
                Total     = 2; PrCreated = 1; PrFailed = 1; Pushed = 0; Committed = 0
                NoChanges = 0; Skipped = 0; Fatal = 0
            }
        }

        It 'captures metadata, totals and flat per-RU entries' {
            $r = Get-GitBulkRunReport -Config $cfg -Summary $sum -ExitCode 1 `
                -StartedAt ([datetime]'2026-01-01T00:00:00Z') -FinishedAt ([datetime]'2026-01-01T00:00:02Z')
            $r.reportVersion | Should -Be 1
            $r.exitCode | Should -Be 1
            $r.prPlatform | Should -Be 'github'
            $r.totals.prFailed | Should -Be 1
            $r.totalDurationMs | Should -Be 2000
            @($r.results).Count | Should -Be 2
            $r.results[0].ru | Should -Be 'a'
            $r.results[0].prUrl | Should -Be 'http://pr/1'
            $r.results[1].error | Should -Be 'HTTP 500'
        }

        It 'omits empty optional fields and never contains token-like data' {
            $r = Get-GitBulkRunReport -Config $cfg -Summary $sum -ExitCode 0 `
                -StartedAt ([datetime]::UtcNow) -FinishedAt ([datetime]::UtcNow)
            $json = $r | ConvertTo-Json -Depth 10
            $r.results[1].PSObject.Properties['prUrl'] | Should -BeNullOrEmpty
            $r.results[0].PSObject.Properties['error'] | Should -BeNullOrEmpty
            $json | Should -Not -Match 'token'
        }
    }

    Describe 'Write-GitBulkRunReport' {
        It 'writes JSON that round-trips' {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-rr-w-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $dir | Out-Null
            try {
                $path = Join-Path $dir 'out.json'
                $report = [ordered]@{ reportVersion = 1; exitCode = 2; results = @([pscustomobject]@{ ru = 'a'; outcome = 'fatal' }) }
                Write-GitBulkRunReport -Path $path -Report $report
                $parsed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
                $parsed.exitCode | Should -Be 2
                @($parsed.results).Count | Should -Be 1
            } finally {
                Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
            }
        }
    }

    Describe 'Get-GitBulkRetryRus' {
        BeforeAll {
            $script:dir = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-rr-r-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $script:dir | Out-Null
            function script:writeReport([string]$Name, $Content) {
                $p = Join-Path $script:dir $Name
                $text = if ($Content -is [string]) { $Content } else { $Content | ConvertTo-Json -Depth 10 }
                Set-Content -LiteralPath $p -Value $text
                return $p
            }
        }
        AfterAll { Remove-Item -Recurse -Force $script:dir -ErrorAction SilentlyContinue }

        It 'returns PS and node retryable outcomes (in report order)' {
            $p = writeReport 'ok.json' ([ordered]@{
                    reportVersion = 1
                    results       = @(
                        @{ ru = 'a'; outcome = 'pr-created' }, @{ ru = 'b'; outcome = 'pr-failed' },
                        @{ ru = 'c'; outcome = 'no-changes' }, @{ ru = 'd'; outcome = 'fatal' },
                        @{ ru = 'e'; outcome = 'push-failed' }, @{ ru = 'f'; outcome = 'fatal-error' },
                        @{ ru = 'g'; outcome = 'not-processed' }, @{ ru = 'h'; outcome = 'skipped' }
                    )
                })
            Get-GitBulkRetryRus -ReportPath $p | Should -Be @('b', 'd', 'e', 'f', 'g')
        }

        It 'returns an empty list when nothing failed' {
            $p = writeReport 'green.json' ([ordered]@{ reportVersion = 1; results = @(@{ ru = 'a'; outcome = 'pr-created' }) })
            @(Get-GitBulkRetryRus -ReportPath $p).Count | Should -Be 0
        }

        It 'throws a clear error for a missing file' {
            { Get-GitBulkRetryRus -ReportPath (Join-Path $script:dir 'nope.json') } | Should -Throw '*cannot read report file*'
        }

        It 'throws a clear error for invalid JSON' {
            $p = writeReport 'broken.json' '{ not json'
            { Get-GitBulkRetryRus -ReportPath $p } | Should -Throw '*not valid JSON*'
        }

        It 'throws a clear error when the results array is missing' {
            $p = writeReport 'shape.json' ([ordered]@{ foo = 'bar' })
            { Get-GitBulkRetryRus -ReportPath $p } | Should -Throw "*missing 'results' array*"
        }

        It 'rejects a newer report version instead of misreading it' {
            $p = writeReport 'future.json' ([ordered]@{ reportVersion = 2; results = @(@{ ru = 'a'; outcome = 'pr-failed' }) })
            { Get-GitBulkRetryRus -ReportPath $p } | Should -Throw '*newer than supported*'
        }

        It 'skips malformed entries defensively' {
            $p = writeReport 'mixed.json' '{ "reportVersion": 1, "results": [ { "ru": 42, "outcome": "pr-failed" }, { "outcome": "pr-failed" }, null, { "ru": "ok", "outcome": "pr-failed" } ] }'
            Get-GitBulkRetryRus -ReportPath $p | Should -Be @('ok')
        }
    }
}

Describe 'Invoke-GitBulk -Report / -RetryFailed (integration)' {
    It 'rejects -RetryFailed combined with -Only (exit 3)' {
        $code = Invoke-GitBulk -ConfigPath 'irrelevant.json' -RetryFailed 'r.json' -Only 'a' -NoColor
        $code | Should -Be 3
    }

    It 'exits 0 with "nothing to retry" when the report has no failures (no run)' {
        $ws = newWorkspace
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')
        $report = Join-Path $ws 'green.json'
        '{ "reportVersion": 1, "results": [ { "ru": "repo-a", "outcome": "pr-created" } ] }' | Set-Content $report

        $code = Invoke-GitBulk -ConfigPath $cfgFile -RetryFailed $report -NoColor
        $code | Should -Be 0
        # Kein Lauf: das Repo existiert nicht einmal — wäre sonst 'skipped' im Summary.
    }

    It 'returns 3 for a retry RU that is not in the config' {
        $ws = newWorkspace
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a')
        $report = Join-Path $ws 'alien.json'
        '{ "reportVersion": 1, "results": [ { "ru": "ghost", "outcome": "pr-failed" } ] }' | Set-Content $report

        $code = Invoke-GitBulk -ConfigPath $cfgFile -RetryFailed $report -NoColor
        $code | Should -Be 3
    }

    It 'writes a valid JSON report after a dry-run and retries only the failures' {
        $ws = newWorkspace
        addRepo -Workspace $ws -Ru 'repo-a'
        addRepo -Workspace $ws -Ru 'repo-b'
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a', 'repo-b')

        # 1) Lauf mit -Report.
        $reportPath = Join-Path $ws 'run.json'
        $code = Invoke-GitBulk -ConfigPath $cfgFile -Report $reportPath -NoColor
        $code | Should -Be 0
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $report.reportVersion | Should -Be 1
        $report.exitCode | Should -Be 0
        $report.dryRun | Should -BeTrue
        @($report.results).Count | Should -Be 2
        $report.results[0].outcome | Should -Be 'committed'

        # 2) Report manuell auf "repo-a fehlgeschlagen" setzen und nur den wiederholen.
        $retryReport = Join-Path $ws 'retry-input.json'
        '{ "reportVersion": 1, "results": [ { "ru": "repo-a", "outcome": "pr-failed" }, { "ru": "repo-b", "outcome": "pr-created" } ] }' |
            Set-Content $retryReport
        $out = Join-Path $ws 'retry.json'
        $code2 = Invoke-GitBulk -ConfigPath $cfgFile -RetryFailed $retryReport -Report $out -NoColor
        $code2 | Should -Be 0
        $retry = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
        @($retry.results).Count | Should -Be 1
        $retry.results[0].ru | Should -Be 'repo-a'
    }
}

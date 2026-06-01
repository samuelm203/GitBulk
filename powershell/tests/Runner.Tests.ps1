#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den öffentlichen Runner Invoke-GitBulkRun (RU-Loop + Concurrency).
# Echte temporäre Git-Repos mit Bare-Remote (kein Netzwerk).

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

    function script:newRunWorkspace {
        $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-run-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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

    function script:newRunConfig {
        param([string]$Workspace, [string]$Script, [string[]]$Rus, [int]$Concurrency = 2)
        return [ordered]@{
            rus = $Rus; ticket = 'AKB-1'; branch = 'feature/x'; sourceBranch = 'master'
            script = $Script; commitMessage = 'test commit'; prSummary = 'summary'
            createPrOnError = $false; dryRun = $false; skipHooks = $false; cloneIfMissing = $false
            workspaceDir = $Workspace; commandTimeoutMs = 30000; concurrency = $Concurrency
            retry = [ordered]@{ maxAttempts = 2; backoffMs = 0; maxBackoffMs = 0 }
        }
    }

    function script:remoteHasBranch {
        param([string]$Repo, [string]$Branch)
        $out = & git -C $Repo ls-remote --heads origin $Branch
        return -not [string]::IsNullOrWhiteSpace($out)
    }
}

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-run-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-GitBulkRun' {
    It 'processes all RUs in parallel and summarizes the outcomes' {
        $ws = newRunWorkspace
        $repoA = addRepo -Workspace $ws -Ru 'repo-a'
        $repoB = addRepo -Workspace $ws -Ru 'repo-b'
        $script = Join-Path $ws 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfg = newRunConfig -Workspace $ws -Script $script -Rus @('repo-a', 'repo-b', 'ghost') -Concurrency 2

        $summary = Invoke-GitBulkRun -Config $cfg

        $summary.Total | Should -Be 3
        $summary.Pushed | Should -Be 2
        $summary.Skipped | Should -Be 1
        $summary.Failed | Should -Be 0
        remoteHasBranch -Repo $repoA -Branch 'AKB-1-feature/x' | Should -BeTrue
        remoteHasBranch -Repo $repoB -Branch 'AKB-1-feature/x' | Should -BeTrue
    }

    It 'reports no-changes for a script that produces no diff' {
        $ws = newRunWorkspace
        $null = addRepo -Workspace $ws -Ru 'repo-a'
        $script = Join-Path $ws 'noop.ps1'
        [System.IO.File]::WriteAllText($script, "exit 0")
        $cfg = newRunConfig -Workspace $ws -Script $script -Rus @('repo-a') -Concurrency 1

        $summary = Invoke-GitBulkRun -Config $cfg
        $summary.Total | Should -Be 1
        $summary.NoChanges | Should -Be 1
        $summary.Pushed | Should -Be 0
    }

    It 'runs sequentially when concurrency is 1' {
        $ws = newRunWorkspace
        $null = addRepo -Workspace $ws -Ru 'repo-a'
        $null = addRepo -Workspace $ws -Ru 'repo-b'
        $script = Join-Path $ws 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'x'")
        $cfg = newRunConfig -Workspace $ws -Script $script -Rus @('repo-a', 'repo-b') -Concurrency 1

        $summary = Invoke-GitBulkRun -Config $cfg
        $summary.Total | Should -Be 2
        $summary.Pushed | Should -Be 2
    }
}

#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den per-RU-Git-Flow Invoke-GitBulkRu (InModuleScope). Es werden
# echte temporäre Git-Repos mit Bare-Remote aufgesetzt (kein Netzwerk).

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-ru-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Invoke-GitBulkRu' {
        BeforeAll {
            function newWorkspace {
                param([string]$Ru = 'repo-a')
                $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-ru-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $ws | Out-Null
                $remote = Join-Path $ws "$Ru.git"
                New-Item -ItemType Directory -Path $remote | Out-Null
                & git -C $remote init --bare -q --initial-branch=master
                & git -C $ws clone -q $remote $Ru
                $repo = Join-Path $ws $Ru
                & git -C $repo config user.email 'test@example.com'
                & git -C $repo config user.name 'Test User'
                [System.IO.File]::WriteAllText((Join-Path $repo 'README.md'), "init`n")
                & git -C $repo add -A
                & git -C $repo commit -q -m 'init'
                & git -C $repo push -q origin master
                return @{ Workspace = $ws; Repo = $repo; Remote = $remote; Ru = $Ru }
            }

            function newConfig {
                param([string]$Workspace, [string]$Script, [bool]$DryRun = $false, [bool]$CloneIfMissing = $false)
                return [ordered]@{
                    ticket           = 'AKB-1'
                    branch           = 'feature/x'
                    sourceBranch     = 'master'
                    script           = $Script
                    commitMessage    = 'test commit'
                    prSummary        = 'summary'
                    createPrOnError  = $false
                    dryRun           = $DryRun
                    skipHooks        = $false
                    cloneIfMissing   = $CloneIfMissing
                    workspaceDir     = $Workspace
                    commandTimeoutMs = 30000
                    retry            = [ordered]@{ maxAttempts = 2; backoffMs = 0; maxBackoffMs = 0 }
                }
            }

            # Code-Change-Skripte liegen AUSSERHALB des Repos (kein eigener Diff).
            function writeChangeScript {
                param([string]$Workspace, [string]$Name, [string]$Body)
                $p = Join-Path $Workspace $Name
                [System.IO.File]::WriteAllText($p, $Body)
                return $p
            }

            function remoteHasBranch {
                param([string]$Repo, [string]$Branch)
                $out = & git -C $Repo ls-remote --heads origin $Branch
                return -not [string]::IsNullOrWhiteSpace($out)
            }
        }

        It 'pushes a feature branch when the code change makes a diff' {
            $w = newWorkspace
            $script = writeChangeScript -Workspace $w.Workspace -Name 'change.ps1' -Body "Set-Content -Path 'change.txt' -Value 'changed'"
            $cfg = newConfig -Workspace $w.Workspace -Script $script

            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'pushed'
            $r.CodeChangeOk | Should -BeTrue
            remoteHasBranch -Repo $w.Repo -Branch 'AKB-1-feature/x' | Should -BeTrue
        }

        It 'reports no-changes and deletes the branch when there is no diff' {
            $w = newWorkspace
            $script = writeChangeScript -Workspace $w.Workspace -Name 'noop.ps1' -Body "exit 0"
            $cfg = newConfig -Workspace $w.Workspace -Script $script

            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'no-changes'
            remoteHasBranch -Repo $w.Repo -Branch 'AKB-1-feature/x' | Should -BeFalse
            # Feature-Branch lokal wieder weg, master ausgecheckt.
            (& git -C $w.Repo rev-parse --abbrev-ref HEAD).Trim() | Should -Be 'master'
        }

        It 'skips when the repo is missing and cloneIfMissing is off' {
            $w = newWorkspace
            $script = writeChangeScript -Workspace $w.Workspace -Name 'change.ps1' -Body "Set-Content -Path 'x.txt' -Value '1'"
            $cfg = newConfig -Workspace $w.Workspace -Script $script

            $r = Invoke-GitBulkRu -Config $cfg -Ru 'does-not-exist'
            $r.Outcome | Should -Be 'skipped'
        }

        It 'commits but does not push in dry-run' {
            $w = newWorkspace
            $script = writeChangeScript -Workspace $w.Workspace -Name 'change.ps1' -Body "Set-Content -Path 'change.txt' -Value 'changed'"
            $cfg = newConfig -Workspace $w.Workspace -Script $script -DryRun $true

            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'committed'
            remoteHasBranch -Repo $w.Repo -Branch 'AKB-1-feature/x' | Should -BeFalse
        }

        It 'commits "ERROR WHILE CODE CHANGE" when the script fails but changes files' {
            $w = newWorkspace
            $script = writeChangeScript -Workspace $w.Workspace -Name 'fail.ps1' -Body "Set-Content -Path 'change.txt' -Value 'x'; exit 1"
            $cfg = newConfig -Workspace $w.Workspace -Script $script

            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'pushed'
            $r.CodeChangeOk | Should -BeFalse
            (& git -C $w.Repo log -1 --format=%s).Trim() | Should -Be 'ERROR WHILE CODE CHANGE'
        }
    }
}

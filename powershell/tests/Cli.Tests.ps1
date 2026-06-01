#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# End-to-End-Tests für die CLI Invoke-GitBulk (Config laden → Lauf → Report → Exit-Code).
# Dry-Run, damit kein echter Push/PR nötig ist. Echte temporäre Git-Repos.

# Top-Level-Import: InModuleScope (Write-GitBulkSummary unten) braucht das Modul
# bereits in der Pester-Discovery-Phase, die vor BeforeAll läuft.
Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

BeforeAll {
    function script:newCliWorkspace {
        $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-cli-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
        param([string]$Workspace, [string[]]$Rus, [string]$Script)
        $cfg = @{
            rus = $Rus; ticket = 'AKB-1'; branch = 'feature/x'; sourceBranch = 'master'
            script = $Script; commitMessage = 'test commit'; prSummary = 'summary'
            createPrOnError = $false; dryRun = $true; workspaceDir = $Workspace; concurrency = 1
            prPlatform = 'github'; github = @{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
        }
        $path = Join-Path $Workspace 'gitbulk.config.json'
        $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $path
        return $path
    }
}

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-cli-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-GitBulk' {
    It 'runs end-to-end from a JSON config in dry-run and returns exit code 0' {
        $ws = newCliWorkspace
        addRepo -Workspace $ws -Ru 'repo-a'
        $script = Join-Path $ws 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a') -Script $script

        $code = Invoke-GitBulk -ConfigPath $cfgFile -NoColor
        $code | Should -Be 0
    }

    It 'returns 3 on a config error (missing file)' {
        $code = Invoke-GitBulk -ConfigPath (Join-Path ([System.IO.Path]::GetTempPath()) 'does-not-exist-xyz.json') -NoColor -ErrorAction SilentlyContinue
        $code | Should -Be 3
    }

    It 'returns 3 for an unknown --only RU' {
        $ws = newCliWorkspace
        addRepo -Workspace $ws -Ru 'repo-a'
        $script = Join-Path $ws 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a') -Script $script

        $code = Invoke-GitBulk -ConfigPath $cfgFile -Only 'ghost' -NoColor -ErrorAction SilentlyContinue
        $code | Should -Be 3
    }

    It 'honors --only and processes just the selected RU' {
        $ws = newCliWorkspace
        addRepo -Workspace $ws -Ru 'repo-a'
        addRepo -Workspace $ws -Ru 'repo-b'
        $script = Join-Path $ws 'change.ps1'
        [System.IO.File]::WriteAllText($script, "Set-Content -Path 'change.txt' -Value 'changed'")
        $cfgFile = writeConfigFile -Workspace $ws -Rus @('repo-a', 'repo-b') -Script $script

        # Kein Throw, Exit 0 (dry-run). Die Filter-Wirkung selbst ist in filterRus-Logik
        # abgedeckt; hier zählt, dass --only akzeptiert wird und der Lauf sauber endet.
        $code = Invoke-GitBulk -ConfigPath $cfgFile -Only 'repo-a' -NoColor
        $code | Should -Be 0
    }
}

InModuleScope GitBulk {
    Describe 'Write-GitBulkSummary' {
        It 'prints per-RU lines and totals without throwing' {
            $summary = [pscustomobject]@{
                Results   = @(
                    [pscustomobject]@{ Ru = 'repo-a'; Outcome = 'pr-created'; PrUrl = 'http://pr/1'; Message = ''; Error = $null }
                    [pscustomobject]@{ Ru = 'repo-b'; Outcome = 'skipped'; PrUrl = $null; Message = 'not found'; Error = $null }
                )
                Total     = 2; PrCreated = 1; PrFailed = 0; Pushed = 0; Committed = 0
                NoChanges = 0; Skipped = 1; Fatal = 0
            }
            $out = Write-GitBulkSummary -Summary $summary -NoColor 6>&1 | Out-String
            $out | Should -Match 'repo-a'
            $out | Should -Match 'Total: 2 RUs'
        }
    }
}

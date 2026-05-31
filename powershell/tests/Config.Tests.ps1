#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force
    $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('gitbulk-cfg-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:tmp | Out-Null

    # Helfer im Script-Scope definieren, damit er in den It-Blöcken sichtbar ist
    # (Pester v5 trennt Discovery- und Run-Scope). Bewusst ohne Bindestrich,
    # damit PSScriptAnalyzer keine Verb-Noun-Regeln erzwingt. Liefert bei jedem
    # Aufruf eine frische, gültige Roh-Config (operations-Variante).
    function script:NewValidRawConfig {
        @{
            rus             = @('repo-a', 'repo-b')
            ticket          = 'akb-1234'
            branch          = 'feature/x'
            operations      = @(@{ type = 'delete-file'; path = 'x.txt' })
            commitMessage   = 'a commit message'
            prSummary       = 'a pr summary'
            createPrOnError = $false
            prPlatform      = 'bitbucket'
            bitbucket       = @{ workspace = 'my-ws' }
        }
    }
}

AfterAll {
    Remove-Module GitBulk -Force -ErrorAction SilentlyContinue
    if ($script:tmp -and (Test-Path $script:tmp)) {
        Remove-Item $script:tmp -Recurse -Force
    }
}

Describe 'Get-GitBulkConfig validation' {
    It 'accepts a minimal operations config and applies defaults' {
        $cfg = Get-GitBulkConfig -InputObject (NewValidRawConfig)
        $cfg.rus | Should -Be @('repo-a', 'repo-b')
        $cfg.ticket | Should -Be 'AKB-1234'           # getrimmt + uppercased
        $cfg.sourceBranch | Should -Be 'master'
        $cfg.concurrency | Should -Be 1
        $cfg.commandTimeoutMs | Should -Be 120000
        $cfg.dryRun | Should -BeFalse
        $cfg.retry.maxAttempts | Should -Be 3
        $cfg.bitbucket.apiVariant | Should -Be 'cloud'
        $cfg.bitbucket.targetBranch | Should -Be 'master'
    }

    It 'rejects a config missing required fields' {
        { Get-GitBulkConfig -InputObject @{ prPlatform = 'bitbucket'; bitbucket = @{ workspace = 'ws' } } } |
            Should -Throw
    }

    It 'rejects when both script and operations are set' {
        $c = NewValidRawConfig
        $c.script = 'whatever.ps1'
        { Get-GitBulkConfig -InputObject $c } | Should -Throw '*either*'
    }

    It 'rejects when neither script nor operations are set' {
        $c = NewValidRawConfig
        $c.Remove('operations')
        { Get-GitBulkConfig -InputObject $c } | Should -Throw '*one of*'
    }

    It 'rejects an invalid ticket format' {
        $c = NewValidRawConfig
        $c.ticket = 'bad ticket!'
        { Get-GitBulkConfig -InputObject $c } | Should -Throw '*ticket*'
    }

    It 'requires the github block when prPlatform is github' {
        $c = NewValidRawConfig
        $c.Remove('bitbucket')
        $c.prPlatform = 'github'
        { Get-GitBulkConfig -InputObject $c } | Should -Throw '*github*'
    }

    It 'accepts a github config and defaults targetBranch to main' {
        $c = NewValidRawConfig
        $c.Remove('bitbucket')
        $c.prPlatform = 'github'
        $c.github = @{ owner = 'my-org' }
        $cfg = Get-GitBulkConfig -InputObject $c
        $cfg.github.targetBranch | Should -Be 'main'
        $cfg.github.owner | Should -Be 'my-org'
    }

    It 'rejects a missing script file' {
        $c = NewValidRawConfig
        $c.Remove('operations')
        $c.script = 'does-not-exist.ps1'
        { Get-GitBulkConfig -InputObject $c -BaseDir $script:tmp } | Should -Throw '*File not found*'
    }

    It 'accepts an existing script file' {
        $c = NewValidRawConfig
        $c.Remove('operations')
        Set-Content -Path (Join-Path $script:tmp 'change.ps1') -Value '# noop'
        $c.script = 'change.ps1'
        $cfg = Get-GitBulkConfig -InputObject $c -BaseDir $script:tmp
        $cfg.script | Should -Match 'change\.ps1$'
    }

    It 'rejects out-of-range concurrency' {
        $c = NewValidRawConfig
        $c.concurrency = 999
        { Get-GitBulkConfig -InputObject $c } | Should -Throw '*concurrency*'
    }
}

Describe 'Get-GitBulkConfig file loading' {
    It 'loads a JSON config file' {
        $f = Join-Path $script:tmp 'cfg.json'
        NewValidRawConfig | ConvertTo-Json -Depth 6 | Set-Content -Path $f
        $cfg = Get-GitBulkConfig -Path $f
        $cfg.ticket | Should -Be 'AKB-1234'
        $cfg.rus | Should -Contain 'repo-a'
    }

    It 'loads a YAML config file' {
        Import-Module powershell-yaml -ErrorAction Stop
        $f = Join-Path $script:tmp 'cfg.yaml'
        NewValidRawConfig | ConvertTo-Yaml | Set-Content -Path $f
        $cfg = Get-GitBulkConfig -Path $f
        $cfg.ticket | Should -Be 'AKB-1234'
        $cfg.rus | Should -Contain 'repo-a'
    }

    It 'throws on an unsupported file extension' {
        $f = Join-Path $script:tmp 'cfg.txt'
        Set-Content -Path $f -Value 'nope'
        { Get-GitBulkConfig -Path $f } | Should -Throw '*Unsupported*'
    }
}

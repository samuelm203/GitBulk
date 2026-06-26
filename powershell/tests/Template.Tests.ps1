#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für `gitbulk template` (PowerShell-Port): New-GitBulkTemplate (reiner
# Generator, Round-Trip durch Get-GitBulkConfig) und Invoke-GitBulkTemplate
# (Datei-Schreiben + Überschreib-Schutz). Tokens dürfen NIE in der Vorlage stehen.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force
    $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('gb-tpl-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:tmp | Out-Null
}

AfterAll {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:tmp
}

Describe 'New-GitBulkTemplate' {
    It 'defaults to the full template' {
        $a = New-GitBulkTemplate
        $b = New-GitBulkTemplate -Kind full
        $a | Should -Be $b
    }

    It 'never leaks a token value' {
        foreach ($kind in @('full', 'minimal')) {
            $text = New-GitBulkTemplate -Kind $kind
            # Kein echtes `token:`-Feld mit Wert (Env-Var-Namen im Kommentar sind ok).
            $text | Should -Not -Match '(?im)^\s*token\s*:\s*\S'
        }
    }

    It 'the minimal template round-trips through Get-GitBulkConfig' {
        $file = Join-Path $script:tmp 'minimal.yaml'
        [System.IO.File]::WriteAllText($file, (New-GitBulkTemplate -Kind minimal))

        $cfg = Get-GitBulkConfig -Path $file
        $cfg.rus | Should -Be @('my-repo')
        $cfg.ticket | Should -Be 'AKB-1234'
        $cfg.branch | Should -Be 'feature/my-change'
        $cfg.prPlatform | Should -Be 'bitbucket'
        $cfg.bitbucket.workspace | Should -Be 'my-workspace'
        $cfg.operations[0]['type'] | Should -Be 'regex-replace'
    }

    It 'the full template round-trips and carries the optional fields' {
        $file = Join-Path $script:tmp 'full.yaml'
        $text = New-GitBulkTemplate -Kind full
        [System.IO.File]::WriteAllText($file, $text)

        $cfg = Get-GitBulkConfig -Path $file
        $cfg.rus | Should -Be @('my-repo', 'another-repo')
        $cfg.prPlatform | Should -Be 'bitbucket'
        $cfg.bitbucket.apiVariant | Should -Be 'cloud'
        # Optionale Felder, die die minimale Vorlage NICHT enthält:
        $text | Should -Match '(?m)^retry:'
        $text | Should -Match '(?m)^concurrency:'
        $text | Should -Match '(?m)^sourceBranch:'
    }
}

Describe 'Invoke-GitBulkTemplate' {
    It 'writes the template to a file and returns exit code 0' {
        $f = Join-Path $script:tmp 'out1.yaml'
        $code = Invoke-GitBulkTemplate -Kind minimal -OutputPath $f -NoColor
        $code | Should -Be 0
        Test-Path -LiteralPath $f | Should -BeTrue
        (Get-Content -Raw -LiteralPath $f) | Should -Match 'rus:'
    }

    It 'refuses to overwrite an existing file without -Force (exit 3)' {
        $f = Join-Path $script:tmp 'out2.yaml'
        [System.IO.File]::WriteAllText($f, 'KEEP')
        $code = Invoke-GitBulkTemplate -Kind full -OutputPath $f -NoColor
        $code | Should -Be 3
        (Get-Content -Raw -LiteralPath $f) | Should -Match 'KEEP'
    }

    It 'overwrites with -Force (exit 0)' {
        $f = Join-Path $script:tmp 'out3.yaml'
        [System.IO.File]::WriteAllText($f, 'KEEP')
        $code = Invoke-GitBulkTemplate -Kind full -OutputPath $f -Force -NoColor
        $code | Should -Be 0
        (Get-Content -Raw -LiteralPath $f) | Should -Not -Match 'KEEP'
        (Get-Content -Raw -LiteralPath $f) | Should -Match 'prPlatform: bitbucket'
    }
}

#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für `gitbulk auth` (PowerShell-Port): Credential-Store, Token-Auflösung
# (env > store > prompt) und das Invoke-GitBulkAuth-Subkommando. Der Store wird
# über GITBULK_HOME in ein temporäres Verzeichnis umgelenkt; echte Terminal-
# Eingabe (Read-GitBulkSecret) wird gemockt. Tokens werden NIE ausgegeben.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

BeforeAll {
    $script:origHome = [Environment]::GetEnvironmentVariable('GITBULK_HOME')
    $script:origBb = [Environment]::GetEnvironmentVariable('GITBULK_BITBUCKET_TOKEN')
    $script:origGh = [Environment]::GetEnvironmentVariable('GITBULK_GITHUB_TOKEN')
}

AfterAll {
    function script:restoreEnv([string]$Name, [string]$Value) {
        if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
        else { Set-Item "Env:$Name" -Value $Value }
    }
    restoreEnv 'GITBULK_HOME' $script:origHome
    restoreEnv 'GITBULK_BITBUCKET_TOKEN' $script:origBb
    restoreEnv 'GITBULK_GITHUB_TOKEN' $script:origGh
}

Describe 'gitbulk auth' {
    BeforeEach {
        $script:store = Join-Path ([System.IO.Path]::GetTempPath()) ('gb-auth-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:store | Out-Null
        $env:GITBULK_HOME = $script:store
        Remove-Item Env:GITBULK_BITBUCKET_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:GITBULK_GITHUB_TOKEN -ErrorAction SilentlyContinue
    }

    AfterEach {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:store
    }

    Context 'Credential store' {
    It 'stores, reads and lists a token' {
        InModuleScope GitBulk {
            $path = Set-GitBulkStoredToken -Platform github -Token 'tok-123'
            $path | Should -Match 'credentials\.json'
            Get-GitBulkStoredToken -Platform github | Should -Be 'tok-123'
            Get-GitBulkStoredPlatform | Should -Contain 'github'
            Get-GitBulkStoredToken -Platform bitbucket | Should -BeNullOrEmpty
        }
    }

    It 'removes a single token and deletes the file when empty' {
        InModuleScope GitBulk {
            Set-GitBulkStoredToken -Platform github -Token 'x' | Out-Null
            (Remove-GitBulkStoredToken -Platform github) | Should -BeTrue
            Get-GitBulkStoredToken -Platform github | Should -BeNullOrEmpty
            Test-Path -LiteralPath (Get-GitBulkCredentialPath) | Should -BeFalse
        }
    }

    It 'keeps the other platform when removing one' {
        InModuleScope GitBulk {
            Set-GitBulkStoredToken -Platform github -Token 'g' | Out-Null
            Set-GitBulkStoredToken -Platform bitbucket -Token 'b' | Out-Null
            Remove-GitBulkStoredToken -Platform github | Out-Null
            Get-GitBulkStoredToken -Platform github | Should -BeNullOrEmpty
            Get-GitBulkStoredToken -Platform bitbucket | Should -Be 'b'
        }
    }

    It 'tolerates a corrupt store file' {
        InModuleScope GitBulk {
            [System.IO.File]::WriteAllText((Get-GitBulkCredentialPath), 'not json {{{')
            Get-GitBulkStoredToken -Platform github | Should -BeNullOrEmpty
        }
    }
}

    Context 'Resolve-GitBulkToken' {
    It 'treats the env var as authoritative' {
        InModuleScope GitBulk {
            $env:GITBULK_GITHUB_TOKEN = 'from-env'
            Set-GitBulkStoredToken -Platform github -Token 'from-store' | Out-Null
            (Resolve-GitBulkToken -Platform github).Ok | Should -BeTrue
            $env:GITBULK_GITHUB_TOKEN | Should -Be 'from-env'
        }
    }

    It 'falls back to the stored token and exports it to the env' {
        InModuleScope GitBulk {
            Set-GitBulkStoredToken -Platform github -Token 'from-store' | Out-Null
            $r = Resolve-GitBulkToken -Platform github
            $r.Ok | Should -BeTrue
            $env:GITBULK_GITHUB_TOKEN | Should -Be 'from-store'
        }
    }

    It 'fails non-interactively when no token is available (not dry-run)' {
        InModuleScope GitBulk {
            $r = Resolve-GitBulkToken -Platform github
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_GITHUB_TOKEN'
        }
    }

    It 'requires no token in dry-run' {
        InModuleScope GitBulk {
            (Resolve-GitBulkToken -Platform github -DryRun).Ok | Should -BeTrue
        }
    }

    It 'requires a token for azure-devops like any other platform' {
        InModuleScope GitBulk {
            $r = Resolve-GitBulkToken -Platform azure-devops
            $r.Ok | Should -BeFalse
            $r.Error | Should -Match 'GITBULK_AZURE_DEVOPS_TOKEN'
        }
    }
}

    Context 'Invoke-GitBulkAuth' {
    It 'login stores the (masked) token and returns 0' {
        InModuleScope GitBulk {
            Mock Read-GitBulkSecret { 'secret-xyz' }
            $code = Invoke-GitBulkAuth -Action login -Platform github -Interactive -NoColor
            $code | Should -Be 0
            Get-GitBulkStoredToken -Platform github | Should -Be 'secret-xyz'
        }
    }

    It 'login without -Platform fails with exit 3' {
        $code = Invoke-GitBulkAuth -Action login -Interactive -NoColor
        $code | Should -Be 3
    }

    It 'login refuses without a terminal (exit 3)' {
        $code = Invoke-GitBulkAuth -Action login -Platform github -NoColor
        $code | Should -Be 3
    }

    It 'logout removes a stored token' {
        InModuleScope GitBulk { Set-GitBulkStoredToken -Platform github -Token 'g' | Out-Null }
        $code = Invoke-GitBulkAuth -Action logout -Platform github -NoColor
        $code | Should -Be 0
        InModuleScope GitBulk { Get-GitBulkStoredToken -Platform github | Should -BeNullOrEmpty }
    }

    It 'status returns 0 and reports env precedence' {
        $env:GITBULK_GITHUB_TOKEN = 'live'
        $out = Invoke-GitBulkAuth -Action status -NoColor 6>&1 | Out-String
        $out | Should -Match 'Resolution order: env var'
        $out | Should -Match 'github.*env:yes'
        # Der Token-Wert darf NIE in der Ausgabe stehen.
        $out | Should -Not -Match 'live'
    }
    }
}

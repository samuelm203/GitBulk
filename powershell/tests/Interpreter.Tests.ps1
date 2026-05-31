#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für die private Interpreter-Wahl Resolve-Interpreter (InModuleScope).

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-interp-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Resolve-Interpreter' {
        It 'maps .bat/.cmd to cmd.exe /c' {
            foreach ($ext in '.bat', '.cmd') {
                $r = Resolve-Interpreter -ScriptPath "script$ext"
                $r.Command | Should -Be 'cmd.exe'
                $r.PrefixArgs | Should -Contain '/c'
            }
        }

        It 'maps .ps1 to pwsh -File' {
            $r = Resolve-Interpreter -ScriptPath 'script.ps1'
            $r.Command | Should -Be 'pwsh'
            $r.PrefixArgs | Should -Contain '-File'
        }

        It 'maps .js/.mjs/.cjs to node' {
            foreach ($ext in '.js', '.mjs', '.cjs') {
                (Resolve-Interpreter -ScriptPath "script$ext").Command | Should -Be 'node'
            }
        }

        It 'maps .sh/.bash without prefix args' {
            foreach ($ext in '.sh', '.bash') {
                (Resolve-Interpreter -ScriptPath "script$ext").PrefixArgs.Count | Should -Be 0
            }
        }

        It 'marks an unknown extension for self-execution' {
            $r = Resolve-Interpreter -ScriptPath '/usr/local/bin/mytool'
            $r.Command | Should -Be '/usr/local/bin/mytool'
            $r.PrefixArgs | Should -Contain '__SELF__'
        }

        It 'uses tsx for .ts when tsx is resolvable from the cwd' {
            # Künstliches node_modules/tsx im cwd → deterministisch, node-versionsunabhängig.
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-interp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path (Join-Path $tmp 'node_modules' 'tsx') -Force | Out-Null
            foreach ($ext in '.ts', '.mts', '.cts') {
                $r = Resolve-Interpreter -ScriptPath "script$ext" -Cwd $tmp
                $r.Command | Should -Be 'node'
                $r.PrefixArgs | Should -Contain '--import'
                $r.PrefixArgs | Should -Contain 'tsx'
            }
        }
    }

    Describe 'Test-TsxAvailable' {
        It 'is false in a directory without node_modules/tsx' {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-interp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $tmp -Force | Out-Null
            Test-TsxAvailable -Cwd $tmp | Should -BeFalse
        }

        It 'finds tsx in a parent directory' {
            $root = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-interp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path (Join-Path $root 'node_modules' 'tsx') -Force | Out-Null
            $nested = Join-Path $root 'a' 'b'
            New-Item -ItemType Directory -Path $nested -Force | Out-Null
            Test-TsxAvailable -Cwd $nested | Should -BeTrue
        }
    }
}

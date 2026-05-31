#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den privaten Git-Executor Invoke-Git. Da die Funktion nicht
# exportiert wird, laufen die Tests via InModuleScope. Das Modul wird daher
# bereits auf Datei-Ebene importiert (InModuleScope braucht es schon in der
# Pester-Discovery-Phase, die vor BeforeAll läuft). Genutzt werden echte
# temporäre Git-Repositories (kein Netzwerk).

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-exec-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Invoke-Git' {
        BeforeAll {
            # Test-Helper bewusst ohne Verb-Noun-Form, damit die Cmdlet-Regeln
            # (ApprovedVerbs / ShouldProcess) nicht auf Test-Fixtures anschlagen.
            function newTestRepo {
                $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-exec-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $dir | Out-Null
                & git -C $dir init -q --initial-branch=master
                & git -C $dir config user.email 'test@example.com'
                & git -C $dir config user.name 'Test User'
                [System.IO.File]::WriteAllText((Join-Path $dir 'README.md'), "init`n")
                & git -C $dir add -A
                & git -C $dir commit -q -m 'init'
                return $dir
            }

            function setPreCommitHook {
                param([string]$Repo, [string]$Body)
                $hook = Join-Path $Repo '.git' 'hooks' 'pre-commit'
                [System.IO.File]::WriteAllText($hook, "#!/bin/sh`n$Body`n")
                if (-not $IsWindows) { & chmod '+x' $hook }
            }
        }

        It 'runs git --version and returns exit code 0' {
            $r = Invoke-Git -Arguments @('--version') -Cwd (Get-Location).Path -TimeoutMs 5000
            $r.ExitCode | Should -Be 0
            $r.Stdout | Should -Match 'git version'
            $r.TimedOut | Should -BeFalse
        }

        It 'runs in the given working directory' {
            $repo = newTestRepo
            $r = Invoke-Git -Arguments @('rev-parse', '--is-inside-work-tree') -Cwd $repo -TimeoutMs 5000
            $r.ExitCode | Should -Be 0
            $r.Stdout.Trim() | Should -Be 'true'
        }

        It 'captures stdout (porcelain status)' {
            $repo = newTestRepo
            [System.IO.File]::WriteAllText((Join-Path $repo 'new.txt'), 'x')
            $r = Invoke-Git -Arguments @('status', '--porcelain') -Cwd $repo -TimeoutMs 5000
            $r.Stdout | Should -Match 'new\.txt'
        }

        It 'returns non-zero without throwing for an unknown subcommand' {
            $repo = newTestRepo
            $r = Invoke-Git -Arguments @('checkout', 'no-such-branch-xyz') -Cwd $repo -TimeoutMs 5000
            $r.ExitCode | Should -Not -Be 0
            $r.Stderr.Length | Should -BeGreaterThan 0
        }

        It 'does not execute anything in dry-run' {
            $repo = newTestRepo
            # Ein sonst fehlschlagender Befehl liefert im Dry-Run trotzdem Erfolg.
            $r = Invoke-Git -Arguments @('checkout', 'no-such-branch-xyz') -Cwd $repo -TimeoutMs 5000 -DryRun
            $r.ExitCode | Should -Be 0
            $r.TimedOut | Should -BeFalse
        }

        It 'bypasses hooks with -SkipHooks' {
            $repo = newTestRepo
            setPreCommitHook -Repo $repo -Body 'exit 1'
            [System.IO.File]::WriteAllText((Join-Path $repo 'a.txt'), '1')
            Invoke-Git -Arguments @('add', '-A') -Cwd $repo -TimeoutMs 5000 | Out-Null

            $withHooks = Invoke-Git -Arguments @('commit', '-m', 'try') -Cwd $repo -TimeoutMs 5000
            $withHooks.ExitCode | Should -Not -Be 0

            $skipped = Invoke-Git -Arguments @('commit', '-m', 'skip') -Cwd $repo -TimeoutMs 5000 -SkipHooks
            $skipped.ExitCode | Should -Be 0
        }

        It 'times out and kills a hanging process (sleeping pre-commit hook)' {
            $repo = newTestRepo
            setPreCommitHook -Repo $repo -Body 'sleep 30'
            [System.IO.File]::WriteAllText((Join-Path $repo 'change.txt'), 'pending')
            Invoke-Git -Arguments @('add', '-A') -Cwd $repo -TimeoutMs 5000 | Out-Null

            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-Git -Arguments @('commit', '-m', 'trigger hook') -Cwd $repo -TimeoutMs 800
            $sw.Stop()

            $r.TimedOut | Should -BeTrue
            $sw.ElapsedMilliseconds | Should -BeLessThan 12000
        }
    }
}

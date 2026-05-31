#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für Invoke-CodeChange (InModuleScope). Genutzt werden .ps1-Skripte, da
# pwsh garantiert vorhanden ist (wir laufen darin) — kein node nötig.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-cc-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Invoke-CodeChange' {
        BeforeAll {
            function newRepoDir {
                $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-cc-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $dir | Out-Null
                return $dir
            }
            function writeScript {
                param([string]$Repo, [string]$Name, [string]$Body)
                $path = Join-Path $Repo $Name
                [System.IO.File]::WriteAllText($path, $Body)
                return $path
            }
        }

        It 'runs a .ps1 script with the repo as working directory' {
            $repo = newRepoDir
            $script = writeScript -Repo $repo -Name 'change.ps1' -Body "Set-Content -Path 'out.txt' -Value 'done'"
            $r = Invoke-CodeChange -ScriptPath $script -Cwd $repo -TimeoutMs 20000
            $r.ExitCode | Should -Be 0
            (Get-Content (Join-Path $repo 'out.txt')) | Should -Be 'done'
        }

        It 'exposes the GITBULK_* environment variables to the script' {
            $repo = newRepoDir
            $body = "Set-Content -Path 'env.txt' -Value `"`$env:GITBULK_RU|`$env:GITBULK_TICKET|`$env:GITBULK_BRANCH|`$env:GITBULK_SOURCE_BRANCH`""
            $script = writeScript -Repo $repo -Name 'change.ps1' -Body $body
            $r = Invoke-CodeChange -ScriptPath $script -Cwd $repo -TimeoutMs 20000 -Context @{
                Ru = 'repo-a'; Ticket = 'AKB-1'; Branch = 'AKB-1-x'; SourceBranch = 'master'
            }
            $r.ExitCode | Should -Be 0
            (Get-Content (Join-Path $repo 'env.txt')) | Should -Be 'repo-a|AKB-1|AKB-1-x|master'
        }

        It 'returns the script exit code without throwing' {
            $repo = newRepoDir
            $script = writeScript -Repo $repo -Name 'fail.ps1' -Body "exit 3"
            $r = Invoke-CodeChange -ScriptPath $script -Cwd $repo -TimeoutMs 20000
            $r.ExitCode | Should -Be 3
            $r.TimedOut | Should -BeFalse
        }

        It 'times out and kills a hanging script' {
            $repo = newRepoDir
            $script = writeScript -Repo $repo -Name 'hang.ps1' -Body "Start-Sleep -Seconds 30"
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-CodeChange -ScriptPath $script -Cwd $repo -TimeoutMs 800
            $sw.Stop()
            $r.TimedOut | Should -BeTrue
            $sw.ElapsedMilliseconds | Should -BeLessThan 12000
        }
    }
}

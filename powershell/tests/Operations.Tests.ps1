#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für das Operations-Fundament (Registry, Pfad-Sicherheit, die vier
# Datei-Operationen) und ihre Integration in den per-RU-Flow Invoke-GitBulkRu.
# Alles InModuleScope, da die Funktionen privat sind.

# Top-Level-Import: InModuleScope wird in der Pester-Discovery-Phase (vor
# BeforeAll) ausgewertet und braucht das Modul bereits geladen.
Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-ops-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'Operations foundation' {
        BeforeAll {
            function newRepoDir {
                $d = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-ops-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $d | Out-Null
                return $d
            }
            function applyOp {
                param([string]$Type, [hashtable]$Params, [string]$RepoDir)
                $op = Get-GitBulkOperation -Type $Type
                $ctx = @{ RepoDir = $RepoDir; Ru = 'r'; Ticket = 't'; Branch = 'b'; SourceBranch = 's' }
                return Invoke-GitBulkOperation -Operation $op -Params $Params -Context $ctx
            }
            function readText { param([string]$Path) [System.IO.File]::ReadAllText($Path) }
            function writeText { param([string]$Path, [string]$Text) [System.IO.File]::WriteAllText($Path, $Text) }
        }

        Context 'Resolve-InRepoPath' {
            It 'resolves a relative path inside the repo' {
                $root = newRepoDir
                $r = Resolve-InRepoPath -RepoDir $root -RelativePath 'src/a.txt'
                $r.Ok | Should -BeTrue
                $r.Path | Should -Match 'a\.txt$'
            }
            It 'rejects an absolute path' {
                $root = newRepoDir
                $r = Resolve-InRepoPath -RepoDir $root -RelativePath ([System.IO.Path]::GetTempPath())
                $r.Ok | Should -BeFalse
                $r.Error | Should -Match 'absolute'
            }
            It 'rejects a path that escapes the repo via ..' {
                $root = newRepoDir
                $r = Resolve-InRepoPath -RepoDir $root -RelativePath '../evil.txt'
                $r.Ok | Should -BeFalse
                $r.Error | Should -Match 'escapes'
            }
            It 'allows .. that normalizes back inside the repo' {
                $root = newRepoDir
                $r = Resolve-InRepoPath -RepoDir $root -RelativePath 'sub/../a.txt'
                $r.Ok | Should -BeTrue
            }
        }

        Context 'registry' {
            It 'returns each registered file operation' {
                foreach ($t in 'add-file', 'replace-file', 'delete-file', 'regex-replace') {
                    (Get-GitBulkOperation -Type $t).Type | Should -Be $t
                }
            }
            It 'returns $null for an unknown type' {
                Get-GitBulkOperation -Type 'no-such-op' | Should -BeNullOrEmpty
            }
            It 'lists operations sorted by type' {
                $types = (Get-GitBulkOperationList).Type
                $types | Should -Contain 'add-file'
                $types | Should -Contain 'regex-replace'
                ($types -join ',') | Should -Be (($types | Sort-Object) -join ',')
            }
        }

        Context 'add-file' {
            It 'creates a new file (incl. nested directories)' {
                $root = newRepoDir
                $res = applyOp -Type 'add-file' -Params @{ path = 'a/b/c.txt'; content = 'hello' } -RepoDir $root
                $res.Changed | Should -BeTrue
                readText (Join-Path $root 'a/b/c.txt') | Should -Be 'hello'
            }
            It 'is idempotent when the content already matches' {
                $root = newRepoDir
                applyOp -Type 'add-file' -Params @{ path = 'x.txt'; content = 'v1' } -RepoDir $root | Out-Null
                $res = applyOp -Type 'add-file' -Params @{ path = 'x.txt'; content = 'v1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already up to date'
            }
            It 'skips an existing file with different content unless overwrite is set' {
                $root = newRepoDir
                writeText (Join-Path $root 'x.txt') 'old'
                $res = applyOp -Type 'add-file' -Params @{ path = 'x.txt'; content = 'new' } -RepoDir $root
                $res.Changed | Should -BeFalse
                readText (Join-Path $root 'x.txt') | Should -Be 'old'
            }
            It 'overwrites an existing file when overwrite is true' {
                $root = newRepoDir
                writeText (Join-Path $root 'x.txt') 'old'
                $res = applyOp -Type 'add-file' -Params @{ path = 'x.txt'; content = 'new'; overwrite = $true } -RepoDir $root
                $res.Changed | Should -BeTrue
                readText (Join-Path $root 'x.txt') | Should -Be 'new'
            }
            It 'errors on a path outside the repo' {
                $root = newRepoDir
                $res = applyOp -Type 'add-file' -Params @{ path = '../escape.txt'; content = 'x' } -RepoDir $root
                $res.Error | Should -Match 'escapes'
            }
        }

        Context 'replace-file' {
            It 'skips when the file is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'replace-file' -Params @{ path = 'gone.txt'; content = 'x' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No gone.txt found'
            }
            It 'replaces the content of an existing file' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'before'
                $res = applyOp -Type 'replace-file' -Params @{ path = 'f.txt'; content = 'after' } -RepoDir $root
                $res.Changed | Should -BeTrue
                readText (Join-Path $root 'f.txt') | Should -Be 'after'
            }
            It 'is idempotent when content already matches' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'same'
                $res = applyOp -Type 'replace-file' -Params @{ path = 'f.txt'; content = 'same' } -RepoDir $root
                $res.Changed | Should -BeFalse
            }
        }

        Context 'delete-file' {
            It 'deletes an existing file' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'x'
                $res = applyOp -Type 'delete-file' -Params @{ path = 'f.txt' } -RepoDir $root
                $res.Changed | Should -BeTrue
                Test-Path -LiteralPath (Join-Path $root 'f.txt') | Should -BeFalse
            }
            It 'is a no-op when the file is already gone' {
                $root = newRepoDir
                $res = applyOp -Type 'delete-file' -Params @{ path = 'gone.txt' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Error | Should -BeNullOrEmpty
            }
            It 'refuses to delete a directory' {
                $root = newRepoDir
                New-Item -ItemType Directory -Path (Join-Path $root 'adir') | Out-Null
                $res = applyOp -Type 'delete-file' -Params @{ path = 'adir' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Error | Should -Match 'directory'
            }
        }

        Context 'regex-replace' {
            It 'replaces all matches by default (global)' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'a a a'
                $res = applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = 'a'; replacement = 'b' } -RepoDir $root
                $res.Changed | Should -BeTrue
                readText (Join-Path $root 'f.txt') | Should -Be 'b b b'
            }
            It 'skips when there is no match' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'hello'
                $res = applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = 'zzz'; replacement = 'q' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Error | Should -BeNullOrEmpty
            }
            It 'errors on no match when requireMatch is true' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'hello'
                $res = applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = 'zzz'; replacement = 'q'; requireMatch = $true } -RepoDir $root
                $res.Error | Should -Match 'did not match'
            }
            It 'errors on an invalid pattern' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'hello'
                $res = applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = '('; replacement = 'q' } -RepoDir $root
                $res.Error | Should -Match 'invalid regex'
            }
            It 'is idempotent after the replacement took effect' {
                $root = newRepoDir
                writeText (Join-Path $root 'f.txt') 'foo'
                applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = 'foo'; replacement = 'bar' } -RepoDir $root | Out-Null
                $res = applyOp -Type 'regex-replace' -Params @{ path = 'f.txt'; pattern = 'foo'; replacement = 'bar' } -RepoDir $root
                $res.Changed | Should -BeFalse
            }
        }

        Context 'Invoke-GitBulkOperation normalization' {
            It 'captures a thrown error as a failed result' {
                $throwing = @{ Type = 'boom'; Apply = { throw 'kaboom' } }
                $res = Invoke-GitBulkOperation -Operation $throwing -Params @{} -Context @{ RepoDir = 'x' }
                $res.Changed | Should -BeFalse
                $res.Error | Should -Be 'kaboom'
            }
        }
    }

    Describe 'Invoke-GitBulkRu with operations' {
        BeforeAll {
            function newWorkspace {
                param([string]$Ru = 'repo-a')
                $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-ops-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
            function newOpsConfig {
                param([string]$Workspace, [object[]]$Operations, [bool]$DryRun = $true)
                return [ordered]@{
                    ticket           = 'AKB-1'
                    branch           = 'feature/x'
                    sourceBranch     = 'master'
                    operations       = $Operations
                    commitMessage    = 'test commit'
                    prSummary        = 'summary'
                    prPlatform       = 'github'
                    github           = [ordered]@{ owner = 'o'; targetBranch = 'main'; reviewers = @() }
                    createPrOnError  = $false
                    dryRun           = $DryRun
                    skipHooks        = $false
                    cloneIfMissing   = $false
                    workspaceDir     = $Workspace
                    commandTimeoutMs = 30000
                    retry            = [ordered]@{ maxAttempts = 2; backoffMs = 0; maxBackoffMs = 0 }
                }
            }
        }

        It 'runs an operations chain end-to-end and commits in dry-run' {
            $w = newWorkspace
            $cfg = newOpsConfig -Workspace $w.Workspace -Operations @(
                @{ type = 'add-file'; path = 'new.txt'; content = 'hello from operations' }
            )
            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'committed'
            $r.CodeChangeOk | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $w.Repo 'new.txt') | Should -BeTrue
            (& git -C $w.Repo log -1 --format=%s).Trim() | Should -Be 'test commit'
        }

        It 'reports no-changes when no operation produces a diff' {
            $w = newWorkspace
            $cfg = newOpsConfig -Workspace $w.Workspace -Operations @(
                @{ type = 'replace-file'; path = 'absent.txt'; content = 'x' }
            )
            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'no-changes'
        }

        It 'commits "ERROR WHILE CODE CHANGE" when an operation fails but there is a diff' {
            $w = newWorkspace
            $cfg = newOpsConfig -Workspace $w.Workspace -Operations @(
                @{ type = 'add-file'; path = 'created.txt'; content = 'hi' },
                @{ type = 'regex-replace'; path = 'created.txt'; pattern = 'zzz'; replacement = 'q'; requireMatch = $true }
            )
            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.CodeChangeOk | Should -BeFalse
            $r.Outcome | Should -Be 'committed'
            (& git -C $w.Repo log -1 --format=%s).Trim() | Should -Be 'ERROR WHILE CODE CHANGE'
        }

        It 'fails fatally on an unknown operation type' {
            $w = newWorkspace
            $cfg = newOpsConfig -Workspace $w.Workspace -Operations @(@{ type = 'does-not-exist' })
            $r = Invoke-GitBulkRu -Config $cfg -Ru $w.Ru
            $r.Outcome | Should -Be 'fatal'
            $r.Error | Should -Match 'unknown operation type'
        }
    }
}

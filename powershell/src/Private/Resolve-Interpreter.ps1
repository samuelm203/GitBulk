# Interpreter-Wahl für Code-Change-Skripte (Pendant zu resolveInterpreter in
# node_ts/src/git/operations.ts). Liefert @{ Command; PrefixArgs }; der Aufruf
# ist dann FilePath=Command, Arguments=PrefixArgs + ScriptPath.
#
#   .sh/.bash          → sh/bash (Windows: Git's mitgeliefertes sh.exe)
#   .bat/.cmd          → cmd.exe /c
#   .ps1               → pwsh -NoProfile -File
#   .js/.mjs/.cjs      → node
#   .ts/.mts/.cts      → tsx (aus dem Repo) oder Nodes Type-Stripping
#   sonst              → direkt ausführen (Shebang/Datei-Assoziation; PrefixArgs '__SELF__')

$script:GitBulkCachedShell = $null

function Find-GitShell {
    # Sucht Git's mitgeliefertes sh.exe auf Windows (Git ist ohnehin Voraussetzung).
    if ($null -ne $script:GitBulkCachedShell) { return $script:GitBulkCachedShell }
    $resolved = 'sh'
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd -and $gitCmd.Source) {
        # z. B. C:\Program Files\Git\cmd\git.exe → Git-Root C:\Program Files\Git
        $gitRoot = Split-Path (Split-Path $gitCmd.Source -Parent) -Parent
        foreach ($rel in @('bin\sh.exe', 'usr\bin\sh.exe')) {
            $candidate = Join-Path $gitRoot $rel
            if (Test-Path -LiteralPath $candidate) { $resolved = $candidate; break }
        }
    }
    $script:GitBulkCachedShell = $resolved
    return $resolved
}

function Test-TsxAvailable {
    # Prüft, ob `tsx` aus dem NUTZER-Repo (cwd) auflösbar ist — node_modules/tsx
    # ab cwd aufwärts. GitBulk liefert tsx NICHT mit.
    param([Parameter(Mandatory)][string]$Cwd)
    $dir = $Cwd
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir 'node_modules' 'tsx')) { return $true }
        $parent = Split-Path $dir -Parent
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $false
}

function Get-NodeStripTypesArg {
    # Liefert die node-Flags für eingebautes TS-Type-Stripping, oder $null, wenn
    # die installierte node-Version es nicht unterstützt (< 22.6) bzw. node fehlt.
    $verStr = $null
    try { $verStr = (& node --version 2>$null) } catch { return $null }
    if (-not $verStr -or $verStr -notmatch '(\d+)\.(\d+)') { return $null }
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]
    $supported = ($maj -gt 22) -or ($maj -eq 22 -and $min -ge 6)
    if (-not $supported) { return $null }
    # 22.6-23.5 brauchen das Flag; ab 23.6 ist Type-Stripping Standard.
    $needsFlag = ($maj -lt 23) -or ($maj -eq 23 -and $min -lt 6)
    if ($needsFlag) { return , @('--experimental-strip-types') }
    return , @()
}

function Resolve-TsRuntime {
    param([Parameter(Mandatory)][string]$Cwd)
    if (Test-TsxAvailable -Cwd $Cwd) {
        return @{ Command = 'node'; PrefixArgs = @('--import', 'tsx') }
    }
    $nativeArgs = Get-NodeStripTypesArg
    if ($null -ne $nativeArgs) {
        return @{ Command = 'node'; PrefixArgs = @($nativeArgs) }
    }
    throw 'To run TypeScript scripts on Node < 22.6, please install tsx in your project (npm install -D tsx) or upgrade to Node >= 22.6.'
}

function Resolve-Interpreter {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string]$Cwd = (Get-Location).Path
    )
    $ext = [System.IO.Path]::GetExtension($ScriptPath).ToLowerInvariant()
    switch -Regex ($ext) {
        '^\.(sh|bash)$' {
            if ($IsWindows) { return @{ Command = (Find-GitShell); PrefixArgs = @() } }
            return @{ Command = (if ($ext -eq '.bash') { 'bash' } else { 'sh' }); PrefixArgs = @() }
        }
        '^\.(bat|cmd)$' { return @{ Command = 'cmd.exe'; PrefixArgs = @('/c') } }
        '^\.ps1$' { return @{ Command = 'pwsh'; PrefixArgs = @('-NoProfile', '-File') } }
        '^\.(js|mjs|cjs)$' { return @{ Command = 'node'; PrefixArgs = @() } }
        '^\.(ts|mts|cts)$' { return (Resolve-TsRuntime -Cwd $Cwd) }
        default { return @{ Command = $ScriptPath; PrefixArgs = @('__SELF__') } }
    }
}

# Git-Executor — sicherer Wrapper um `git` (Pendant zu node_ts/src/git/executor.ts).
#
# Baut die git-Argumente + eine sichere Default-Umgebung und delegiert die
# eigentliche Prozess-Mechanik (Timeout, Prozess-Tree-Kill, Output-Capture) an
# Invoke-ManagedProcess.
#
# Wirft NICHT bei Exit-Code != 0 — der Aufrufer wertet `ExitCode` aus (wie in
# der Node-Version; der Flow unterscheidet bewusst zwischen Exit 0 und != 0).

function Invoke-Git {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        # Argumente NACH `git` (z. B. @('status', '--porcelain')).
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        # Arbeitsverzeichnis (typischerweise der RU-Pfad).
        [Parameter(Mandatory)]
        [string]$Cwd,

        # Timeout in Millisekunden. Bei Überschreitung wird der Prozessbaum gekillt.
        [int]$TimeoutMs = 120000,

        # Wenn gesetzt, wird der Befehl NICHT ausgeführt (synthetischer Erfolg).
        [switch]$DryRun,

        # Wenn gesetzt, werden Git-Hooks via core.hooksPath=/dev/null deaktiviert.
        [switch]$SkipHooks,

        # Zusätzliche Umgebungsvariablen (mit der Prozess-Umgebung gemerged).
        [hashtable]$EnvironmentVariables
    )

    # Globale Prefix-Argumente (skipHooks → Hooks aus).
    $fullArgs = [System.Collections.Generic.List[string]]::new()
    if ($SkipHooks) {
        $fullArgs.Add('-c'); $fullArgs.Add('core.hooksPath=/dev/null')
    }
    foreach ($a in $Arguments) { $fullArgs.Add([string]$a) }

    # ── Dry-Run-Pfad ─────────────────────────────────────────────────
    if ($DryRun) {
        return [pscustomobject]@{
            ExitCode   = 0
            Stdout     = ''
            Stderr     = ''
            DurationMs = 0
            TimedOut   = $false
            Arguments  = $fullArgs.ToArray()
            Cwd        = $Cwd
        }
    }

    # Sichere Default-Umgebung: keine interaktiven Auth-Prompts, stabile Locale.
    $env = @{
        GIT_TERMINAL_PROMPT = '0'
        LC_ALL              = 'C'
        LANG                = 'C'
    }
    if ($EnvironmentVariables) {
        foreach ($key in $EnvironmentVariables.Keys) { $env[[string]$key] = [string]$EnvironmentVariables[$key] }
    }

    $result = Invoke-ManagedProcess -FilePath 'git' -Arguments $fullArgs.ToArray() -Cwd $Cwd `
        -TimeoutMs $TimeoutMs -EnvironmentVariables $env

    [pscustomobject]@{
        ExitCode   = $result.ExitCode
        Stdout     = $result.Stdout
        Stderr     = $result.Stderr
        DurationMs = $result.DurationMs
        TimedOut   = $result.TimedOut
        Arguments  = $fullArgs.ToArray()
        Cwd        = $Cwd
    }
}

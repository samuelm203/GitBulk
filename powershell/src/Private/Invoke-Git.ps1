# Git-Executor — sicherer Wrapper um `git` (Pendant zu node_ts/src/git/executor.ts).
#
# Eigenschaften:
#   - Sichere Argument-Übergabe via ArgumentList (keine Shell-Interpolation →
#     kein Command-Injection-Risiko bei RU-/Branch-Namen).
#   - Timeout pro Befehl: hängende Auth-Prompts/Hooks/Netzwerk-Stalls werden
#     nach TimeoutMs abgebrochen.
#   - Prozess-Tree-Kill plattformübergreifend via .NET Process.Kill($true)
#     (beendet auch Enkelprozesse wie Hooks/Editor/Credential-Helper).
#   - stdout/stderr-Capture, Exit-Code, Dauer.
#   - DryRun: schreibende Befehle werden nicht ausgeführt (synthetischer Erfolg).
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

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # ── Dry-Run-Pfad ─────────────────────────────────────────────────
    if ($DryRun) {
        return [pscustomobject]@{
            ExitCode   = 0
            Stdout     = ''
            Stderr     = ''
            DurationMs = [int]$sw.ElapsedMilliseconds
            TimedOut   = $false
            Arguments  = $fullArgs.ToArray()
            Cwd        = $Cwd
        }
    }

    # ── Prozess konfigurieren (UseShellExecute=$false → kein Shell-Parsing) ──
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'git'
    foreach ($a in $fullArgs) { $psi.ArgumentList.Add($a) }
    $psi.WorkingDirectory = $Cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true

    # Sichere Default-Umgebung: keine interaktiven Auth-Prompts, stabile Locale.
    $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $psi.EnvironmentVariables['LC_ALL'] = 'C'
    $psi.EnvironmentVariables['LANG'] = 'C'
    if ($EnvironmentVariables) {
        foreach ($key in $EnvironmentVariables.Keys) {
            $psi.EnvironmentVariables[[string]$key] = [string]$EnvironmentVariables[$key]
        }
    }

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi

    try {
        [void]$proc.Start()
    } catch {
        throw "Failed to spawn git: $($_.Exception.Message)"
    }

    # stdin schließen → Sub-Prozesse warten nicht auf Input.
    $proc.StandardInput.Close()

    # stdout/stderr asynchron lesen, damit volle Pipes den Prozess nicht
    # blockieren. GetResult() unten wartet auf Stream-EOF (= Prozess-/Baum-Ende).
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    $timedOut = $false
    if (-not $proc.WaitForExit($TimeoutMs)) {
        $timedOut = $true
        # Prozessbaum beenden, SOLANGE er intakt ist — sonst werden Enkel-
        # prozesse (Hook → sleep, Editor, Credential-Helper) zu Waisen und
        # entgehen dem Kill. Windows: taskkill /T /F über die noch lebende PID
        # (zuverlässiger als Process.Kill($true) bei verwaisten Enkeln);
        # POSIX: .NET Process.Kill($true).
        if ($IsWindows) {
            & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
        } else {
            try { $proc.Kill($true) } catch {
                Write-Verbose "Process-tree kill failed (already exited?): $($_.Exception.Message)"
            }
        }
        [void]$proc.WaitForExit(3000)
    }

    # Auf Stream-EOF warten, aber BEGRENZT: ein evtl. überlebender Enkelprozess
    # darf die Funktion nicht blockieren. Nicht fertige Reads → leerer Wert.
    $stdout = ''
    $stderr = ''
    try { if ($outTask.Wait(3000)) { $stdout = $outTask.Result } } catch {
        Write-Verbose "stdout read failed: $($_.Exception.Message)"
    }
    try { if ($errTask.Wait(2000)) { $stderr = $errTask.Result } } catch {
        Write-Verbose "stderr read failed: $($_.Exception.Message)"
    }
    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { $null }
    $sw.Stop()

    [pscustomobject]@{
        ExitCode   = $exitCode
        Stdout     = $stdout
        Stderr     = $stderr
        DurationMs = [int]$sw.ElapsedMilliseconds
        TimedOut   = $timedOut
        Arguments  = $fullArgs.ToArray()
        Cwd        = $Cwd
    }
}

# Gemeinsame Prozess-Mechanik für GitBulk: startet einen Prozess sicher
# (ohne Shell), erfasst stdout/stderr, erzwingt ein Timeout und beendet bei
# Überschreitung den GESAMTEN Prozessbaum.
#
# Basis sowohl für Invoke-Git (Git-Befehle) als auch Invoke-CodeChange
# (Code-Change-Skripte) — beide brauchen exakt dieses Verhalten.

function Invoke-ManagedProcess {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        # Auszuführendes Programm (z. B. 'git', 'node', der Interpreter …).
        [Parameter(Mandatory)]
        [string]$FilePath,

        # Argumente (werden via ArgumentList übergeben → keine Shell-Interpolation).
        [string[]]$Arguments = @(),

        # Arbeitsverzeichnis.
        [Parameter(Mandatory)]
        [string]$Cwd,

        # Timeout in Millisekunden; danach wird der Prozessbaum gekillt.
        [int]$TimeoutMs = 120000,

        # Zusätzliche/überschreibende Umgebungsvariablen.
        [hashtable]$EnvironmentVariables
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    foreach ($a in $Arguments) { $psi.ArgumentList.Add([string]$a) }
    $psi.WorkingDirectory = $Cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
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
        throw "Failed to start process '$FilePath': $($_.Exception.Message)"
    }

    # stdin schließen → Sub-Prozesse warten nicht auf Input.
    $proc.StandardInput.Close()

    # stdout/stderr asynchron lesen, damit volle Pipes nicht blockieren.
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    $timedOut = $false
    if (-not $proc.WaitForExit($TimeoutMs)) {
        $timedOut = $true
        # Prozessbaum beenden, SOLANGE er intakt ist — sonst werden Enkel-
        # prozesse (Hook → sleep, Editor, Credential-Helper) zu Waisen und
        # entgehen dem Kill. Windows: taskkill /T /F über die noch lebende PID;
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
    }
}

# Führt das Code-Change-Skript eines RU aus (Pendant zu executeCodeChange in
# node_ts/src/git/operations.ts).
#
# Das Skript ändert NUR Dateien im Repo — git add/commit/push macht der Runner.
# Es bekommt die GITBULK_*-Umgebungsvariablen. Der Interpreter wird anhand der
# Dateiendung gewählt (Resolve-Interpreter). Wirft NICHT bei Exit != 0 — der
# Aufrufer wertet das Ergebnis aus.

function Invoke-CodeChange {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        # Pfad zum Code-Change-Skript.
        [Parameter(Mandatory)]
        [string]$ScriptPath,

        # Repo-Verzeichnis (Arbeitsverzeichnis des Skripts).
        [Parameter(Mandatory)]
        [string]$Cwd,

        [int]$TimeoutMs = 120000,

        # Kontext für die GITBULK_*-Variablen: Keys Ru/Ticket/Branch/SourceBranch.
        [hashtable]$Context = @{}
    )

    $interp = Resolve-Interpreter -ScriptPath $ScriptPath -Cwd $Cwd
    $isSelf = ($interp.PrefixArgs.Count -gt 0 -and $interp.PrefixArgs[0] -eq '__SELF__')

    if ($isSelf) {
        # Ohne bekannte Endung: direkt ausführen (Shebang / Datei-Assoziation).
        $filePath = $interp.Command
        $procArgs = @()
    } else {
        $filePath = $interp.Command
        $procArgs = @($interp.PrefixArgs) + @($ScriptPath)
    }

    $env = @{
        GIT_TERMINAL_PROMPT   = '0'
        GITBULK_RU            = [string]$Context['Ru']
        GITBULK_TICKET        = [string]$Context['Ticket']
        GITBULK_BRANCH        = [string]$Context['Branch']
        GITBULK_SOURCE_BRANCH = [string]$Context['SourceBranch']
    }

    Invoke-ManagedProcess -FilePath $filePath -Arguments $procArgs -Cwd $Cwd `
        -TimeoutMs $TimeoutMs -EnvironmentVariables $env
}

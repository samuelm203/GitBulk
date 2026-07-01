# Auth-Guard + Token-Auflösung (Pendant zu node_ts/src/cli/token-prompt.ts).
#
# Reihenfolge: Env-Variable > gespeicherter Token (gitbulk auth login) >
# interaktive (maskierte) Abfrage. Ein aus Store/Prompt aufgelöster Token wird in
# die Prozess-Env gelegt, damit der bestehende Adapter ihn liest. Tokens werden
# NIE geloggt.

function Get-GitBulkTokenEnvVar {
    # Name der Env-Variable je Plattform — oder $null für Plattformen ohne Token
    # (azure-devops: Adapter noch nicht implementiert, daher hier nicht abfragen).
    param([Parameter(Mandatory)][string]$Platform)
    switch ($Platform) {
        'bitbucket' { return 'GITBULK_BITBUCKET_TOKEN' }
        'github' { return 'GITBULK_GITHUB_TOKEN' }
        'gitlab' { return 'GITBULK_GITLAB_TOKEN' }
        default { return $null }
    }
}

function Read-GitBulkSecret {
    # Liest eine Eingabe maskiert (kein Echo) vom Terminal — für Tokens/Secrets.
    # Nur im echten Terminal aufrufen. Nicht unit-getestet (TTY).
    param([Parameter(Mandatory)][string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Resolve-GitBulkToken {
    <#
    .SYNOPSIS
        Stellt sicher, dass der Plattform-Token verfügbar ist (env > store > prompt),
        und legt ihn bei Bedarf in die Prozess-Env. Wirft NIE.

    .OUTPUTS
        [hashtable] @{ Ok = $true } oder @{ Ok = $false; Error = '...' }.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$Platform,
        [switch]$Interactive,
        [switch]$DryRun
    )

    $varName = Get-GitBulkTokenEnvVar -Platform $Platform
    # Plattform ohne definierten Token (z. B. azure-devops): der Adapter meldet sich selbst.
    if ($null -eq $varName) { return @{ Ok = $true } }

    $current = [Environment]::GetEnvironmentVariable($varName)
    if (-not [string]::IsNullOrWhiteSpace($current)) { return @{ Ok = $true } }

    # 2. Gespeicherter Token. Env behält Vorrang; ein Treffer wird in die Env gelegt.
    $stored = Get-GitBulkStoredToken -Platform $Platform
    if (-not [string]::IsNullOrWhiteSpace($stored)) {
        Set-Item -Path "env:$varName" -Value $stored.Trim()
        return @{ Ok = $true }
    }

    # Dry-Run ruft keine PR-API auf → kein Token nötig.
    if ($DryRun) { return @{ Ok = $true } }

    if (-not $Interactive) {
        return @{
            Ok    = $false
            Error = "Environment variable $varName is required for $Platform PR creation. " +
            "Set it, run ``./gitbulk.ps1 -Auth login -Platform $Platform`` to store it once, " +
            'or run in an interactive terminal to be prompted.'
        }
    }

    # 3. Interaktiv (maskiert) abfragen und in die Env legen.
    $entered = (Read-GitBulkSecret -Prompt "Enter $varName for $Platform (input hidden)").Trim()
    if ($entered.Length -eq 0) { return @{ Ok = $false; Error = "No token entered for $varName." } }
    Set-Item -Path "env:$varName" -Value $entered
    return @{ Ok = $true }
}

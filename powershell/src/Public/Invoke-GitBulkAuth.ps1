function Invoke-GitBulkAuth {
    <#
    .SYNOPSIS
        Verwaltet persistent gespeicherte PR-Tokens (Pendant zu `gitbulk auth`).

    .DESCRIPTION
        login  -Platform bitbucket|github   Token (maskiert) abfragen und speichern
        logout [-Platform <p>]              Token entfernen (ohne -Platform = alle)
        status                              zeigt, welche Tokens vorliegen

        Der Token landet in ~/.gitbulk/credentials.json (außerhalb jedes Repos,
        Rechte 0600). Zur Laufzeit hat die Env-Variable IMMER Vorrang. Tokens
        werden NIE ausgegeben oder geloggt — `status` zeigt nur, OB ein Token da ist.

    .PARAMETER Action
        'login', 'logout' oder 'status'.

    .PARAMETER Platform
        Zielplattform ('bitbucket' / 'github'). Pflicht für login.

    .PARAMETER Interactive
        Darf maskiert nach dem Token gefragt werden? (echtes Terminal)

    .PARAMETER NoColor
        Ausgabe ohne Farben.

    .OUTPUTS
        [int] Exit-Code (0 = ok, 3 = Nutzungs-/Eingabefehler).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('login', 'logout', 'status')]
        [string]$Action,

        [ValidateSet('bitbucket', 'github')]
        [string]$Platform,

        [switch]$Interactive,
        [switch]$NoColor
    )

    function fail([string]$Message) { [Console]::Error.WriteLine("Error: $Message"); return 3 }

    switch ($Action) {
        'login' {
            if ([string]::IsNullOrWhiteSpace($Platform)) {
                return (fail '`-Auth login` requires -Platform bitbucket|github.')
            }
            $varName = Get-GitBulkTokenEnvVar -Platform $Platform
            if (-not $Interactive) {
                return (fail "Cannot read a token without a terminal. Run ``./gitbulk.ps1 -Auth login -Platform $Platform`` interactively, or set $varName directly.")
            }
            $token = (Read-GitBulkSecret -Prompt "Enter $varName for $Platform (input hidden)").Trim()
            if ($token.Length -eq 0) { return (fail 'No token entered — nothing saved.') }
            $path = Set-GitBulkStoredToken -Platform $Platform -Token $token
            Write-GitBulkLine -Message "Saved $Platform token to $path (file mode 0600)." -Color 'Green' -NoColor:$NoColor
            return 0
        }

        'logout' {
            $target = if ([string]::IsNullOrWhiteSpace($Platform)) { 'all' } else { $Platform }
            $removed = Remove-GitBulkStoredToken -Platform $target
            if ($removed) {
                $msg = if ($target -eq 'all') { 'Removed all stored GitBulk tokens.' } else { "Removed stored $target token." }
            } else {
                $msg = if ($target -eq 'all') { 'No stored tokens to remove.' } else { "No stored $target token to remove." }
            }
            Write-GitBulkLine -Message $msg -NoColor:$NoColor
            return 0
        }

        'status' {
            $stored = @(Get-GitBulkStoredPlatform)
            Write-GitBulkLine -Message "Credential store: $(Get-GitBulkCredentialPath)" -NoColor:$NoColor
            Write-GitBulkLine -Message 'Resolution order: env var > stored token > interactive prompt' -NoColor:$NoColor
            Write-GitBulkLine -Message '' -NoColor:$NoColor
            foreach ($p in @('bitbucket', 'github')) {
                $varName = Get-GitBulkTokenEnvVar -Platform $p
                $envSet = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($varName))
                $hasStored = $stored -contains $p
                $active = if ($envSet) { 'env var' } elseif ($hasStored) { 'stored' } else { 'none' }
                $line = '  {0}  env:{1}  stored:{2}  -> {3}' -f `
                    $p.PadRight(10), $(if ($envSet) { 'yes' } else { ' no' }), $(if ($hasStored) { 'yes' } else { ' no' }), $active
                Write-GitBulkLine -Message $line -NoColor:$NoColor
            }
            return 0
        }
    }
}

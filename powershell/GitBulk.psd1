@{
    # Modul-Manifest für GitBulk (PowerShell-Port).
    RootModule        = 'GitBulk.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '0c0ef84c-f710-4a38-a309-7659d2601ec3'
    Author            = 'GitBulk contributors'
    CompanyName       = 'GitBulk'
    Copyright         = 'Apache-2.0'
    Description       = 'Native PowerShell port of GitBulk — bulk Git operations across many repositories.'

    # PowerShell 7.2+ (Core); cross-platform. Windows PowerShell 5.1 wird NICHT unterstützt.
    PowerShellVersion = '7.2'
    CompatiblePSEditions = @('Core')

    # Wird von GitBulk.psm1 per Export-ModuleMember gesetzt; hier explizit für
    # Discovery/Tooling. Bei neuen öffentlichen Funktionen ergänzen.
    FunctionsToExport = @('Get-GitBulkVersion', 'Get-GitBulkConfig', 'Invoke-GitBulkRun', 'Invoke-GitBulk', 'Get-GitBulkOperationInfo', 'Show-GitBulkOperationList', 'New-GitBulkConfigYaml', 'Invoke-GitBulkInit')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()

    PrivateData = @{
        PSData = @{
            Tags       = @('git', 'bulk', 'automation', 'pull-request', 'cli')
            LicenseUri = 'https://www.apache.org/licenses/LICENSE-2.0'
            ProjectUri = 'https://github.com/samuelm203/GitBulk'
        }
    }
}

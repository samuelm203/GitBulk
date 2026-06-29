function Format-GitBulkStatusJson {
    <#
    .SYNOPSIS
        Serialisiert einen Status-Report (aus Get-GitBulkStatusReport) als JSON.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Report)
    return ($Report | ConvertTo-Json -Depth 6)
}

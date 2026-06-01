function Get-GitBulkOperationInfo {
    <#
    .SYNOPSIS
        Liefert alle registrierten Operationen samt Parameter-Metadaten.

    .DESCRIPTION
        Pendant zu collectOperationInfos in der Node-Version. Gibt pro Operation
        ein Objekt mit Type, Description und Params zurück (nach Typ sortiert).
        Jeder Param hat Name, Kind (string/number/boolean/enum), Required, Default
        (oder $null) und Enum (oder leeres Array). Geeignet zur Anzeige
        (Show-GitBulkOperationList) und für `ConvertTo-Json`.

    .EXAMPLE
        Get-GitBulkOperationInfo | Where-Object Type -eq 'add-file'

    .EXAMPLE
        Get-GitBulkOperationInfo | ConvertTo-Json -Depth 5
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    return @(
        $script:GitBulkOperations.Values |
            Sort-Object -Property Type |
            ForEach-Object {
                $params = @(
                    foreach ($p in @($_.Params)) {
                        [pscustomobject]@{
                            Name     = [string]$p.Name
                            Kind     = [string]$p.Kind
                            Required = [bool]$p.Required
                            Default  = if ($p.Contains('Default')) { $p.Default } else { $null }
                            Enum     = if ($p.Contains('Enum')) { @($p.Enum) } else { @() }
                        }
                    }
                )
                [pscustomobject]@{
                    Type        = [string]$_.Type
                    Description = [string]$_.Description
                    Params      = $params
                }
            }
    )
}

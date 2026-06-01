# Interaktiver Prompt-Helfer für EINEN Operation-Parameter (anhand der
# Param-Metadaten aus Get-GitBulkOperationInfo). Liefert den Wert, oder $null
# wenn ein optionales Feld leer gelassen (übersprungen) wird. Selbst-enthaltend
# (keine Abhängigkeit von Aufrufer-Variablen). Interaktiv → nicht unit-getestet.
function Read-GitBulkParamValue {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Param)

    $defNote = if ($null -ne $Param.Default) { " [default: $($Param.Default)]" } else { '' }
    $optNote = if ($Param.Required) { '' } else { ' (optional, blank to skip)' }

    for (;;) {
        $label = switch ($Param.Kind) {
            'boolean' { "  $($Param.Name) (Y/N)$optNote$defNote" }
            'enum' { "  $($Param.Name) ($(@($Param.Enum) -join ' / '))$optNote$defNote" }
            default { "  $($Param.Name)$optNote$defNote" }
        }
        $raw = ([string](Read-Host -Prompt $label)).Trim()

        if ($raw -eq '') {
            if ($Param.Required) { [Console]::Error.WriteLine('  This field is required.'); continue }
            return $null
        }

        switch ($Param.Kind) {
            'boolean' {
                $t = $raw.ToLowerInvariant()
                if ($t -in @('y', 'yes', 'true', '1')) { return $true }
                if ($t -in @('n', 'no', 'false', '0')) { return $false }
                [Console]::Error.WriteLine('  Please answer Y or N.')
            }
            'enum' {
                if ($raw -in @($Param.Enum)) { return $raw }
                [Console]::Error.WriteLine("  Please enter one of: $(@($Param.Enum) -join ', ')")
            }
            default { return $raw }
        }
    }
}

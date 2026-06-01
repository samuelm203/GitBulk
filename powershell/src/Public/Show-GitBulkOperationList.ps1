function Show-GitBulkOperationList {
    <#
    .SYNOPSIS
        Listet alle deklarativen Operationen samt Parametern auf (Pendant zu
        `gitbulk list-operations`).

    .DESCRIPTION
        Gibt für jede registrierte Operation Typ, Beschreibung und Parameter aus.
        Die Parameter stammen aus den Operation-Metadaten (Get-GitBulkOperationInfo),
        sodass neue Operationen automatisch korrekt erscheinen.

    .PARAMETER Json
        Maschinenlesbare JSON-Ausgabe (auf echtes stdout, damit `>`/Pipe sie
        einfangen) statt der menschenlesbaren, farbigen Liste.

    .PARAMETER NoColor
        Farben in der menschenlesbaren Ausgabe deaktivieren.
    #>
    [CmdletBinding()]
    param(
        [switch]$Json,
        [switch]$NoColor
    )

    $infos = @(Get-GitBulkOperationInfo)

    if ($Json) {
        # Auf den echten stdout-Stream schreiben (nicht den PS-Output-Stream),
        # damit Umleitung/Pipe das JSON erhält und der Rückgabewert sauber bleibt.
        [Console]::Out.WriteLine(($infos | ConvertTo-Json -Depth 6))
        return
    }

    if ($infos.Count -eq 0) {
        Write-Host 'No operations are registered.'
        return
    }

    # Einen Parameter als kompakte Zeile formatieren, z. B.
    # `flags (string, optional, default="g")`.
    $formatParam = {
        param($p)
        $attrs = @($p.Kind)
        $attrs += if ($p.Required) { 'required' } else { 'optional' }
        if ($null -ne $p.Default) { $attrs += "default=$($p.Default | ConvertTo-Json -Compress)" }
        if (@($p.Enum).Count -gt 0) { $attrs += "one of: $(@($p.Enum) -join ' | ')" }
        return "$($p.Name) ($($attrs -join ', '))"
    }

    Write-Host ''
    $header = "Available operations ($($infos.Count)):"
    if ($NoColor) { Write-Host $header } else { Write-Host $header -ForegroundColor White }
    Write-Host ''

    foreach ($info in $infos) {
        if ($NoColor) {
            Write-Host "$($info.Type) — $($info.Description)"
        } else {
            Write-Host $info.Type -ForegroundColor Green -NoNewline
            Write-Host " — $($info.Description)"
        }
        if (@($info.Params).Count -eq 0) {
            if ($NoColor) { Write-Host '    (no parameters)' } else { Write-Host '    (no parameters)' -ForegroundColor DarkGray }
        } else {
            foreach ($p in $info.Params) { Write-Host "    - $(& $formatParam $p)" }
        }
        Write-Host ''
    }

    $footer = 'Use these under `operations:` in your config, or via `gitbulk.ps1 -Init`.'
    if ($NoColor) { Write-Host $footer } else { Write-Host $footer -ForegroundColor DarkGray }
}

# Interaktiver Prompt-Helfer: fragt per Read-Host, bis der Validator-Scriptblock
# ein Ok-Result liefert. Der Validator bekommt die Rohzeile und gibt
# @{ Ok; Value; Error } zurück (wie die Test-GitBulk*-Validatoren).
#
# Hinweis: interaktiv (Read-Host) → nur im echten Terminal sinnvoll, daher nicht
# unit-getestet. Der Validator-Scriptblock nutzt ausschließlich sein Argument
# (keine Abhängigkeit von Aufrufer-Variablen), läuft aber im Modul-Scope und kann
# so die privaten Test-GitBulk*-Funktionen aufrufen.
function Read-GitBulkValidated {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][scriptblock]$Validator
    )

    for (;;) {
        $raw = Read-Host -Prompt $Prompt
        $res = & $Validator $raw
        if ($res.Ok) { return $res.Value }
        [Console]::Error.WriteLine("  $($res.Error)")
    }
}

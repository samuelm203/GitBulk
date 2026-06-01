# Kleiner Ausgabe-Helfer: schreibt eine Zeile, optional farbig. Bei -NoColor oder
# fehlender Farbe ohne Färbung. (Write-Host ist via Analyzer-Settings erlaubt.)
function Write-GitBulkLine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Message,
        [string]$Color,
        [switch]$NoColor
    )

    if ($NoColor -or [string]::IsNullOrEmpty($Color)) {
        Write-Host $Message
    } else {
        Write-Host $Message -ForegroundColor $Color
    }
}

@{
    # PSScriptAnalyzer-Konfiguration für den GitBulk-PowerShell-Port.
    # Errors UND Warnings gelten als Fehler (build.ps1 / CI brechen darauf ab).
    Severity = @('Error', 'Warning')

    ExcludeRules = @(
        # Wir geben bewusst keine Konsolen-Schreibfunktion vor; Write-Host in
        # build.ps1 ist für CLI-Ausgabe gewollt.
        'PSAvoidUsingWriteHost',
        # UTF-8 OHNE BOM ist der moderne, Git-freundliche Standard und wird von
        # PowerShell 7+ (unsere Mindestversion) korrekt gelesen — auch deutsche
        # Umlaute in Kommentaren. Eine BOM ist nur für Windows PowerShell 5.1
        # nötig, das wir explizit NICHT unterstützen.
        'PSUseBOMForUnicodeEncodedFile'
    )
}

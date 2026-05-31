# GitBulk — Modul-Loader.
#
# Lädt alle Funktionen aus src/Private (interne Helfer) und src/Public
# (öffentliche API) per Dot-Sourcing und exportiert ausschließlich die
# öffentlichen Funktionen. Eine neue Funktion hinzufügen = einfach eine .ps1
# in den passenden Ordner legen; das Manifest (FunctionsToExport) entsprechend
# ergänzen.

$ErrorActionPreference = 'Stop'

$private = @(Get-ChildItem -Path (Join-Path $PSScriptRoot 'src/Private/*.ps1') -ErrorAction SilentlyContinue)
$public = @(Get-ChildItem -Path (Join-Path $PSScriptRoot 'src/Public/*.ps1') -ErrorAction SilentlyContinue)

foreach ($file in @($private + $public)) {
    try {
        . $file.FullName
    } catch {
        throw "Failed to load GitBulk function '$($file.FullName)': $_"
    }
}

if ($public.Count -gt 0) {
    Export-ModuleMember -Function $public.BaseName
}

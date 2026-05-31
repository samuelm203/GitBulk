#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

BeforeAll {
    $script:ManifestPath = Join-Path $PSScriptRoot '..' 'GitBulk.psd1'
    Import-Module $script:ManifestPath -Force
}

AfterAll {
    Remove-Module GitBulk -Force -ErrorAction SilentlyContinue
}

Describe 'GitBulk module' {
    It 'imports without error' {
        Get-Module GitBulk | Should -Not -BeNullOrEmpty
    }

    It 'has a valid manifest' {
        { Test-ModuleManifest -Path $script:ManifestPath } | Should -Not -Throw
    }

    It 'exports Get-GitBulkVersion' {
        (Get-Command -Module GitBulk).Name | Should -Contain 'Get-GitBulkVersion'
    }
}

Describe 'Get-GitBulkVersion' {
    It 'returns a dotted version (2-4 components)' {
        # PowerShell-Modulversionen dürfen 2 bis 4 Komponenten haben (z. B. 1.2,
        # 1.2.3 oder 1.2.3.4) — nicht auf exakt drei festnageln.
        Get-GitBulkVersion | Should -Match '^\d+(\.\d+){1,3}$'
    }

    It 'matches the manifest ModuleVersion' {
        $manifest = Import-PowerShellDataFile -Path $script:ManifestPath
        Get-GitBulkVersion | Should -Be $manifest.ModuleVersion
    }
}

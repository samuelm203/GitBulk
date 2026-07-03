#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für die öffentlichen list-operations-Funktionen: Get-GitBulkOperationInfo
# (strukturierte Metadaten) und Show-GitBulkOperationList (Ausgabe). Beide sind
# exportiert, daher kein InModuleScope nötig.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force
}

Describe 'Get-GitBulkOperationInfo' {
    BeforeAll { $script:infos = Get-GitBulkOperationInfo }

    It 'returns all ten operations, sorted by type' {
        $script:infos.Count | Should -Be 10
        $types = $script:infos.Type
        ($types -join ',') | Should -Be (($types | Sort-Object) -join ',')
        $types | Should -Contain 'maven-add-dependency'
    }

    It 'derives add-file parameters with kinds and defaults' {
        $addFile = $script:infos | Where-Object Type -EQ 'add-file'
        ($addFile.Params.Name) | Should -Be @('path', 'content', 'overwrite')
        $path = $addFile.Params | Where-Object Name -EQ 'path'
        $path.Kind | Should -Be 'string'
        $path.Required | Should -BeTrue
        $overwrite = $addFile.Params | Where-Object Name -EQ 'overwrite'
        $overwrite.Kind | Should -Be 'boolean'
        $overwrite.Required | Should -BeFalse
        $overwrite.Default | Should -BeFalse
    }

    It 'exposes the npm field as an enum with a default' {
        $field = ($script:infos | Where-Object Type -EQ 'npm-add-dependency').Params | Where-Object Name -EQ 'field'
        $field.Kind | Should -Be 'enum'
        $field.Default | Should -Be 'dependencies'
        $field.Enum | Should -Contain 'devDependencies'
        $field.Enum | Should -Contain 'peerDependencies'
    }

    It 'gives regex-replace flags a default of g' {
        $flags = ($script:infos | Where-Object Type -EQ 'regex-replace').Params | Where-Object Name -EQ 'flags'
        $flags.Default | Should -Be 'g'
    }

    It 'leaves the optional maven scope without a default' {
        $scope = ($script:infos | Where-Object Type -EQ 'maven-add-dependency').Params | Where-Object Name -EQ 'scope'
        $scope.Required | Should -BeFalse
        $scope.Default | Should -BeNullOrEmpty
    }

    It 'produces valid JSON via ConvertTo-Json' {
        $json = $script:infos | ConvertTo-Json -Depth 6
        $back = $json | ConvertFrom-Json
        ($back | Where-Object Type -EQ 'add-file').Params.Name | Should -Contain 'overwrite'
    }
}

Describe 'Show-GitBulkOperationList' {
    It 'prints a human-readable list with parameter details' {
        $out = Show-GitBulkOperationList -NoColor 6>&1 | Out-String
        $out | Should -Match 'Available operations \(10\)'
        $out | Should -Match 'add-file'
        $out | Should -Match 'regex-replace'
        $out | Should -Match 'default="g"'
        $out | Should -Match 'one of: dependencies'
    }

    It 'writes valid JSON to stdout with -Json' {
        $sw = [System.IO.StringWriter]::new()
        $orig = [Console]::Out
        [Console]::SetOut($sw)
        try { Show-GitBulkOperationList -Json } finally { [Console]::SetOut($orig) }
        $parsed = $sw.ToString() | ConvertFrom-Json
        $parsed.Count | Should -Be 10
        ($parsed | Where-Object Type -EQ 'json-patch').Params.Name | Should -Contain 'pointer'
    }
}

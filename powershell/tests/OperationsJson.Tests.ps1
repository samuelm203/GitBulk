#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Tests für den JSON-Helfer (Json.ps1) und die Phase-6b-Operationen
# (npm-add-dependency, npm-update, json-patch, maven-add-dependency).
# Alles InModuleScope, da die Funktionen privat sind.

Import-Module (Join-Path $PSScriptRoot '..' 'GitBulk.psd1') -Force

AfterAll {
    Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'gb-opj-*' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

InModuleScope GitBulk {
    Describe 'JSON helper' {
        It 'detects 2-space, 4-space and tab indentation' {
            Get-GitBulkJsonIndent "{`n  `"a`": 1`n}" | Should -Be 2
            Get-GitBulkJsonIndent "{`n    `"a`": 1`n}" | Should -Be 4
            Get-GitBulkJsonIndent "{`n`t`"a`": 1`n}" | Should -Be "`t"
            Get-GitBulkJsonIndent '{"a":1}' | Should -Be 2
        }

        It 'preserves key order and re-serializes with the given indent' {
            $data = ConvertFrom-GitBulkJson "{`n  `"b`": 1,`n  `"a`": 2`n}"
            $expected = "{`n    `"b`": 1,`n    `"a`": 2`n}"
            ConvertTo-GitBulkJson -Value $data -Indent 4 | Should -Be $expected
        }

        It 'round-trips order without reordering keys' {
            $data = ConvertFrom-GitBulkJson '{"z":1,"a":2,"m":3}'
            (ConvertTo-GitBulkJson -Value $data -Compact) | Should -Be '{"z":1,"a":2,"m":3}'
        }

        It 'coerces JSON scalars, else keeps the raw string' {
            (ConvertTo-GitBulkJson -Value (Resolve-GitBulkJsonValue '42') -Compact) | Should -Be '42'
            (ConvertTo-GitBulkJson -Value (Resolve-GitBulkJsonValue 'true') -Compact) | Should -Be 'true'
            (ConvertTo-GitBulkJson -Value (Resolve-GitBulkJsonValue '"x"') -Compact) | Should -Be '"x"'
            (ConvertTo-GitBulkJson -Value (Resolve-GitBulkJsonValue 'hello') -Compact) | Should -Be '"hello"'
        }

        It 'escapes special characters like JSON.stringify' {
            (ConvertTo-GitBulkJson -Value "a`"b\c`tend" -Compact) | Should -Be '"a\"b\\c\tend"'
        }

        It 'sets a dot-path and creates missing intermediates' {
            $d = [ordered]@{}
            Set-GitBulkJsonDotValue -Data $d -DotPath 'a.b.c' -Value 'v'
            (Get-GitBulkJsonDotValue -Data $d -DotPath 'a.b.c').Value | Should -Be 'v'
            (Get-GitBulkJsonDotValue -Data $d -DotPath 'a.x').Found | Should -BeFalse
        }
    }

    Describe 'npm/json/maven operations' {
        BeforeAll {
            function newRepoDir {
                $d = Join-Path ([System.IO.Path]::GetTempPath()) ("gb-opj-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $d | Out-Null
                return $d
            }
            function applyOp {
                param([string]$Type, [hashtable]$Params, [string]$RepoDir)
                $op = Get-GitBulkOperation -Type $Type
                $ctx = @{ RepoDir = $RepoDir; Ru = 'r'; Ticket = 't'; Branch = 'b'; SourceBranch = 's' }
                return Invoke-GitBulkOperation -Operation $op -Params $Params -Context $ctx
            }
            function readText { param([string]$Path) [System.IO.File]::ReadAllText($Path) }
            function writeText { param([string]$Path, [string]$Text) [System.IO.File]::WriteAllText($Path, $Text) }
        }

        Context 'npm-add-dependency' {
            It 'adds a dependency and preserves indent + key order' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"name`": `"x`",`n  `"dependencies`": {`n    `"a`": `"^1.0.0`"`n  }`n}`n"
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'lodash'; version = '^4.17.21' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $txt = readText (Join-Path $root 'package.json')
                $txt | Should -Match '\n  "name"'                 # 2-Space-Einrückung erhalten
                $pkg = $txt | ConvertFrom-Json
                $pkg.dependencies.lodash | Should -Be '^4.17.21'
                $pkg.dependencies.a | Should -Be '^1.0.0'
            }
            It 'is idempotent regardless of the version already present' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"dependencies`": {`n    `"lodash`": `"^3.0.0`"`n  }`n}`n"
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'lodash'; version = '^4.0.0' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already in dependencies'
            }
            It 'adds to devDependencies when field is set' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"name`": `"x`"`n}`n"
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'tsx'; version = '^4.0.0'; field = 'devDependencies' } -RepoDir $root
                $res.Changed | Should -BeTrue
                ((readText (Join-Path $root 'package.json')) | ConvertFrom-Json).devDependencies.tsx | Should -Be '^4.0.0'
            }
            It 'errors on an invalid field' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{}`n"
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'a'; version = '1'; field = 'bogus' } -RepoDir $root
                $res.Error | Should -Match 'invalid field'
            }
            It 'skips when package.json is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'a'; version = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No package.json found'
            }
            It 'errors on invalid JSON' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{ not json"
                $res = applyOp -Type 'npm-add-dependency' -Params @{ name = 'a'; version = '1' } -RepoDir $root
                $res.Error | Should -Match 'invalid JSON'
            }
        }

        Context 'npm-update' {
            It 'updates the version of an existing dependency' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"dependencies`": {`n    `"lodash`": `"^3.0.0`"`n  }`n}`n"
                $res = applyOp -Type 'npm-update' -Params @{ name = 'lodash'; version = '^4.17.21' } -RepoDir $root
                $res.Changed | Should -BeTrue
                ((readText (Join-Path $root 'package.json')) | ConvertFrom-Json).dependencies.lodash | Should -Be '^4.17.21'
            }
            It 'skips when the dependency is not present' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"dependencies`": {}`n}`n"
                $res = applyOp -Type 'npm-update' -Params @{ name = 'ghost'; version = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'not found'
            }
            It 'is idempotent when the version already matches' {
                $root = newRepoDir
                writeText (Join-Path $root 'package.json') "{`n  `"devDependencies`": {`n    `"tsx`": `"^4.0.0`"`n  }`n}`n"
                $res = applyOp -Type 'npm-update' -Params @{ name = 'tsx'; version = '^4.0.0' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already at'
            }
        }

        Context 'json-patch' {
            It 'sets a value and creates the missing nested path' {
                $root = newRepoDir
                writeText (Join-Path $root 'config.json') "{`n  `"name`": `"x`"`n}`n"
                $res = applyOp -Type 'json-patch' -Params @{ path = 'config.json'; pointer = 'scripts.build'; value = 'tsc' } -RepoDir $root
                $res.Changed | Should -BeTrue
                ((readText (Join-Path $root 'config.json')) | ConvertFrom-Json).scripts.build | Should -Be 'tsc'
            }
            It 'coerces JSON values (boolean / number)' {
                $root = newRepoDir
                writeText (Join-Path $root 'config.json') "{}`n"
                applyOp -Type 'json-patch' -Params @{ path = 'config.json'; pointer = 'flag'; value = 'true' } -RepoDir $root | Out-Null
                applyOp -Type 'json-patch' -Params @{ path = 'config.json'; pointer = 'count'; value = '42' } -RepoDir $root | Out-Null
                $obj = (readText (Join-Path $root 'config.json')) | ConvertFrom-Json
                $obj.flag | Should -BeTrue
                $obj.count | Should -Be 42
            }
            It 'is idempotent when the value already matches' {
                $root = newRepoDir
                writeText (Join-Path $root 'config.json') "{`n  `"a`": 1`n}`n"
                $res = applyOp -Type 'json-patch' -Params @{ path = 'config.json'; pointer = 'a'; value = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already set'
            }
            It 'skips when the file is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'json-patch' -Params @{ path = 'gone.json'; pointer = 'a'; value = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No gone.json found'
            }
            It 'errors on invalid JSON' {
                $root = newRepoDir
                writeText (Join-Path $root 'config.json') "nope"
                $res = applyOp -Type 'json-patch' -Params @{ path = 'config.json'; pointer = 'a'; value = '1' } -RepoDir $root
                $res.Error | Should -Match 'invalid JSON'
            }
        }

        Context 'maven-add-dependency' {
            BeforeAll {
                $script:pomWithMgmt = @"
<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>mgmt</groupId>
        <artifactId>bom</artifactId>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>existing</groupId>
      <artifactId>lib</artifactId>
    </dependency>
  </dependencies>
</project>
"@
            }

            It 'adds into the project block (not dependencyManagement) with a scope' {
                $root = newRepoDir
                writeText (Join-Path $root 'pom.xml') $pomWithMgmt
                $res = applyOp -Type 'maven-add-dependency' -Params @{ groupId = 'org.apache.commons'; artifactId = 'commons-lang3'; version = '3.14.0'; scope = 'test' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $txt = readText (Join-Path $root 'pom.xml')
                $txt | Should -Match '<artifactId>commons-lang3</artifactId>'
                $txt | Should -Match '<scope>test</scope>'
                # Die neue Dependency steht NACH dem Schließen von dependencyManagement.
                $txt.IndexOf('commons-lang3') | Should -BeGreaterThan $txt.IndexOf('</dependencyManagement>')
            }
            It 'is idempotent when the dependency is already present' {
                $root = newRepoDir
                writeText (Join-Path $root 'pom.xml') $pomWithMgmt
                $res = applyOp -Type 'maven-add-dependency' -Params @{ groupId = 'existing'; artifactId = 'lib'; version = '1.0.0' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already present'
            }
            It 'still adds when groupId and artifactId only match across different dependencies' {
                # org.foo + bar kommen vor, aber NICHT im selben <dependency> → kein False Positive.
                $root = newRepoDir
                writeText (Join-Path $root 'pom.xml') "<project>`n  <dependencies>`n    <dependency>`n      <groupId>org.foo</groupId>`n      <artifactId>other</artifactId>`n    </dependency>`n    <dependency>`n      <groupId>com.bar</groupId>`n      <artifactId>bar</artifactId>`n    </dependency>`n  </dependencies>`n</project>`n"
                $res = applyOp -Type 'maven-add-dependency' -Params @{ groupId = 'org.foo'; artifactId = 'bar'; version = '1.0.0' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $txt = readText (Join-Path $root 'pom.xml')
                ([regex]::Matches($txt, '<dependency\s*>')).Count | Should -Be 3
            }
            It 'errors when there is no project-level <dependencies> block' {
                $root = newRepoDir
                writeText (Join-Path $root 'pom.xml') "<project>`n  <dependencyManagement>`n    <dependencies>`n    </dependencies>`n  </dependencyManagement>`n</project>`n"
                $res = applyOp -Type 'maven-add-dependency' -Params @{ groupId = 'g'; artifactId = 'a'; version = '1' } -RepoDir $root
                $res.Error | Should -Match 'project-level'
            }
            It 'skips when pom.xml is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'maven-add-dependency' -Params @{ groupId = 'g'; artifactId = 'a'; version = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No pom.xml found'
            }
        }

        Context 'gradle-add-dependency' {
            BeforeAll {
                $script:groovyBuild = "plugins {`n    id 'java'`n}`n`ndependencies {`n    implementation 'org.slf4j:slf4j-api:2.0.0'`n}`n"
            }
            It 'adds a Groovy-DSL dependency after the opening line with detected indent' {
                $root = newRepoDir
                writeText (Join-Path $root 'build.gradle') $groovyBuild
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'org.apache.commons'; name = 'commons-lang3'; version = '3.14.0' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $txt = readText (Join-Path $root 'build.gradle')
                $txt | Should -Match "(?m)^    implementation 'org\.apache\.commons:commons-lang3:3\.14\.0'$"
                $txt | Should -Match 'slf4j-api:2\.0\.0'
            }
            It 'uses Kotlin-DSL syntax for .kts build files' {
                $root = newRepoDir
                writeText (Join-Path $root 'build.gradle.kts') "dependencies {`n    implementation(`"a:b:1`")`n}`n"
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'g'; name = 'n'; version = '2'; buildFilePath = 'build.gradle.kts' } -RepoDir $root
                $res.Changed | Should -BeTrue
                (readText (Join-Path $root 'build.gradle.kts')) | Should -Match 'implementation\("g:n:2"\)'
            }
            It 'is idempotent when group:name is already present (any version)' {
                $root = newRepoDir
                writeText (Join-Path $root 'build.gradle') $groovyBuild
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'org.slf4j'; name = 'slf4j-api'; version = '9.9.9' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already present'
            }
            It 'ignores an indented dependencies block (e.g. inside buildscript)' {
                $root = newRepoDir
                writeText (Join-Path $root 'build.gradle') "buildscript {`n    dependencies {`n        classpath 'c:g:1'`n    }`n}`n`ndependencies {`n    implementation 'a:b:1'`n}`n"
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'x'; name = 'y'; version = '1' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $txt = readText (Join-Path $root 'build.gradle')
                $txt.IndexOf("implementation 'x:y:1'") | Should -BeGreaterThan $txt.IndexOf("`ndependencies {")
            }
            It 'skips when the build file is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'g'; name = 'n'; version = '1' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No build.gradle found'
            }
            It 'errors when there is no top-level dependencies block' {
                $root = newRepoDir
                writeText (Join-Path $root 'build.gradle') "plugins {`n    id 'java'`n}`n"
                $res = applyOp -Type 'gradle-add-dependency' -Params @{ group = 'g'; name = 'n'; version = '1' } -RepoDir $root
                $res.Error | Should -Match 'top-level dependencies block'
            }
        }

        Context 'yaml-patch' {
            It 'sets a value at a dot-path, creating intermediate maps' {
                $root = newRepoDir
                writeText (Join-Path $root 'values.yaml') "name: app`n"
                $res = applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'image.tag'; value = 'latest' } -RepoDir $root
                $res.Changed | Should -BeTrue
                $data = ConvertFrom-Yaml (readText (Join-Path $root 'values.yaml'))
                $data.image.tag | Should -Be 'latest'
                $data.name | Should -Be 'app'
            }
            It 'coerces JSON values (boolean / number)' {
                $root = newRepoDir
                writeText (Join-Path $root 'values.yaml') "name: app`n"
                applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'enabled'; value = 'true' } -RepoDir $root | Out-Null
                applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'limits.retries'; value = '3' } -RepoDir $root | Out-Null
                $data = ConvertFrom-Yaml (readText (Join-Path $root 'values.yaml'))
                $data.enabled | Should -BeTrue
                $data.limits.retries | Should -Be 3
            }
            It 'is idempotent when the value already matches' {
                $root = newRepoDir
                writeText (Join-Path $root 'values.yaml') "enabled: true`n"
                $res = applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'enabled'; value = 'true' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'already set'
            }
            It 'skips when the file is missing' {
                $root = newRepoDir
                $res = applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'a'; value = 'x' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Message | Should -Match 'No values.yaml found'
            }
            It 'errors on invalid YAML without writing' {
                $root = newRepoDir
                $file = Join-Path $root 'values.yaml'
                writeText $file "foo: [unclosed`n  bar: broken`n"
                $before = readText $file
                $res = applyOp -Type 'yaml-patch' -Params @{ path = 'values.yaml'; pointer = 'a'; value = 'x' } -RepoDir $root
                $res.Changed | Should -BeFalse
                $res.Error | Should -Match 'invalid YAML'
                (readText $file) | Should -Be $before
            }
        }
    }
}

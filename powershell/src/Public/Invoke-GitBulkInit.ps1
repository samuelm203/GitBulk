function Invoke-GitBulkInit {
    <#
    .SYNOPSIS
        Interaktiver Generator für eine GitBulk-Config mit `operations:`-Block
        (Pendant zu `gitbulk init`, Config-Modus).

    .DESCRIPTION
        Führt per Prompts durch die verfügbaren Operationen (Get-GitBulkOperationInfo),
        fragt deren Parameter anhand der Metadaten ab, sammelt die übrigen
        Config-Felder und schreibt eine lauffähige YAML-Config. Die reine
        YAML-Erzeugung liegt in der testbaren Funktion New-GitBulkConfigYaml.

        Interaktiv (Read-Host) → nur im echten Terminal sinnvoll. Der
        Skript-Modus der Node-Version (eigenständiges .mjs/.ts) ist hier bewusst
        NICHT enthalten — für deklarative Änderungen genügt der operations-Block.

    .PARAMETER OutputPath
        Zielpfad der Config (Default: ./gitbulk.config.yaml).

    .PARAMETER Force
        Vorhandene Datei ohne Rückfrage überschreiben.

    .PARAMETER NoColor
        Ausgabe ohne Farben.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [string]$OutputPath,
        [switch]$Force,
        [switch]$NoColor
    )

    Write-GitBulkLine -Message '' -NoColor:$NoColor
    Write-GitBulkLine -Message '=== GitBulk init - operations config generator ===' -Color 'White' -NoColor:$NoColor

    $infos = @(Get-GitBulkOperationInfo)
    if ($infos.Count -eq 0) { [Console]::Error.WriteLine('No operations are registered.'); return 3 }

    # ── 1) Operationen zusammenstellen ───────────────────────────────
    $collected = [System.Collections.Generic.List[object]]::new()
    for (;;) {
        Write-GitBulkLine -Message '' -NoColor:$NoColor
        Write-GitBulkLine -Message 'Available operations:' -Color 'White' -NoColor:$NoColor
        for ($i = 0; $i -lt $infos.Count; $i++) {
            Write-GitBulkLine -Message ("  {0}. {1} - {2}" -f ($i + 1), $infos[$i].Type, $infos[$i].Description) -NoColor:$NoColor
        }
        $doneHint = if ($collected.Count -gt 0) { " or 'd' to finish" } else { '' }
        $sel = ([string](Read-Host -Prompt "Select an operation (1-$($infos.Count))$doneHint")).Trim()

        if ($collected.Count -gt 0 -and $sel -in @('d', 'D')) { break }

        $idx = 0
        if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $infos.Count) {
            [Console]::Error.WriteLine('Invalid selection.'); continue
        }

        $info = $infos[$idx - 1]
        Write-GitBulkLine -Message "Configuring `"$($info.Type)`":" -Color 'White' -NoColor:$NoColor
        $op = [ordered]@{ type = $info.Type }
        foreach ($p in $info.Params) {
            $val = Read-GitBulkParamValue -Param $p
            if ($null -ne $val) { $op[$p.Name] = $val }
        }
        $collected.Add($op)
        Write-GitBulkLine -Message "+ Added $($info.Type) ($($collected.Count) total)." -Color 'Green' -NoColor:$NoColor
    }

    # ── 2) Übrige Config-Felder ──────────────────────────────────────
    Write-GitBulkLine -Message '' -NoColor:$NoColor
    Write-GitBulkLine -Message 'Now the remaining config fields:' -Color 'White' -NoColor:$NoColor

    $rus = Read-GitBulkValidated -Prompt 'List of RUs, comma-separated' -Validator { param($r) Test-GitBulkRuList -InputObject $r }
    $ticket = Read-GitBulkValidated -Prompt 'Ticket (e.g. AKB-1234)' -Validator { param($r) Test-GitBulkTicket -InputString $r }
    $branch = Read-GitBulkValidated -Prompt 'Branch name' -Validator { param($r) Test-GitBulkBranchName -InputString $r }
    $commit = Read-GitBulkValidated -Prompt 'Commit message' -Validator { param($r) Test-GitBulkMessage -InputString $r }
    $prSummary = Read-GitBulkValidated -Prompt 'PR summary' -Validator { param($r) Test-GitBulkMessage -InputString $r }

    $yesNo = {
        param($r)
        $t = ([string]$r).Trim().ToLowerInvariant()
        if ($t -in @('y', 'yes', 'true', '1')) { return [pscustomobject]@{ Ok = $true; Value = $true; Error = $null } }
        if ($t -in @('n', 'no', 'false', '0')) { return [pscustomobject]@{ Ok = $true; Value = $false; Error = $null } }
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Please answer Y or N.' }
    }
    $notEmpty = {
        param($r)
        $t = ([string]$r).Trim()
        if ($t.Length -gt 0) { return [pscustomobject]@{ Ok = $true; Value = $t; Error = $null } }
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = 'Must not be empty.' }
    }

    $createPrOnError = Read-GitBulkValidated -Prompt 'If a code change fails, open a PR anyway? (Y/N)' -Validator $yesNo
    $platform = Read-GitBulkValidated -Prompt 'PR platform (bitbucket/github/gitlab/azure-devops)' -Validator {
        param($r)
        $t = ([string]$r).Trim().ToLowerInvariant()
        if ($t -in @('bitbucket', 'github', 'gitlab', 'azure-devops')) { return [pscustomobject]@{ Ok = $true; Value = $t; Error = $null } }
        return [pscustomobject]@{ Ok = $false; Value = $null; Error = "Please enter 'bitbucket', 'github', 'gitlab' or 'azure-devops'." }
    }

    $yamlArgs = @{
        Rus             = $rus
        Ticket          = $ticket
        Branch          = $branch
        CommitMessage   = $commit
        PrSummary       = $prSummary
        CreatePrOnError = $createPrOnError
        PrPlatform      = $platform
        Operations      = $collected.ToArray()
    }
    switch ($platform) {
        'bitbucket' {
            $yamlArgs.BitbucketWorkspace = Read-GitBulkValidated -Prompt 'Bitbucket workspace (slug/project key)' -Validator $notEmpty
        }
        'github' {
            $yamlArgs.GitHubOwner = Read-GitBulkValidated -Prompt 'GitHub owner (org/user)' -Validator $notEmpty
        }
        'gitlab' {
            $yamlArgs.GitLabNamespace = Read-GitBulkValidated -Prompt 'GitLab namespace (group/user)' -Validator $notEmpty
        }
        'azure-devops' {
            $yamlArgs.AzureOrganization = Read-GitBulkValidated -Prompt 'Azure DevOps organization' -Validator $notEmpty
            $yamlArgs.AzureProject = Read-GitBulkValidated -Prompt 'Azure DevOps project' -Validator $notEmpty
        }
    }

    $yaml = New-GitBulkConfigYaml @yamlArgs

    # ── 3) Zielpfad + Überschreiben ──────────────────────────────────
    $name = if ([string]::IsNullOrWhiteSpace($OutputPath)) { 'gitbulk.config.yaml' } else { $OutputPath }
    $target = if ([System.IO.Path]::IsPathRooted($name)) { $name } else { Join-Path (Get-Location).Path $name }

    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        $overwrite = Read-GitBulkValidated -Prompt "$target already exists. Overwrite? (Y/N)" -Validator $yesNo
        if (-not $overwrite) { Write-GitBulkLine -Message 'Aborted - no file written.' -Color 'Yellow' -NoColor:$NoColor; return 3 }
    }

    [System.IO.File]::WriteAllText($target, $yaml)
    Write-GitBulkLine -Message '' -NoColor:$NoColor
    Write-GitBulkLine -Message "+ Wrote config: $target" -Color 'Green' -NoColor:$NoColor
    Write-GitBulkLine -Message "  Run it via: ./gitbulk.ps1 -Config `"$target`"" -NoColor:$NoColor
    return 0
}

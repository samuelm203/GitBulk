# Normalisiert + validiert eine rohe Config (Hashtable aus JSON/YAML) zu einer
# vollständigen GitBulk-Config mit Defaults. Sammelt ALLE Fehler und wirft am
# Ende eine aggregierte Meldung (analog zu Zod in der Node-Version).

function ConvertTo-GitBulkConfig {
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)] $Raw,
        [string]$BaseDir = (Get-Location).Path
    )

    if ($Raw -isnot [System.Collections.IDictionary]) {
        throw 'GitBulk config must be a mapping/object.'
    }

    $errors = [System.Collections.Generic.List[string]]::new()
    $cfg = [ordered]@{}

    # ── Pflichtfelder ────────────────────────────────────────────────
    $r = Test-GitBulkRuList $Raw['rus']
    if ($r.Ok) {
        $cfg.rus = $r.Value
        # Per-RU-Workspace-Overrides nur ablegen, wenn welche angegeben wurden.
        if (($r.PSObject.Properties.Name -contains 'Workspaces') -and $r.Workspaces.Count -gt 0) {
            $cfg.ruWorkspaces = $r.Workspaces
        }
    } else { $errors.Add($r.Error) }

    $r = Test-GitBulkTicket ([string]$Raw['ticket'])
    if ($r.Ok) { $cfg.ticket = $r.Value } else { $errors.Add($r.Error) }

    $r = Test-GitBulkBranchName ([string]$Raw['branch'])
    if ($r.Ok) { $cfg.branch = $r.Value } else { $errors.Add($r.Error) }

    $r = Test-GitBulkMessage ([string]$Raw['commitMessage'])
    if ($r.Ok) { $cfg.commitMessage = $r.Value } else { $errors.Add($r.Error) }

    $r = Test-GitBulkMessage ([string]$Raw['prSummary'])
    if ($r.Ok) { $cfg.prSummary = $r.Value } else { $errors.Add($r.Error) }

    if ($null -eq $Raw['createPrOnError']) {
        $errors.Add('Error: createPrOnError is required')
    } else {
        $cfg.createPrOnError = [bool]$Raw['createPrOnError']
    }

    # ── script XOR operations ────────────────────────────────────────
    $hasScript = -not [string]::IsNullOrWhiteSpace([string]$Raw['script'])
    $opsRaw = $Raw['operations']
    $opsProvided = $null -ne $opsRaw
    # operations MUSS eine Liste/ein Array sein. Ein Mapping (Dictionary) ist
    # zwar IEnumerable, wäre laut Schema (z.array(...)) aber ungültig — sonst
    # würde @($dict) es still in ein 1-Element-Array verpacken.
    $opsIsList = $opsRaw -is [System.Collections.IList]
    $hasOps = $opsIsList -and (@($opsRaw).Count -gt 0)

    if ($opsProvided -and -not $opsIsList) {
        $errors.Add("Error: 'operations' must be an array")
    } elseif ($hasScript -and $hasOps) {
        $errors.Add("Error: set either 'script' or 'operations', not both")
    } elseif (-not $hasScript -and -not $hasOps) {
        $errors.Add("Error: one of 'script' or 'operations' is required")
    } elseif ($hasScript) {
        $r = Test-GitBulkFilePath -InputString ([string]$Raw['script']) -BaseDir $BaseDir
        if ($r.Ok) { $cfg.script = $r.Value } else { $errors.Add($r.Error) }
    } else {
        $opList = [System.Collections.Generic.List[object]]::new()
        $i = 0
        foreach ($op in @($opsRaw)) {
            if ($op -isnot [System.Collections.IDictionary] -or [string]::IsNullOrWhiteSpace([string]$op['type'])) {
                $errors.Add("Error: operations[$i] needs a non-empty 'type'")
            } else {
                $opType = [string]$op['type']
                $known = Get-GitBulkOperation -Type $opType
                if ($null -eq $known) {
                    $errors.Add("Error: operations[$i] unknown type '$opType'")
                } else {
                    # Pflicht-Parameter (aus den Params-Metadaten) müssen vorhanden
                    # sein. Wert-Prüfung (leerer Pfad, ungültige Regex) passiert zur
                    # Laufzeit in apply.
                    $required = @($known.Params | Where-Object { $_.Required } | ForEach-Object { $_.Name })
                    foreach ($req in $required) {
                        if (-not $op.Contains($req)) {
                            $errors.Add("Error: operations[$i] ($opType) requires '$req'")
                        }
                    }
                    $opList.Add($op)
                }
            }
            $i++
        }
        $cfg.operations = $opList.ToArray()
    }

    # ── Optionale Felder mit Defaults ────────────────────────────────
    $sb = [string]$Raw['sourceBranch']
    $cfg.sourceBranch = if ([string]::IsNullOrWhiteSpace($sb)) { 'master' } else { $sb }
    $cfg.dryRun = [bool]$Raw['dryRun']
    $cfg.skipHooks = [bool]$Raw['skipHooks']
    $cfg.cloneIfMissing = [bool]$Raw['cloneIfMissing']

    if (-not [string]::IsNullOrWhiteSpace([string]$Raw['cloneBaseUrl'])) {
        $cfg.cloneBaseUrl = [string]$Raw['cloneBaseUrl']
    }
    if ($cfg.cloneIfMissing -and -not $cfg.Contains('cloneBaseUrl')) {
        $errors.Add('Error: cloneBaseUrl is required when cloneIfMissing is true')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Raw['workspaceDir'])) {
        $cfg.workspaceDir = [string]$Raw['workspaceDir']
    }

    $cfg.concurrency = Get-GbBoundedInt -Value $Raw['concurrency'] -Default 1 -Min 1 -Max 50 `
        -Name 'concurrency' -Errors $errors
    $cfg.commandTimeoutMs = Get-GbBoundedInt -Value $Raw['commandTimeoutMs'] -Default 120000 -Min 1000 -Max ([int]::MaxValue) `
        -Name 'commandTimeoutMs' -Errors $errors

    # retry (Defaults 3 / 1000 / 30000) — mit Bounds wie das Zod-Schema:
    # maxAttempts 1-20, backoffMs >= 0, maxBackoffMs >= 0.
    $retry = $Raw['retry']
    if ($retry -isnot [System.Collections.IDictionary]) { $retry = @{} }
    $cfg.retry = [ordered]@{
        maxAttempts  = Get-GbBoundedInt -Value $retry['maxAttempts'] -Default 3 -Min 1 -Max 20 `
            -Name 'retry.maxAttempts' -Errors $errors
        backoffMs    = Get-GbBoundedInt -Value $retry['backoffMs'] -Default 1000 -Min 0 -Max ([int]::MaxValue) `
            -Name 'retry.backoffMs' -Errors $errors
        maxBackoffMs = Get-GbBoundedInt -Value $retry['maxBackoffMs'] -Default 30000 -Min 0 -Max ([int]::MaxValue) `
            -Name 'retry.maxBackoffMs' -Errors $errors
    }

    # ── PR-Plattform + Sub-Config ────────────────────────────────────
    $platform = [string]$Raw['prPlatform']
    if ([string]::IsNullOrWhiteSpace($platform)) {
        $errors.Add("Error: prPlatform is required ('bitbucket', 'github', 'gitlab' or 'azure-devops')")
    } elseif ($platform -notin @('bitbucket', 'github', 'gitlab', 'azure-devops')) {
        $errors.Add("Error: invalid prPlatform '$platform' (use 'bitbucket', 'github', 'gitlab' or 'azure-devops')")
    } else {
        $cfg.prPlatform = $platform
        switch ($platform) {
            'bitbucket' {
                $bb = $Raw['bitbucket']
                if ($bb -isnot [System.Collections.IDictionary]) {
                    $errors.Add("Error: bitbucket config is required when prPlatform is 'bitbucket'")
                } else {
                    if ([string]::IsNullOrWhiteSpace([string]$bb['workspace'])) { $errors.Add('Error: bitbucket.workspace is required') }
                    $variant = if ([string]::IsNullOrWhiteSpace([string]$bb['apiVariant'])) { 'cloud' } else { [string]$bb['apiVariant'] }
                    if ($variant -notin @('cloud', 'server')) { $errors.Add("Error: bitbucket.apiVariant must be 'cloud' or 'server'") }
                    $sub = [ordered]@{
                        workspace    = [string]$bb['workspace']
                        apiVariant   = $variant
                        targetBranch = if ([string]::IsNullOrWhiteSpace([string]$bb['targetBranch'])) { 'master' } else { [string]$bb['targetBranch'] }
                        reviewers    = Get-GbReviewerList -Value $bb['reviewers'] -Name 'bitbucket.reviewers' -Errors $errors
                    }
                    if (-not [string]::IsNullOrWhiteSpace([string]$bb['apiBaseUrl'])) { $sub.apiBaseUrl = [string]$bb['apiBaseUrl'] }
                    $cfg.bitbucket = $sub
                }
            }
            'github' {
                $gh = $Raw['github']
                if ($gh -isnot [System.Collections.IDictionary]) {
                    $errors.Add("Error: github config is required when prPlatform is 'github'")
                } else {
                    if ([string]::IsNullOrWhiteSpace([string]$gh['owner'])) { $errors.Add('Error: github.owner is required') }
                    $sub = [ordered]@{
                        owner        = [string]$gh['owner']
                        targetBranch = if ([string]::IsNullOrWhiteSpace([string]$gh['targetBranch'])) { 'main' } else { [string]$gh['targetBranch'] }
                        reviewers    = Get-GbReviewerList -Value $gh['reviewers'] -Name 'github.reviewers' -Errors $errors
                    }
                    if (-not [string]::IsNullOrWhiteSpace([string]$gh['apiBaseUrl'])) { $sub.apiBaseUrl = [string]$gh['apiBaseUrl'] }
                    $cfg.github = $sub
                }
            }
            'gitlab' {
                $gl = $Raw['gitlab']
                if ($gl -isnot [System.Collections.IDictionary]) {
                    $errors.Add("Error: gitlab config is required when prPlatform is 'gitlab'")
                } else {
                    if ([string]::IsNullOrWhiteSpace([string]$gl['namespace'])) { $errors.Add('Error: gitlab.namespace is required') }
                    $sub = [ordered]@{
                        namespace    = [string]$gl['namespace']
                        targetBranch = if ([string]::IsNullOrWhiteSpace([string]$gl['targetBranch'])) { 'main' } else { [string]$gl['targetBranch'] }
                        reviewers    = Get-GbReviewerList -Value $gl['reviewers'] -Name 'gitlab.reviewers' -Errors $errors
                    }
                    if (-not [string]::IsNullOrWhiteSpace([string]$gl['apiBaseUrl'])) { $sub.apiBaseUrl = [string]$gl['apiBaseUrl'] }
                    $cfg.gitlab = $sub
                }
            }
            'azure-devops' {
                $az = $Raw['azureDevOps']
                if ($az -isnot [System.Collections.IDictionary]) {
                    $errors.Add("Error: azureDevOps config is required when prPlatform is 'azure-devops'")
                } else {
                    if ([string]::IsNullOrWhiteSpace([string]$az['organization'])) { $errors.Add('Error: azureDevOps.organization is required') }
                    if ([string]::IsNullOrWhiteSpace([string]$az['project'])) { $errors.Add('Error: azureDevOps.project is required') }
                    $sub = [ordered]@{
                        organization = [string]$az['organization']
                        project      = [string]$az['project']
                        # Node-Parität: Azure-Default ist 'master' (wie Bitbucket).
                        targetBranch = if ([string]::IsNullOrWhiteSpace([string]$az['targetBranch'])) { 'master' } else { [string]$az['targetBranch'] }
                        reviewers    = Get-GbReviewerList -Value $az['reviewers'] -Name 'azureDevOps.reviewers' -Errors $errors
                    }
                    if (-not [string]::IsNullOrWhiteSpace([string]$az['apiBaseUrl'])) { $sub.apiBaseUrl = [string]$az['apiBaseUrl'] }
                    $cfg.azureDevOps = $sub
                }
            }
        }
    }

    if ($errors.Count -gt 0) {
        throw ("Invalid GitBulk config:`n  - " + ($errors -join "`n  - "))
    }

    return $cfg
}

function Get-GbBoundedInt {
    # Parst eine optionale Ganzzahl mit Default und Grenzen; meldet Fehler in $Errors.
    param(
        $Value,
        [int]$Default,
        [int]$Min,
        [int]$Max,
        [string]$Name,
        [System.Collections.Generic.List[string]]$Errors
    )
    if ($null -eq $Value) { return $Default }
    $parsed = 0
    if (-not [int]::TryParse([string]$Value, [ref]$parsed) -or $parsed -lt $Min -or $parsed -gt $Max) {
        $Errors.Add("Error: $Name must be an integer between $Min and $Max")
        return $Default
    }
    return $parsed
}

function Get-GbReviewerList {
    # Validiert ein optionales Reviewer-Feld als Array nicht-leerer Strings
    # (Zod: z.array(z.string().min(1)).default([])). Meldet Fehler in $Errors.
    param(
        $Value,
        [string]$Name,
        [System.Collections.Generic.List[string]]$Errors
    )
    if ($null -eq $Value) { return @() }
    # Ein Skalar-String oder ein Mapping ist kein gültiges Array.
    if ($Value -is [string] -or $Value -is [System.Collections.IDictionary] -or $Value -isnot [System.Collections.IList]) {
        $Errors.Add("Error: $Name must be an array of non-empty strings")
        return @()
    }
    foreach ($r in $Value) {
        if ($r -isnot [string] -or [string]::IsNullOrWhiteSpace($r)) {
            $Errors.Add("Error: $Name must contain only non-empty strings")
            return @()
        }
    }
    return @($Value)
}

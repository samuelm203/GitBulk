function New-GitBulkTemplate {
    <#
    .SYNOPSIS
        Liefert eine fertige, schema-gültige GitBulk-YAML-Config als Text — ohne
        interaktive Abfragen (Pendant zu `gitbulk template` der Node-Version).

    .DESCRIPTION
        Reine, prompt-freie Logik (daher unit-testbar): gibt eine von zwei
        Vorlagen zurück.
          - 'full'    (Default): alle Felder mit Kommentaren und Defaults.
          - 'minimal' (-Kind minimal): nur die Pflichtfelder.

        -Platform wählt den emittierten PR-Plattform-Block (Default: bitbucket) —
        alle vier Adapter werden unterstützt.

        Beide Vorlagen nutzen einen `operations:`-Block (regex-replace), sind also
        ohne eine real existierende Skriptdatei sofort gültig. Tokens stehen NIE in
        der Vorlage — sie kommen zur Laufzeit aus Umgebungsvariablen.

    .PARAMETER Kind
        'full' (Default) oder 'minimal'.

    .PARAMETER Platform
        'bitbucket' (Default), 'github', 'gitlab' oder 'azure-devops'.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [ValidateSet('full', 'minimal')]
        [string]$Kind = 'full',

        [ValidateSet('bitbucket', 'github', 'gitlab', 'azure-devops')]
        [string]$Platform = 'bitbucket'
    )

    $tokenVar = switch ($Platform) {
        'bitbucket' { 'GITBULK_BITBUCKET_TOKEN' }
        'github' { 'GITBULK_GITHUB_TOKEN' }
        'gitlab' { 'GITBULK_GITLAB_TOKEN' }
        'azure-devops' { 'GITBULK_AZURE_DEVOPS_TOKEN' }
    }

    $minimalBlocks = @{
        'bitbucket'    = @'
prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
'@
        'github'       = @'
prPlatform: github
github:
  owner: my-org
'@
        'gitlab'       = @'
prPlatform: gitlab
gitlab:
  namespace: my-group
'@
        'azure-devops' = @'
prPlatform: azure-devops
azureDevOps:
  organization: my-org
  project: my-project
'@
    }

    $fullBlocks = @{
        'bitbucket'    = @'
prPlatform: bitbucket              # bitbucket | github | gitlab | azure-devops
bitbucket:
  workspace: my-workspace          # Workspace slug (cloud) / project key (server)
  apiVariant: cloud                # cloud | server
  targetBranch: master
  reviewers: []                    # UUIDs (cloud) or usernames
  # apiBaseUrl: https://bitbucket.example.com   # for server / custom proxy
'@
        'github'       = @'
prPlatform: github                 # bitbucket | github | gitlab | azure-devops
github:
  owner: my-org                    # user or organization
  targetBranch: main
  reviewers: []                    # GitHub logins
  # apiBaseUrl: https://ghe.example.com/api/v3   # for GitHub Enterprise
'@
        'gitlab'       = @'
prPlatform: gitlab                 # bitbucket | github | gitlab | azure-devops
gitlab:
  namespace: my-group              # group or user; project = <namespace>/<repo>
  targetBranch: main
  reviewers: []                    # numeric GitLab user ids (as strings)
  # apiBaseUrl: https://gitlab.example.com/api/v4   # for self-hosted GitLab
'@
        'azure-devops' = @'
prPlatform: azure-devops           # bitbucket | github | gitlab | azure-devops
azureDevOps:
  organization: my-org             # dev.azure.com/<organization>; on-prem: the collection
  project: my-project              # repo is addressed as <organization>/<project>/<repo>
  targetBranch: master
  reviewers: []                    # Azure user ids (GUIDs)
  # apiBaseUrl: https://tfs.example.com/tfs   # on-prem: instance root WITHOUT the collection
'@
    }

    $minimalBody = @'
rus:
  - my-repo
ticket: AKB-1234
branch: feature/my-change

# Code change: EXACTLY ONE of 'operations:' OR 'script:'.
operations:
  - type: regex-replace
    path: pom.xml
    pattern: '<java.version>17</java.version>'
    replacement: '<java.version>21</java.version>'

commitMessage: 'update Java version'
prSummary: 'Update Java version to 21'
createPrOnError: false

'@

    $fullBody = @'
# -- Required fields --------------------------------------------------
rus:                               # Repository units (repo slugs)
  - my-repo
  - another-repo
ticket: AKB-1234                   # Ticket id; prefixes branch and commit
branch: feature/my-change          # Feature branch (becomes <ticket>-<branch>)
commitMessage: 'update Java version'
prSummary: 'Update Java version to 21'
createPrOnError: false             # Open a PR even if the code change fails

# Code change: EXACTLY ONE of 'operations:' OR 'script:'.
operations:                        # declarative, chainable operations
  - type: regex-replace
    path: pom.xml
    pattern: '<java.version>17</java.version>'
    replacement: '<java.version>21</java.version>'
# script: ./scripts/change.ps1     # Alternative: free script (.ps1/.sh/.mjs/...)

# -- Optional fields (with default) -----------------------------------
workspaceDir: .                    # Root directory of the RU repos (default: CWD)
sourceBranch: master               # Base branch for the feature branch
cloneIfMissing: false              # Clone missing repos automatically
# cloneBaseUrl: https://bitbucket.org/my-workspace   # required if cloneIfMissing: true
concurrency: 1                     # Parallel RUs (1-50)
commandTimeoutMs: 120000           # Timeout per git command (ms)
dryRun: false                      # No write actions (push, PR API)
skipHooks: false                   # Disable git hooks
retry:                             # Push retry (exponential backoff)
  maxAttempts: 3
  backoffMs: 1000
  maxBackoffMs: 30000

# -- PR platform ------------------------------------------------------
# Other platform? ./gitbulk.ps1 -Template -Platform bitbucket|github|gitlab|azure-devops
'@

    if ($Kind -eq 'minimal') {
        $header = @(
            '# GitBulk — minimal config (required fields only).'
            "# Generated with: ./gitbulk.ps1 -Template -Minimal -Platform $Platform"
            '# Full template with every option: ./gitbulk.ps1 -Template'
            ''
        ) -join "`n"
        return $header + $minimalBody + $minimalBlocks[$Platform]
    }

    $header = @(
        '# GitBulk — full config with every option and its default.'
        "# Generated with: ./gitbulk.ps1 -Template -Platform $Platform"
        '# Tokens are NEVER in this file — they come from env vars'
        "# (here: $tokenVar)."
        ''
    ) -join "`n"
    return $header + $fullBody + "`n" + $fullBlocks[$Platform]
}

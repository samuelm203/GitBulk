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

        Beide Vorlagen nutzen einen `operations:`-Block (regex-replace), sind also
        ohne eine real existierende Skriptdatei sofort gültig. Tokens stehen NIE in
        der Vorlage — sie kommen zur Laufzeit aus Umgebungsvariablen
        (GITBULK_BITBUCKET_TOKEN / GITBULK_GITHUB_TOKEN).

    .PARAMETER Kind
        'full' (Default) oder 'minimal'.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [ValidateSet('full', 'minimal')]
        [string]$Kind = 'full'
    )

    $minimal = @'
# GitBulk — minimal config (required fields only).
# Generated with: ./gitbulk.ps1 -Template -Minimal
# Full template with every option: ./gitbulk.ps1 -Template

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

prPlatform: bitbucket
bitbucket:
  workspace: my-workspace
'@

    $full = @'
# GitBulk — full config with every option and its default.
# Generated with: ./gitbulk.ps1 -Template
# Tokens are NEVER in this file — they come from env vars
# (GITBULK_BITBUCKET_TOKEN / GITBULK_GITHUB_TOKEN).

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
prPlatform: bitbucket              # bitbucket | github  (azure-devops: not implemented)
bitbucket:
  workspace: my-workspace          # Workspace slug (cloud) / project key (server)
  apiVariant: cloud                # cloud | server
  targetBranch: master
  reviewers: []                    # UUIDs (cloud) or usernames
  # apiBaseUrl: https://bitbucket.example.com   # for server / custom proxy
# github:                          # instead of bitbucket — set prPlatform: github
#   owner: my-org
#   targetBranch: main
#   reviewers: []
#   apiBaseUrl: https://ghe.example.com/api/v3   # for GitHub Enterprise
'@

    if ($Kind -eq 'minimal') { return $minimal }
    return $full
}

function Format-GitBulkStatusTable {
    <#
    .SYNOPSIS
        Rendert einen Status-Report als menschen-lesbare Tabelle (Plain-Text):
        RU ▸ PR ▸ STATE ▸ APPROVALS ▸ CI ▸ URL plus eine Summary-Zeile.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Report)

    function pad([string]$Text, [int]$Width) {
        if ($Text.Length -ge $Width) { return $Text }
        return $Text + (' ' * ($Width - $Text.Length))
    }

    $rows = foreach ($r in @($Report.Results)) {
        $isError = $r.Error -and "$($r.Error)".Length -gt 0
        $approvals = '-'
        if (-not $isError -and $r.Approvals) {
            $approvals = if ($null -ne $r.Approvals.Required) { "$($r.Approvals.Approved)/$($r.Approvals.Required)" } else { "$($r.Approvals.Approved)" }
        }
        [pscustomobject]@{
            Ru    = [string]$r.Ru
            Pr    = if ($null -ne $r.Id) { "#$($r.Id)" } else { '-' }
            State = if ($isError) { 'error' } else { [string]$r.State }
            Appr  = $approvals
            Ci    = if ($isError) { '-' } elseif ($r.Ci) { [string]$r.Ci } else { '-' }
            Note  = if ($isError) { "(error: $($r.Error))" } elseif ($r.Url) { [string]$r.Url } else { '' }
        }
    }
    $rows = @($rows)

    $wRu = (@('RU') + ($rows | ForEach-Object { $_.Ru }) | Measure-Object -Maximum -Property Length).Maximum
    $wPr = (@('PR') + ($rows | ForEach-Object { $_.Pr }) | Measure-Object -Maximum -Property Length).Maximum
    $wState = (@('STATE') + ($rows | ForEach-Object { $_.State }) | Measure-Object -Maximum -Property Length).Maximum
    $wAppr = (@('APPROVALS') + ($rows | ForEach-Object { $_.Appr }) | Measure-Object -Maximum -Property Length).Maximum
    $wCi = (@('CI') + ($rows | ForEach-Object { $_.Ci }) | Measure-Object -Maximum -Property Length).Maximum

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Ticket $($Report.Ticket) · branch $($Report.SourceBranch) · $($Report.Platform) · $(@($Report.Results).Count) RUs")
    $lines.Add('')
    $lines.Add("$(pad 'RU' $wRu)  $(pad 'PR' $wPr)  $(pad 'STATE' $wState)  $(pad 'APPROVALS' $wAppr)  $(pad 'CI' $wCi)  URL")
    foreach ($x in $rows) {
        $line = "$(pad $x.Ru $wRu)  $(pad $x.Pr $wPr)  $(pad $x.State $wState)  $(pad $x.Appr $wAppr)  $(pad $x.Ci $wCi)  $($x.Note)"
        $lines.Add($line.TrimEnd())
    }

    $t = $Report.Totals
    $lines.Add('')
    $summary = "Summary: $($t.Merged) merged · $($t.Open) open · $($t.Declined) declined · $($t.None) none"
    if ($t.Errored -gt 0) { $summary += " · $($t.Errored) error" }
    $lines.Add($summary)

    return ($lines -join "`n")
}

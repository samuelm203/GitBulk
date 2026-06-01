# JSON-Helfer für die json-/npm-Operationen (Pendant zu
# node_ts/src/operations/json-util.ts).
#
# Ziel: vorhandene JSON-Dateien möglichst schonend bearbeiten — Schlüssel-
# REIHENFOLGE und EINRÜCKUNG der Originaldatei beibehalten, damit Diffs minimal
# bleiben. PowerShells eingebautes ConvertTo-Json kann das nicht (feste
# 2-Leerzeichen-Einrückung; [hashtable] verliert zudem die Reihenfolge), daher
# ein eigener, kleiner Serializer + ordnungserhaltender Parser.

# Escapt einen String für die JSON-Ausgabe (wie JSON.stringify: nur ", \, die
# üblichen Steuerzeichen-Kürzel und sonstige Steuerzeichen < 0x20 als \uXXXX —
# KEIN Escapen von /, <, >, ' oder Unicode). Zeichenweise über Codepoints, damit
# keine Steuerzeichen-Literale im Quelltext stehen.
function Format-GitBulkJsonString {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $sb = [System.Text.StringBuilder]::new()
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int][char]$ch
        if ($ch -eq '"') { [void]$sb.Append('\"') }
        elseif ($ch -eq '\') { [void]$sb.Append('\\') }
        elseif ($code -eq 8) { [void]$sb.Append('\b') }
        elseif ($code -eq 9) { [void]$sb.Append('\t') }
        elseif ($code -eq 10) { [void]$sb.Append('\n') }
        elseif ($code -eq 12) { [void]$sb.Append('\f') }
        elseif ($code -eq 13) { [void]$sb.Append('\r') }
        elseif ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($ch) }
    }
    return $sb.ToString()
}

# Ermittelt die Einrückung einer JSON-Datei aus ihrem Text: Anzahl Leerzeichen,
# "`t" bei Tabs, sonst 2 als Default. (Pendant zu detectJsonIndent.)
function Get-GitBulkJsonIndent {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $m = [regex]::Match($Text, "`n([ `t]+)\S")
    if (-not $m.Success) { return 2 }
    $ws = $m.Groups[1].Value
    if ($ws.Contains("`t")) { return "`t" }
    return $ws.Length
}

# Wandelt ein von ConvertFrom-Json geliefertes Objekt rekursiv in eine
# ordnungserhaltende Struktur um: PSCustomObject → [ordered]@{}, Arrays → Array,
# Skalare bleiben. So bleibt die Schlüssel-Reihenfolge erhalten und die Struktur
# ist leicht mutierbar.
function ConvertTo-GitBulkOrderedNode {
    [CmdletBinding()]
    param([AllowNull()]$Node)

    if ($null -eq $Node) { return $null }
    if ($Node -is [string] -or $Node -is [bool] -or $Node -is [int64] -or $Node -is [int32] -or
        $Node -is [double] -or $Node -is [decimal] -or $Node -is [single]) {
        return $Node
    }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        foreach ($p in $Node.PSObject.Properties) {
            $ordered[$p.Name] = ConvertTo-GitBulkOrderedNode $p.Value
        }
        return $ordered
    }
    if ($Node -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($k in $Node.Keys) { $ordered[[string]$k] = ConvertTo-GitBulkOrderedNode $Node[$k] }
        return $ordered
    }
    if ($Node -is [System.Collections.IEnumerable]) {
        $list = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Node) { $list.Add((ConvertTo-GitBulkOrderedNode $item)) }
        return , $list.ToArray()
    }
    return $Node
}

# Parst JSON-Text in eine ordnungserhaltende Struktur. Wirft bei ungültigem JSON
# (vom Aufrufer abgefangen → Operation-Error).
function ConvertFrom-GitBulkJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $parsed = $Text | ConvertFrom-Json
    return (ConvertTo-GitBulkOrderedNode $parsed)
}

# Serialisiert eine Struktur ([ordered]/Array/Skalar) als JSON-Text mit der
# gegebenen Einrückung (int = Leerzeichen, "`t" = Tab). -Compact erzeugt
# whitespace-freies JSON (nur für Vergleiche). (Pendant zu JSON.stringify.)
function ConvertTo-GitBulkJson {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowNull()]$Value,
        $Indent = 2,
        [switch]$Compact,
        [int]$Level = 0
    )

    $nl = if ($Compact) { '' } else { "`n" }
    $unit = if ($Compact) { '' } elseif ($Indent -is [string]) { $Indent } else { ' ' * [int]$Indent }
    $pad = $unit * ($Level + 1)
    $padEnd = $unit * $Level
    $colon = if ($Compact) { ':' } else { ': ' }

    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [string]) { return '"' + (Format-GitBulkJsonString $Value) + '"' }
    if ($Value -is [int64] -or $Value -is [int32] -or $Value -is [double] -or
        $Value -is [decimal] -or $Value -is [single]) {
        return [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Keys)
        if ($keys.Count -eq 0) { return '{}' }
        $entries = foreach ($k in $keys) {
            $pad + '"' + (Format-GitBulkJsonString ([string]$k)) + '"' + $colon +
            (ConvertTo-GitBulkJson -Value $Value[$k] -Indent $Indent -Compact:$Compact -Level ($Level + 1))
        }
        return '{' + $nl + ($entries -join (',' + $nl)) + $nl + $padEnd + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value)
        if ($items.Count -eq 0) { return '[]' }
        $entries = foreach ($it in $items) {
            $pad + (ConvertTo-GitBulkJson -Value $it -Indent $Indent -Compact:$Compact -Level ($Level + 1))
        }
        return '[' + $nl + ($entries -join (',' + $nl)) + $nl + $padEnd + ']'
    }
    # Fallback: als String behandeln.
    return '"' + (Format-GitBulkJsonString ([string]$Value)) + '"'
}

# Interpretiert einen String als JSON, wenn möglich ("true" → $true, "42" → 42,
# '"x"' → "x", '{"a":1}' → Objekt), sonst als rohen String. (Pendant zu
# coerceJsonValue.)
function Resolve-GitBulkJsonValue {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Raw)

    try {
        $parsed = $Raw | ConvertFrom-Json -ErrorAction Stop
        return (ConvertTo-GitBulkOrderedNode $parsed)
    } catch {
        return $Raw
    }
}

# Liefert @{ Found; Value } für einen Dot-Pfad (z. B. "scripts.build").
function Get-GitBulkJsonDotValue {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)]$Data, [Parameter(Mandatory)][string]$DotPath)

    $cur = $Data
    foreach ($k in $DotPath.Split('.')) {
        if ($cur -is [System.Collections.IDictionary] -and $cur.Contains($k)) {
            $cur = $cur[$k]
        } else {
            return @{ Found = $false; Value = $null }
        }
    }
    return @{ Found = $true; Value = $cur }
}

# Setzt einen Wert an einem Dot-Pfad und legt fehlende Zwischenobjekte an
# (mutiert $Data in place). (Pendant zu setByDotPath.)
function Set-GitBulkJsonDotValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Data,
        [Parameter(Mandatory)][string]$DotPath,
        [AllowNull()]$Value
    )

    $keys = $DotPath.Split('.')
    $cur = $Data
    for ($i = 0; $i -lt $keys.Count - 1; $i++) {
        $k = $keys[$i]
        $next = if ($cur.Contains($k)) { $cur[$k] } else { $null }
        if ($next -isnot [System.Collections.IDictionary]) {
            $next = [ordered]@{}
            $cur[$k] = $next
        }
        $cur = $cur[$k]
    }
    $cur[$keys[$keys.Count - 1]] = $Value
}

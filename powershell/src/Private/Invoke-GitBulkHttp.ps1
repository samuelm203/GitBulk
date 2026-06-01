# Dünner HTTP-Wrapper um Invoke-RestMethod (Result-Style, wirft NIE).
#
# Kapselt das -SkipHttpErrorCheck/-StatusCodeVariable-Muster an EINER Stelle und
# liefert @{ StatusCode; Body; Error }. Die PR-Adapter bauen darauf auf; Tests
# mocken einfach diese Funktion statt Invoke-RestMethod (kein Live-HTTP nötig).

function Invoke-GitBulkHttp {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'Get',
        [hashtable]$Headers,
        $Body
    )

    $params = @{
        Uri                = $Uri
        Method             = $Method
        SkipHttpErrorCheck = $true
        StatusCodeVariable = 'gbStatus'
    }
    if ($Headers) { $params.Headers = $Headers }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10)
        $params.ContentType = 'application/json'
    }

    try {
        $gbStatus = 0
        $resp = Invoke-RestMethod @params
        return @{ StatusCode = [int]$gbStatus; Body = $resp; Error = $null }
    } catch {
        # Netzwerk-/DNS-/TLS-Fehler (kein HTTP-Status).
        return @{ StatusCode = 0; Body = $null; Error = $_.Exception.Message }
    }
}

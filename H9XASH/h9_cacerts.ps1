# h9_cacerts.ps1 -- gives the game's two certificate lists the certificates this PC trusts.
#
# The game checks havoc9.org's certificate against lists of its own, not against Windows':
#   ts\addons\amxmodx\data\amxx_easy_http_cacert.pem   the game server's web module (h9_presence, ts_advertise)
#   valve\cacert.pem                                   the engine (the server browser's green or red chain, the
#                                                      link, pictures): a loose file here is read before the
#                                                      cacert.pem inside valve\extras.pk3
# Both start as Mozilla's list (curl.se). An antivirus that scans HTTPS (Avast, AVG, Kaspersky, ESET, Bitdefender
# and others) puts its own certificate in front of every site, and only Windows knows it: without this step the
# game cannot reach havoc9.org on such a PC. h9xash.bat and h9xash_server.bat run it on every launch, so each list
# is Mozilla's plus the certificates in Windows' trusted root stores right now (one that Windows has since dropped,
# or an antivirus since switched off, drops out again). This is the trust a browser on this PC gives.
#
# The Mozilla part is everything above the marker line in amxx_easy_http_cacert.pem; an update that ships a new list
# replaces the whole file, and the next launch adds this PC's certificates below it again. If anything fails, the
# lists stay as they are and the game starts anyway.

$ErrorActionPreference = 'Stop'
$Marker = '# ---- H9: the certificates this PC trusts (h9_cacerts.ps1, on every launch) ----'
try {
    $root = $PSScriptRoot
    $amxx = Join-Path $root 'ts\addons\amxmodx\data\amxx_easy_http_cacert.pem'
    $engine = Join-Path $root 'valve\cacert.pem'
    if (-not (Test-Path -LiteralPath $amxx)) { exit 0 }

    $text = [IO.File]::ReadAllText($amxx)
    $at = $text.IndexOf($Marker)
    $base = if ($at -ge 0) { $text.Substring(0, $at) } else { $text }
    $base = $base.TrimEnd() + "`n"

    # Windows' trusted roots (the machine's and this user's), each once, in force today, and not on Windows' own
    # list of distrusted certificates
    $now = Get-Date
    $bad = @{}
    foreach ($s in 'Cert:\LocalMachine\Disallowed', 'Cert:\CurrentUser\Disallowed') {
        foreach ($c in @(Get-ChildItem -LiteralPath $s -ErrorAction SilentlyContinue)) { $bad[$c.Thumbprint] = $true }
    }
    $seen = @{}
    $pem = New-Object System.Text.StringBuilder
    [void]$pem.Append("`n$Marker`n")
    foreach ($s in 'Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root') {
        foreach ($c in @(Get-ChildItem -LiteralPath $s -ErrorAction SilentlyContinue)) {
            if ($seen.ContainsKey($c.Thumbprint) -or $bad.ContainsKey($c.Thumbprint)) { continue }
            if ($c.NotAfter -lt $now -or $c.NotBefore -gt $now) { continue }
            $seen[$c.Thumbprint] = $true
            $b64 = [Convert]::ToBase64String($c.RawData)
            [void]$pem.Append("-----BEGIN CERTIFICATE-----`n")
            for ($i = 0; $i -lt $b64.Length; $i += 64) { [void]$pem.Append($b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) + "`n") }
            [void]$pem.Append("-----END CERTIFICATE-----`n")
        }
    }
    $full = $base + $pem.ToString()

    # written only when it changed, through a temporary file, so a game that is starting never reads half a list
    $ascii = New-Object System.Text.ASCIIEncoding
    foreach ($out in $amxx, $engine) {
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $out))) { continue }
        if ((Test-Path -LiteralPath $out) -and [IO.File]::ReadAllText($out) -eq $full) { continue }
        $tmp = "$out.h9new"
        [IO.File]::WriteAllText($tmp, $full, $ascii)
        Move-Item -LiteralPath $tmp -Destination $out -Force
    }
} catch {
    Write-Host "[h9_cacerts] the certificate lists were left as they are: $($_.Exception.Message)"
}
exit 0

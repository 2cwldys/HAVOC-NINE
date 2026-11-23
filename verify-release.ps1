<#
.SYNOPSIS
  After a deploy: checks that the new build is everywhere it has to be, so nobody has to look for each one.

.DESCRIPTION
  .\verify-release.ps1            checks and prints PASS / WARN / FAIL for each place; exit code 1 when anything FAILs
  deploy-vps.ps1 runs it as its last step. Needs the SSH shortcut of packaging.ini ([deploy] host) and curl.

  The build is VERSION in ts_matchmode.sma. The places:
    1  the updater's manifest (https://havoc9.org/files/manifest.json) says the build
    2  the downloads' build file on the host (site\downloads\.build) says the build
    3  the server list bot's About Me names it ("About Me now names H9XASH <build>" in its own log,
       C:\havoc9\data\serverlist\serverlist.log, which follows the build file by itself; given up to 2 minutes).
       The bot writes that line only when the build changes, so on a delivery that keeps the version the
       last line is older than this delivery and still correct.
    4  the versioned downloads exist (H9XASH-<build>.zip, -linux, -linux-server, the updater)
    5  the join gate: h9_release.txt in the package is the build (docs\H9_RELEASE.txt)
    6  the game server folder on the host (C:\havoc9\H9XASH), when there is one: its h9_release.txt is the build (WARN: update-game.ps1 -Apply, server stopped)
    7  the site answers (the servers list)
    8  every file the live manifests name is on the host under its SHA-256, at its size: the updater's files (site\files) and,
       when published, the HD textures (site\files\hd)
#>
[CmdletBinding()]
param([string]$Ini = (Join-Path $PSScriptRoot 'packaging.ini'), [int]$BioSeconds = 120)

$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$fails = 0
$warns = 0
function Result([string]$level, [string]$name, [string]$detail) {
    $col = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red' }[$level]
    Write-Host ("  [{0}] {1}: {2}" -f $level, $name, $detail) -ForegroundColor $col
    if ($level -eq 'FAIL') { $script:fails++ } elseif ($level -eq 'WARN') { $script:warns++ }
}

# the build and the host
$cfg = @{}
$sec = ''
foreach ($raw in [IO.File]::ReadAllLines($Ini)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
    if ($line -match '^\[(.+)\]$') { $sec = $Matches[1].Trim().ToLowerInvariant(); continue }
    if ($line -match '^([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg["$sec.$($Matches[1].ToLowerInvariant())"] = $Matches[2].Trim() }
}
$sshHost = [string]$cfg['deploy.host']
if ($sshHost -notmatch '^[A-Za-z0-9._@-]+$') { Write-Host '[FAIL] [deploy] host in packaging.ini must be an SSH shortcut'; exit 1 }
$sma = @('src\ts_matchmode.sma', 'ts\addons\amxmodx\scripting\ts_matchmode.sma') | ForEach-Object { Join-Path $Here $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$build = ''
if ($sma -and ([IO.File]::ReadAllText($sma) -match '(?m)^#define\s+VERSION\s+"([^"]+)"')) { $build = $Matches[1] }
if (-not $build) { Write-Host '[FAIL] no VERSION in ts_matchmode.sma'; exit 1 }
Write-Host "== verifying build $build on $sshHost"
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')

function OnHost([string]$cmd) { (& ssh @ssh $sshHost $cmd 2>$null) -join "`n" }

# 1. the updater's manifest
$mj = (& curl.exe -s -H 'X-H9-Updater: 1' -A 'H9XASH-Updater/verify' https://havoc9.org/files/manifest.json 2>$null) -join ''
$mb = ''
if ($mj -match '"build"\s*:\s*"([^"]+)"') { $mb = $Matches[1] }
if ($mb -eq $build) { Result PASS 'updater manifest' "build $mb" } else { Result FAIL 'updater manifest' "says '$mb', the build is $build" }

# 2. the build file
$bf = (OnHost 'type C:\havoc9\site\downloads\.build').Trim()
if ($bf -eq $build) { Result PASS 'downloads build file' $bf } else { Result FAIL 'downloads build file' "says '$bf', the build is $build (the bot's About Me and the file index follow it)" }

# 3. the bot's About Me. The bot writes this line only when the build it names CHANGES, so a
# delivery that does not bump the version writes no new line and the last one can be days old.
# Read the bot's own log, which keeps the whole history in one file: the service's out logs under
# C:\havoc9\logs rotate daily, and the bot writes a line every poll, so the last About Me line
# left that window within hours and this check warned on every delivery that kept the version.
$bio = ''
$deadline = (Get-Date).AddSeconds($BioSeconds)
do {
    $log = OnHost 'powershell -NoProfile -Command "$p = ''C:\havoc9\data\serverlist\serverlist.log''; if (Test-Path $p) { (Select-String -Path $p -Pattern ''About Me now names'' | Select-Object -Last 1).Line }"'
    if ($log -match 'About Me now names H9XASH (\S+)') { $bio = $Matches[1] }
    if ($bio -eq $build) { break }
    Start-Sleep -Seconds 10
} while ((Get-Date) -lt $deadline)
if ($bio -eq $build) { Result PASS 'server list bot About Me' "H9XASH $bio" }
elseif ($bio) { Result FAIL 'server list bot About Me' "names H9XASH $bio after $BioSeconds s; the build is $build (is havoc9-serverlist running? start-all.ps1 on the host)" }
else { Result WARN 'server list bot About Me' "no 'About Me now names' line in C:\havoc9\data\serverlist\serverlist.log (is the bot running, and is discord_token in serverlist.cfg?)" }

# 4. the versioned downloads
$files = OnHost 'dir /b C:\havoc9\site\downloads\files'
foreach ($n in @("H9XASH-$build.zip", "H9XASH-linux-$build.zip", "H9XASH-linux-server-$build.zip", "H9XASH-Updater-$build.exe")) {
    if ($files -match [regex]::Escape($n)) { Result PASS 'versioned download' $n } else { Result FAIL 'versioned download' "$n is not in site\downloads\files" }
}

# 4b. the public file index holds no host package (the site's own installer and code: not a download)
if ($files -match 'havoc9-vps-') { Result FAIL 'public file index' 'a havoc9-vps-* host package is listed in site\downloads\files (public at https://havoc9.org/downloads/files/): receive-deploy.ps1 and setup.ps1 -FileIndex take it out' }
else { Result PASS 'public file index' 'no host package in it' }

# 5. the join gate in the package
$rel = ''
foreach ($p in @('xash3d-h9-patches\overlay\ts\h9_release.txt', 'H9XASH\ts\h9_release.txt')) {
    $f = Join-Path $Here $p
    if (Test-Path -LiteralPath $f) {
        $w = ([IO.File]::ReadAllText($f).Trim() -split '\s+')[0]
        if ($w -eq $build) { Result PASS 'join gate (h9_release.txt)' "$p = $w" } else { Result FAIL 'join gate (h9_release.txt)' "$p says '$w', the build is ${build}: node tools\release-prepare.mjs --release" }
    }
}

# 5b. the compiled plugin carries the release, and the manifest serves that very file. The text files can all agree while a bump that stopped before the
# compile left the old release in the binary: an .amxx is 24 bytes of header and a zlib image whose data holds string literals as cells of 4 bytes, and
# the literal after "h9_plugin_release" is what h9_presence registers (tools\amxx-release.mjs does the same read for release-check.mjs)
function Get-AmxxRelease([string]$File) {
    try {
        $bytes = [IO.File]::ReadAllBytes($File)
        $ms = New-Object IO.MemoryStream($bytes, 26, ($bytes.Length - 26))
        $ds = New-Object IO.Compression.DeflateStream($ms, [IO.Compression.CompressionMode]::Decompress)
        $out = New-Object IO.MemoryStream
        $ds.CopyTo($out)
        $img = [Text.Encoding]::GetEncoding(28591).GetString($out.ToArray())
        $name = 'h9_plugin_release'
        $pat = (($name.ToCharArray() | ForEach-Object { [string]$_ + "`0`0`0" }) -join '') + "`0`0`0`0"
        $at = $img.IndexOf($pat, [StringComparison]::Ordinal)
        if ($at -lt 0) { return '' }
        $p = $at + ($name.Length + 1) * 4
        $s = ''
        while ($p + 4 -le $img.Length) {
            $c = [int]$img[$p]
            if ([int]$img[$p + 1] -ne 0 -or [int]$img[$p + 2] -ne 0 -or [int]$img[$p + 3] -ne 0) { return $null }
            if ($c -eq 0) { break }
            if ($c -lt 32 -or $c -gt 126 -or $s.Length -gt 40) { return $null }
            $s += [char]$c
            $p += 4
        }
        return $s
    } catch { return $null }
}
$plugRel = 'ts/addons/amxmodx/plugins/h9_presence.amxx'
$plug = Join-Path $Here ('H9XASH\' + ($plugRel -replace '/', '\'))
if (Test-Path -LiteralPath $plug) {
    $carried = Get-AmxxRelease $plug
    if ($null -eq $carried) { Result WARN 'compiled plugin' 'h9_presence.amxx could not be read for the release it carries' }
    elseif ($carried -eq $build) { Result PASS 'compiled plugin' "h9_presence.amxx carries release $carried" }
    else { Result FAIL 'compiled plugin' "h9_presence.amxx carries release '$carried' and the build is ${build}: a bump stopped before the compile (node tools\release-prepare.mjs --bump)" }
    $served = ''
    try { $served = [string](($mj | ConvertFrom-Json).files | Where-Object { $_.path -eq $plugRel } | Select-Object -First 1 -ExpandProperty sha256) } catch { $served = '' }
    $mine = (Get-FileHash -LiteralPath $plug -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $served) { Result WARN 'served plugin' "the updater's manifest does not list $plugRel" }
    elseif ($served -eq $mine) { Result PASS 'served plugin' "the manifest's h9_presence.amxx is this tree's" }
    else { Result FAIL 'served plugin' "the manifest's h9_presence.amxx is not the one in this tree (SHA-256 $($served.Substring(0, 10)) and $($mine.Substring(0, 10)))" }
}

# 6. the game server folder on the host
$hostRel = (OnHost 'if exist C:\havoc9\H9XASH\ts\h9_release.txt (type C:\havoc9\H9XASH\ts\h9_release.txt) else (echo none)').Trim()
if ($hostRel -eq 'none' -or -not $hostRel) { Result WARN 'game server folder' 'no C:\havoc9\H9XASH on the host' }
else {
    $hw = ($hostRel -split '\s+')[0]
    if ($hw -eq $build) { Result PASS 'game server folder' "h9_release.txt $hw" }
    else { Result WARN 'game server folder' "C:\havoc9\H9XASH is release $hw, the build is ${build}: stop the server, then powershell -File C:\havoc9\update-game.ps1 -Apply (players of build $build are refused by it until then)" }
}

# 7. the site
$api = (& curl.exe -s -o NUL -w '%{http_code}' https://havoc9.org/api/servers 2>$null)
if ($api -eq '200') { Result PASS 'site' '/api/servers answers' } else { Result FAIL 'site' "/api/servers answers HTTP $api" }

# 8. every file the live manifests name is on the host. receive-deploy.ps1 refuses a delivery whose manifest names a file it cannot place, so a gap can
# only come later: a file deleted by hand, or lost on the disk. The updater then stops on the 404 before it changes anything (test_updater.py, web v5),
# so players keep what they have, but nobody who lacks that file can update until it is back. Sizes, not hashes: hashing 12 GB of HD textures is too slow here.
$blobCheck = @'
$ProgressPreference = 'SilentlyContinue'
foreach ($s in @(@('updater files', 'C:\havoc9\site\files'), @('HD textures', 'C:\havoc9\site\files\hd'))) {
    $dir = $s[1]
    $m = Join-Path $dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $m)) { "set|$($s[0])|none"; continue }
    $have = @{}
    foreach ($f in [IO.Directory]::EnumerateFiles($dir)) { $have[[IO.Path]::GetFileName($f)] = (New-Object IO.FileInfo $f).Length }
    $want = @{}
    foreach ($e in (Get-Content -Raw -LiteralPath $m | ConvertFrom-Json).files) { $want[[string]$e.sha256] = [long]$e.size }
    $miss = @(); $bad = @()
    foreach ($k in $want.Keys) { if (-not $have.ContainsKey($k)) { $miss += $k } elseif ($have[$k] -ne $want[$k]) { $bad += $k } }
    "set|$($s[0])|$($want.Count)|$($miss.Count)|$($bad.Count)|$((@($miss + $bad) | Select-Object -First 3) -join ',')"
}
'@
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($blobCheck))
$seen = 0
foreach ($ln in ((OnHost "powershell -NoProfile -NonInteractive -EncodedCommand $enc") -split "`n")) {
    $p = $ln.Trim() -split '\|'
    if ($p.Count -lt 3 -or $p[0] -ne 'set') { continue }
    $seen++
    if ($p[2] -eq 'none') {
        if ($p[1] -eq 'updater files') { Result FAIL 'served files' 'no manifest.json in C:\havoc9\site\files' }
        else { Result PASS 'served files' "$($p[1]): none published" }
        continue
    }
    if ($p.Count -lt 6) { Result WARN 'served files' "$($p[1]): the host's answer could not be read"; continue }
    if ($p[3] -eq '0' -and $p[4] -eq '0') { Result PASS 'served files' "$($p[1]): all $($p[2]) named files are there, at their size" }
    else { Result FAIL 'served files' "$($p[1]): $($p[3]) of $($p[2]) named files are missing and $($p[4]) have the wrong size (first: $($p[5])); run the delivery again, it sends what the host lacks" }
}
if (-not $seen) { Result WARN 'served files' 'the host did not answer the check' }

Write-Host ("== {0} FAIL, {1} WARN" -f $fails, $warns)
if ($fails) { exit 1 }
exit 0

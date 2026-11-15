<#
.SYNOPSIS
  The receiving end of deploy-vps.ps1: takes a delivery of new builds into havoc9.org on this Windows host.

.DESCRIPTION
  It lives at C:\havoc9\receive-deploy.ps1 (setup.ps1 puts it there; only administrators can change it), so nothing in a
  delivery can change how a delivery is checked. A delivery is a folder under C:\setup\incoming that deploy-vps.ps1
  uploaded over SSH (key only), with deploy-manifest.txt in it: one line per file, "<sha256>  <name>", the names of
  the updater's files the site must end up with, and "build <version>": the file index lists the downloads under that
  build's name (H9XASH-1.61.zip; setup.ps1 -FileIndex, through site\downloads\.build).

  Nothing is installed until every check passes:
    * only these names are taken; any other file or folder in the delivery stops it:
        H9XASH.zip, H9XASH-linux.zip, H9XASH-Updater.exe        the DOWNLOADS page's three buttons
        H9XASH-linux-server.zip                                 the native Linux server (file index only)
        havoc9-vps-windows-<build>-<stamp>.zip                  the host package: installed with its setup.ps1
        havoc9-vps-linux-<build>-<stamp>.zip                    the file index only
        havoc9-vps-webclient-<build>-<stamp>.zip                the web client's files
        updater-files.tar                                       H9XASH-Updater's new files, each named by its SHA-256
        deploy-manifest.txt
    * each file's SHA-256 must be the one the manifest gives, and each updater file's SHA-256 must be its name;
    * a ZIP may not hold a path that climbs out of its folder (.. or a drive).
  Then, in this order: the host package (setup.ps1 backs h9web up first and keeps every setting, key and all data),
  the web client, the downloads (each put in place whole, by a rename), the updater's files (manifest.json last), the
  downloads' file index, the fingerprint of all code (code-check.ps1 -Write), and start-all.ps1's checks. The delivery
  folder is deleted when it worked; the log is logs\deploy-<time>.log.

    -Hashes      prints what is here now (the downloads' SHA-256 and the updater files' names), for deploy-vps.ps1 to
                 upload only what changed
    -Incoming <folder under C:\setup\incoming>   takes that delivery
#>
param(
    [string]$Incoming = '',
    [switch]$Hashes,
    [string]$Root = 'C:\havoc9'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Site = Join-Path $Root 'site'
$Dl = Join-Path $Site 'downloads'
$Idx = Join-Path $Dl 'files'
$Files = Join-Path $Site 'files'
$Inbox = 'C:\setup\incoming'
$Buttons = @('H9XASH.zip', 'H9XASH-linux.zip', 'H9XASH-Updater.exe')
$Rules = @(
    @{ Re = '^H9XASH(-linux)?\.zip$'; Kind = 'button' },
    @{ Re = '^H9XASH-Updater\.exe$'; Kind = 'button' },
    @{ Re = '^H9XASH-linux-server\.zip$'; Kind = 'button' },
    @{ Re = '^havoc9-vps-windows-[A-Za-z0-9._-]+\.zip$'; Kind = 'host' },
    @{ Re = '^havoc9-vps-linux-[A-Za-z0-9._-]+\.zip$'; Kind = 'index' },
    @{ Re = '^havoc9-vps-webclient-[A-Za-z0-9._-]+\.zip$'; Kind = 'webclient' },
    @{ Re = '^updater-files\.tar$'; Kind = 'updater' }
)

function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

if ($Hashes) {
    foreach ($n in $Buttons + @('H9XASH-linux-server.zip')) {
        $p = Join-Path $Dl $n
        if (Test-Path -LiteralPath $p -PathType Leaf) { "file $(Sha $p) $n" }
    }
    if (Test-Path -LiteralPath $Files) {
        Get-ChildItem -LiteralPath $Files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { "blob $($_.Name)" }
        $m = Join-Path $Files 'manifest.json'
        if (Test-Path -LiteralPath $m) { "file $(Sha $m) manifest.json" }
    }
    $w = Join-Path $Site 'webclient\manifest.json'
    if (Test-Path -LiteralPath $w) { "file $(Sha $w) webclient-manifest.json" }
    exit 0
}

$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host '[FAIL] run it as administrator'; exit 1 }
$in = [IO.Path]::GetFullPath($Incoming)
if (-not $Incoming -or -not $in.StartsWith($Inbox + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $in -PathType Container)) {
    Write-Host "[FAIL] -Incoming must be a folder under $Inbox"; exit 1
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $Root "logs\deploy-$stamp.log"
Start-Transcript -LiteralPath $log -Append | Out-Null
function Fail([string]$Text) { Write-Host "[FAIL] $Text" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }
function Say([string]$Text) { Write-Host "== $Text" }

# 1. the manifest, and nothing in the delivery but what it names
$manifest = Join-Path $in 'deploy-manifest.txt'
if (-not (Test-Path -LiteralPath $manifest)) { Fail 'no deploy-manifest.txt in the delivery' }
$want = @{}
$blobsWanted = New-Object System.Collections.Generic.HashSet[string]
$manifestJsonSha = ''
$build = ''
foreach ($line in [IO.File]::ReadAllLines($manifest)) {
    if ($line -match '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$') { $want[$Matches[2]] = $Matches[1]; continue }
    if ($line -match '^blob ([0-9a-f]{64})$') { [void]$blobsWanted.Add($Matches[1]); continue }
    if ($line -match '^updater-manifest ([0-9a-f]{64})$') { $manifestJsonSha = $Matches[1]; continue }
    if ($line -match '^build ([0-9][A-Za-z0-9._-]{0,31})$') { $build = $Matches[1]; continue }
    if ($line.Trim() -eq '' -or $line.StartsWith('#')) { continue }
    Fail "a line deploy-manifest.txt may not have: $line"
}
$kinds = @{}
foreach ($n in $want.Keys) {
    $rule = $Rules | Where-Object { $n -match $_.Re } | Select-Object -First 1
    if (-not $rule) { Fail "a file this host does not take: $n" }
    $kinds[$n] = $rule.Kind
}
foreach ($item in Get-ChildItem -LiteralPath $in -Force) {
    if ($item.Name -eq 'deploy-manifest.txt') { continue }
    if ($item.PSIsContainer -or -not $want.ContainsKey($item.Name)) { Fail "the delivery holds something the manifest does not name: $($item.Name)" }
}

# 2. every file's SHA-256
Say 'checking the delivery'
foreach ($n in $want.Keys) {
    $p = Join-Path $in $n
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail "missing: $n" }
    $h = Sha $p
    if ($h -ne $want[$n]) { Fail "$n is not the file that was sent (SHA-256 $h, not $($want[$n]))" }
    Write-Host "  $n  ok"
}
function Test-ZipPaths([string]$Zip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($e in $z.Entries) {
            $name = $e.FullName -replace '\\', '/'
            if ($name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:') { Fail "$([IO.Path]::GetFileName($Zip)) holds a path outside its folder: $($e.FullName)" }
        }
    } finally { $z.Dispose() }
}
foreach ($n in $want.Keys) { if ($kinds[$n] -in @('host', 'webclient')) { Test-ZipPaths (Join-Path $in $n) } }

# the updater's files: unpacked into the delivery, each one's SHA-256 its name, nothing else in the archive
$blobDir = Join-Path $in 'updater-files'
if ($want.ContainsKey('updater-files.tar')) {
    New-Item -ItemType Directory -Force -Path $blobDir | Out-Null
    $list = & tar.exe -tf (Join-Path $in 'updater-files.tar')
    if ($LASTEXITCODE -ne 0) { Fail 'updater-files.tar cannot be read' }
    foreach ($e in $list) { if ($e -notmatch '^([0-9a-f]{64}|manifest\.json)$') { Fail "updater-files.tar holds a name the updater's files never have: $e" } }
    & tar.exe -xf (Join-Path $in 'updater-files.tar') -C $blobDir
    if ($LASTEXITCODE -ne 0) { Fail 'updater-files.tar could not be unpacked' }
    foreach ($f in Get-ChildItem -LiteralPath $blobDir -File) {
        if ($f.Name -eq 'manifest.json') {
            if ((Sha $f.FullName) -ne $manifestJsonSha) { Fail 'the updater manifest.json is not the one that was sent' }
            continue
        }
        if ((Sha $f.FullName) -ne $f.Name) { Fail "updater file $($f.Name) is not what its name says" }
    }
    Write-Host "  updater-files.tar  ok ($(@(Get-ChildItem -LiteralPath $blobDir -File).Count) files)"
}

# 3. the host package: its own setup.ps1 (a backup first, every setting and key kept)
$hostZip = $want.Keys | Where-Object { $kinds[$_] -eq 'host' } | Select-Object -First 1
$pkgDir = ''
if ($hostZip) {
    Say "installing $hostZip"
    $pkgDir = Join-Path 'C:\setup' ([IO.Path]::GetFileNameWithoutExtension($hostZip))
    if (Test-Path -LiteralPath $pkgDir) { Remove-Item -LiteralPath $pkgDir -Recurse -Force }
    Expand-Archive -LiteralPath (Join-Path $in $hostZip) -DestinationPath 'C:\setup'
    if (-not (Test-Path -LiteralPath (Join-Path $pkgDir 'setup.ps1'))) { Fail "$hostZip has no setup.ps1 in $pkgDir" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkgDir 'setup.ps1') -Root $Root 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "setup.ps1 of $hostZip failed (above)" }
}
if (-not $pkgDir) {
    $pkgDir = Get-ChildItem -LiteralPath 'C:\setup' -Directory -Filter 'havoc9-vps-windows-*' | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
}

# 4. the web client
$wcZip = $want.Keys | Where-Object { $kinds[$_] -eq 'webclient' } | Select-Object -First 1
if ($wcZip) {
    Say "the web client from $wcZip"
    $wcDir = Join-Path $in 'webclient'
    Expand-Archive -LiteralPath (Join-Path $in $wcZip) -DestinationPath $wcDir
    $stage = Get-ChildItem -LiteralPath $wcDir -Recurse -Directory -Filter 'stage' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
    if (-not $stage) { Fail "$wcZip has no stage folder with a manifest.json" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkgDir 'setup.ps1') -Root $Root -WebClientStage $stage.FullName 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail 'setup.ps1 -WebClientStage failed (above)' }
}

# 5. the downloads: each one put in place whole, by a rename in the same folder
Say 'the downloads'
foreach ($n in $want.Keys) {
    $k = $kinds[$n]
    if ($k -ne 'button' -and $k -ne 'index' -and $k -ne 'host') { continue }
    $dest = if ($k -eq 'button') { Join-Path $Dl $n } else { Join-Path $Idx $n }
    $tmp = Join-Path (Split-Path -Parent $dest) ".$n.new"
    Copy-Item -LiteralPath (Join-Path $in $n) -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    Write-Host "  $n -> $dest"
    # a newer host package of a kind replaces the older ones in the index
    if ($n -match '^(havoc9-vps-(windows|linux))-') {
        Get-ChildItem -LiteralPath $Idx -File -Filter "$($Matches[1])-*.zip" | Where-Object { $_.Name -ne $n } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force; Write-Host "  removed the older $($_.Name)" }
    }
}

# 6. the updater's files: the new ones first, manifest.json last, then the ones no release names any more
if ($want.ContainsKey('updater-files.tar')) {
    Say "H9XASH-Updater's files"
    New-Item -ItemType Directory -Force -Path $Files | Out-Null
    $added = 0
    foreach ($f in Get-ChildItem -LiteralPath $blobDir -File | Where-Object { $_.Name -ne 'manifest.json' }) {
        $dest = Join-Path $Files $f.Name
        if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $f.FullName -Destination $dest; $added++ }
    }
    foreach ($b in $blobsWanted) { if (-not (Test-Path -LiteralPath (Join-Path $Files $b))) { Fail "updater file $b is named by the new release but is neither here nor in the delivery" } }
    $mj = Join-Path $blobDir 'manifest.json'
    if (Test-Path -LiteralPath $mj) {
        Copy-Item -LiteralPath $mj -Destination (Join-Path $Files '.manifest.json.new') -Force
        Move-Item -LiteralPath (Join-Path $Files '.manifest.json.new') -Destination (Join-Path $Files 'manifest.json') -Force
    }
    $gone = 0
    if ($blobsWanted.Count) {
        foreach ($f in Get-ChildItem -LiteralPath $Files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' -and -not $blobsWanted.Contains($_.Name) }) { Remove-Item -LiteralPath $f.FullName -Force; $gone++ }
    }
    Write-Host "  $added new, $gone no longer named"
}

# 7. the file index (under this build's names), the code's fingerprint, and the checks
if ($build) { [IO.File]::WriteAllText((Join-Path $Dl '.build'), "$build`n") }
if ($pkgDir) {
    Say "the downloads' file index"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkgDir 'setup.ps1') -Root $Root -FileIndex 2>&1 | ForEach-Object { Write-Host "  $_" }
}
$cc = Join-Path $Root 'code-check.ps1'
if (Test-Path -LiteralPath $cc) {
    Say 'the fingerprint of all code'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cc -Root $Root -Write 2>&1 | ForEach-Object { Write-Host "  $_" }
}
Say 'checks'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'start-all.ps1') -Root $Root 2>&1 | ForEach-Object { Write-Host "  $_" }
$ok = ($LASTEXITCODE -eq 0)
Stop-Transcript | Out-Null
if ($ok) { Remove-Item -LiteralPath $in -Recurse -Force; Write-Host '== delivered'; exit 0 }
Write-Host "== delivered, but a check is not OK (above); the delivery is kept in $in" -ForegroundColor Yellow
exit 2

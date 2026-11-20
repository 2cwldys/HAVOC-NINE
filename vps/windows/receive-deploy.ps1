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
        havoc9-vps-windows-<build>-<stamp>.zip                  the host package: installed with its setup.ps1, never published
        havoc9-vps-webclient-<build>-<stamp>.zip                the web client's files
        H9XASH.zip.recipe.json, H9XASH-linux.zip.recipe.json, H9XASH-linux-server.zip.recipe.json, webclient.zip.recipe.json,
        blobs-<n>.tar                                           a delta (delta.py): the list of a client ZIP or of the web client
                                                                and only the files this host has not seen; the host builds the ZIP
        preset-bundle.json                                      the build's official plugin list, imported into the site (h9web's preset-seed.js)
        updater-files.tar, updater-files-<n>.tar                H9XASH-Updater's new files, each named by its SHA-256 (in
                                                                pieces, so the delivery can go over several streams)
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
# the optional HD textures: their own store inside the updater's, with their own manifest.json.
# The prune in step 6 lists $Files without -Recurse, so nothing there ever reaches into this.
$FilesHd = Join-Path $Files 'hd'
$Inbox = 'C:\setup\incoming'
# Remembered SHA-256s for -Hashes (see ShaCached). Deliberately NOT under $Dl: that folder is
# served to the public and listed on the downloads page, and cache files have no business there.
# Losing this folder costs one slow deploy and nothing else.
$HashCache = Join-Path $Root 'data\hashcache'
$Buttons = @('H9XASH.zip', 'H9XASH-linux.zip', 'H9XASH-Updater.exe')
$Rules = @(
    @{ Re = '^H9XASH(-linux)?\.zip$'; Kind = 'button' },
    @{ Re = '^H9XASH-Updater\.exe$'; Kind = 'button' },
    @{ Re = '^H9XASH-linux-server\.zip$'; Kind = 'button' },
    @{ Re = '^havoc9-vps-windows-[A-Za-z0-9._-]+\.zip$'; Kind = 'host' },
    @{ Re = '^havoc9-vps-webclient-[A-Za-z0-9._-]+\.zip$'; Kind = 'webclient' },
    @{ Re = '^updater-files(-[0-9]{1,3})?\.tar$'; Kind = 'updater' },
    @{ Re = '^(H9XASH|H9XASH-linux|H9XASH-linux-server)\.zip\.recipe\.json$'; Kind = 'recipe' },
    @{ Re = '^webclient\.zip\.recipe\.json$'; Kind = 'wcrecipe' },
    @{ Re = '^blobs-[0-9]{1,3}\.tar$'; Kind = 'blobs' },
    @{ Re = '^hd-files-[0-9]{1,3}\.tar$'; Kind = 'hd' },
    @{ Re = '^preset-bundle\.json$'; Kind = 'preset' }
)
$Config = Join-Path $Root 'etc\config.json'
$Node = Join-Path $Root 'tools\node\node.exe'
$Py = Join-Path $Root 'tools\python\python.exe'
$Delta = Join-Path $Root 'delta.py'
$Store = Join-Path $Root 'store'
$TreeFile = Join-Path $Dl '.trees.json'

# A file that has just arrived over SFTP can still be held by the session that wrote it, and the read
# then fails with "The process cannot access the file because it is being used by another process".
# That is not a bad file and not a bad delivery: it is a handle that has not closed yet. Two deliveries
# of build 1.67 died here on 2026-11-19, both on blobs-6.tar, after all 10.9 GB had already arrived, and
# the file hashed perfectly as soon as the handle went. A just-written file being briefly locked is
# ordinary on Windows, so this waits for it instead of giving up on the first attempt: seven retries
# over about 36 s, which costs nothing at all when the handle is already free.
#
# The hash is computed from a stream opened here, so the open that is retried is the same open that has
# to succeed. Testing readability separately and then calling Get-FileHash would leave the identical
# race in the gap between the two. A handle still held after all the retries is stuck rather than
# closing: lockwatch.cmd releases a stale sftp-server, and h9_find_lock.ps1 names the holder when it is
# an orphaned sshd session instead.
function Sha([string]$Path) {
    $delays = @(1, 2, 3, 5, 5, 8, 12)
    for ($try = 0; ; $try++) {
        try {
            $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $sha = [Security.Cryptography.SHA256]::Create()
                try { return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '').ToLowerInvariant() }
                finally { $sha.Dispose() }
            }
            finally { $fs.Dispose() }
        }
        catch [IO.IOException] {
            if ($try -ge $delays.Count) {
                throw "cannot read $Path after $try tries over $(($delays | Measure-Object -Sum).Sum) s: something is holding it open. h9_find_lock.ps1 names what, and lockwatch.cmd once releases a stale sftp-server."
            }
            Write-Host ("  {0}: still held by the session that wrote it, waiting {1} s" -f (Split-Path -Leaf $Path), $delays[$try])
            Start-Sleep -Seconds $delays[$try]
        }
    }
}

# -Hashes tells the sender what this host already has, which includes the SHA-256 of every
# download the site serves -- several GB of ZIPs. Those change only when a delivery replaces
# them, so each hash is remembered with the length and UTC write time it was computed from, and
# recomputed only when either has moved. A replaced file re-hashes by itself, and a missing or
# corrupt entry costs one slow read.
#
# Deliberately NOT used when a delivery is checked further down: there the point is to verify
# bytes that have just arrived over the network, and a remembered answer defeats it.
function ShaCached([string]$Path) {
    $fi = Get-Item -LiteralPath $Path
    $stamp = '{0}:{1}' -f $fi.Length, $fi.LastWriteTimeUtc.ToString('o')
    $side = Join-Path $HashCache ((Split-Path -Leaf $Path) + '.sha256')

    try {
        if (Test-Path -LiteralPath $side -PathType Leaf) {
            $lines = @(Get-Content -LiteralPath $side -TotalCount 2)
            if ($lines.Count -ge 2 -and $lines[1] -eq $stamp -and $lines[0] -match '^[0-9a-f]{64}$') {
                return $lines[0]
            }
        }
    }
    catch { }           # an unreadable or malformed entry just means hashing it again

    $hash = Sha $Path

    try {
        if (-not (Test-Path -LiteralPath $HashCache)) {
            New-Item -ItemType Directory -Force -Path $HashCache | Out-Null
        }
        Set-Content -LiteralPath $side -Value @($hash, $stamp) -Encoding ascii
    }
    catch { }           # the cache is an optimisation: failing to write it must never fail a deploy

    return $hash
}

# A child PowerShell script (setup.ps1, start-all.ps1 ...): its output shown, its exit code in $script:childExit. Under
# $ErrorActionPreference 'Stop' a line a program writes to its error stream (Caddy logs its ordinary lines there) would stop
# this script, so the preference is 'Continue' for the call: only the child's exit code says whether it worked.
$script:childExit = 0
function Invoke-Child([string[]]$ChildArgs) {
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # the child's own headings ("== 3. h9web") get the time since this delivery began, so a slow step shows
        & powershell.exe -NoProfile -ExecutionPolicy Bypass @ChildArgs 2>&1 | ForEach-Object {
            if ("$_" -match '^\s*== ') { Write-Host ("  {0}   [{1:N0} s]" -f $_, ((Get-Date) - $script:t0).TotalSeconds) } else { Write-Host "  $_" }
        }
        $script:childExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $was }
}

# Whether the script at $Path declares the parameter $Name, so a switch that only newer copies of setup.ps1 and
# start-all.ps1 have is passed only to a copy that has it: powershell.exe -File refuses a parameter the script does not
# declare and runs none of it. The copy that runs can be older than this script: setup.ps1 runs from $pkgDir, which is
# the newest package folder under C:\setup when the delivery brings no host package, and every full setup.ps1 run puts
# its own package's start-all.ps1 into $Root. Get-Command reads the parameter block without running the script; one
# that is missing or cannot be read answers $false, and the switch is left out.
function Test-ScriptParam([string]$Path, [string]$Name) {
    try { return (Get-Command -Name $Path -CommandType ExternalScript -ErrorAction Stop).Parameters.ContainsKey($Name) }
    catch { return $false }
}

# delta.py (the host's Python): its output shown, its exit code in $script:deltaExit; see Invoke-Child for the preference
$script:deltaExit = 0
function Invoke-Delta([string[]]$DeltaArgs) {
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Py -I $Delta @DeltaArgs 2>&1 | ForEach-Object { Write-Host "  $_" }; $script:deltaExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $was }
}

if ($Hashes) {
    # The four downloads, several GB between them. ShaCached re-reads one only when its length
    # or write time has moved. The manifests below stay on Sha: they are small JSON.
    foreach ($n in $Buttons + @('H9XASH-linux-server.zip')) {
        $p = Join-Path $Dl $n
        if (Test-Path -LiteralPath $p -PathType Leaf) { "file $(ShaCached $p) $n" }
    }
    if (Test-Path -LiteralPath $Files) {
        Get-ChildItem -LiteralPath $Files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { "blob $($_.Name)" }
        $m = Join-Path $Files 'manifest.json'
        if (Test-Path -LiteralPath $m) { "file $(Sha $m) manifest.json" }
    }
    if (Test-Path -LiteralPath $FilesHd) {
        Get-ChildItem -LiteralPath $FilesHd -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { "hd $($_.Name)" }
        $hm = Join-Path $FilesHd 'manifest.json'
        if (Test-Path -LiteralPath $hm) { "file $(Sha $hm) hd-manifest.json" }
    }
    $w = Join-Path $Site 'webclient\manifest.json'
    if (Test-Path -LiteralPath $w) { "file $(Sha $w) webclient-manifest.json" }
    if (Test-Path -LiteralPath $TreeFile) {
        $tr = Get-Content -Raw -LiteralPath $TreeFile | ConvertFrom-Json
        foreach ($pn in $tr.PSObject.Properties.Name) { "tree $pn $($tr.$pn)" }
    }
    if ((Test-Path -LiteralPath $Py) -and (Test-Path -LiteralPath $Delta)) { & $Py -I $Delta have --store $Store --files $Files }
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

# Which services are up before anything is touched, so a failure can put back exactly what it
# found. setup.ps1 stops them to replace their binaries (its "stop the services for the update"
# step) and starts them again only at its very end, so anything that fails in between would
# otherwise leave havoc9.org, the server list and the Discord bot down until someone noticed.
#
# Only services that were running are restarted. havoc9-p2p in particular can be installed and
# deliberately not started while its relay settings are unfinished, and starting it here would
# override that decision.
$script:servicesWereUp = @(
    Get-Service -Name 'havoc9-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Running' } |
        ForEach-Object { $_.Name }
)
if ($script:servicesWereUp.Count) {
    Write-Host ("services running before this delivery: " + ($script:servicesWereUp -join ', '))
}

function Restore-Services {
    if (-not $script:servicesWereUp -or -not $script:servicesWereUp.Count) { return }
    $back = @()
    $stuck = @()
    foreach ($n in $script:servicesWereUp) {
        $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Running') { continue }
        try { Start-Service -Name $n -ErrorAction Stop; $back += $n }
        catch { $stuck += ("{0} ({1})" -f $n, $_.Exception.Message) }
    }
    if ($back.Count) { Write-Host ("  the site is back up: " + ($back -join ', ')) -ForegroundColor Green }
    if ($stuck.Count) {
        Write-Host "  COULD NOT START, the site is still down: " -ForegroundColor Red -NoNewline
        Write-Host ($stuck -join '; ') -ForegroundColor Red
        Write-Host "  start them by hand:  Start-Service havoc9-caddy, havoc9-h9web, havoc9-serverlist"
    }
}

function Fail([string]$Text) {
    Write-Host "[FAIL] $Text" -ForegroundColor Red
    Restore-Services
    Stop-Transcript | Out-Null
    exit 1
}

# Not every way this script can stop goes through Fail(). $ErrorActionPreference is 'Stop', so an
# unforeseen error anywhere terminates the script where it stands, and before this trap existed
# that left the services down just as surely as a handled failure did.
trap {
    Write-Host "[FAIL] unexpected: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ("  at {0}:{1}" -f $_.InvocationInfo.ScriptName, $_.InvocationInfo.ScriptLineNumber)
    Restore-Services
    Stop-Transcript | Out-Null
    exit 1
}

$script:t0 = Get-Date
function Say([string]$Text) { Write-Host ("== {0}   [{1:N0} s]" -f $Text, ((Get-Date) - $script:t0).TotalSeconds) }

# 0. room to work. A delivery is kept at the end of this script only when it FAILED (the last line
# removes it on success), which is right for looking at afterwards and wrong for ever: each one is
# about 10 GB. On 2026-11-19 three failed deliveries of the same build left 25 GB in C:\setup\incoming,
# filled a 100 GB disk, and delta.py then died mid-write with "OSError: [Errno 28] No space left on
# device". Worse, with the disk at zero, sshd could no longer complete a login -- so the one way in to
# clear it was gone, and the host had to be reached through the provider's console.
#
# So: a delivery older than $KeepDays is swept before this one starts, and the free space is checked
# BEFORE anything is written rather than discovered partway through a 10 GB ingest. The current
# delivery and the self folder are never touched, and neither is a recent failure -- there is still a
# day to look at one.
$KeepDays = 2

# How much room THIS delivery wants, measured rather than assumed.
$deliveryFiles = @(Get-ChildItem -LiteralPath $in -Recurse -File -Force -ErrorAction SilentlyContinue)
$deliveryBytes = ($deliveryFiles | Measure-Object -Property Length -Sum).Sum
$largestBytes = ($deliveryFiles | Measure-Object -Property Length -Maximum).Maximum
$deliveryGB = [math]::Round(([double]$deliveryBytes) / 1GB, 2)
$largestGB = [math]::Round(([double]$largestBytes) / 1GB, 2)

# The requirement is the LARGEST SINGLE FILE plus working room, not the delivery's total and
# not a multiple of it. The ingest puts files in one at a time and almost every one replaces
# something of its own size in site\downloads, so the peak extra space is one file existing
# twice while it is copied over its predecessor. A flat figure, or a multiple of the whole
# delivery, refuses work this host can do: a failed run leaves its assembled ZIPs inside the
# delivery folder, which makes the total a poor proxy for what the ingest needs.
$NeedGB = [math]::Max(2.0, [math]::Round($largestGB + 2, 1))
$swept = 0
$freed = 0L
foreach ($d in Get-ChildItem -LiteralPath $Inbox -Directory -ErrorAction SilentlyContinue) {
    if ($d.FullName -eq $in) { continue }
    if ($d.Name -eq 'self') { continue }
    if ($d.LastWriteTime -gt (Get-Date).AddDays(-$KeepDays)) { continue }
    $size = (Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    try {
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
        $swept++; $freed += [long]$size
        Write-Host ("  swept {0} ({1:N1} GB), last written {2:yyyy-MM-dd}" -f $d.Name, ($size / 1GB), $d.LastWriteTime)
    }
    catch { Write-Host "  could not sweep $($d.Name): $($_.Exception.Message)" }
}
if ($swept) { Say ("swept {0} delivery(ies) older than {1} day(s), {2:N1} GB" -f $swept, $KeepDays, ($freed / 1GB)) }

$freeGB = [math]::Round((Get-PSDrive ($in.Substring(0, 1))).Free / 1GB, 1)
if ($freeGB -lt $NeedGB) {
    $keep = Get-ChildItem -LiteralPath $Inbox -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ne $in -and $_.Name -ne 'self' } |
            ForEach-Object { "    $($_.Name)  (last written $($_.LastWriteTime.ToString('yyyy-MM-dd')))" }
    Write-Host "[FAIL] $freeGB GB free; this delivery is $deliveryGB GB, its largest file $largestGB GB, so it wants about $NeedGB GB." -ForegroundColor Red
    Write-Host "  Nothing has been written, so the delivery is intact and can simply be run again."
    if ($keep) {
        Write-Host "  These deliveries are still here and are the usual thing to remove:"
        $keep | ForEach-Object { Write-Host $_ }
        Write-Host "  rmdir /s /q $Inbox\<name>"
    }
    Write-Host "  C:\havoc9\store is the compressed copy of everything ever delivered; it is NOT scratch."
    Restore-Services
    Stop-Transcript | Out-Null
    exit 1
}

# 1. the manifest, and nothing in the delivery but what it names
$manifest = Join-Path $in 'deploy-manifest.txt'
if (-not (Test-Path -LiteralPath $manifest)) { Fail 'no deploy-manifest.txt in the delivery' }
$want = @{}
$blobsWanted = New-Object System.Collections.Generic.HashSet[string]
$hdWanted = New-Object System.Collections.Generic.HashSet[string]
$manifestJsonSha = ''
$hdManifestSha = ''
$build = ''
foreach ($line in [IO.File]::ReadAllLines($manifest)) {
    if ($line -match '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$') { $want[$Matches[2]] = $Matches[1]; continue }
    if ($line -match '^blob ([0-9a-f]{64})$') { [void]$blobsWanted.Add($Matches[1]); continue }
    if ($line -match '^updater-manifest ([0-9a-f]{64})$') { $manifestJsonSha = $Matches[1]; continue }
    if ($line -match '^hd ([0-9a-f]{64})$') { [void]$hdWanted.Add($Matches[1]); continue }
    if ($line -match '^hd-manifest ([0-9a-f]{64})$') { $hdManifestSha = $Matches[1]; continue }
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

# the updater's files: unpacked into the delivery, each one's SHA-256 its name, nothing else in the archives
$blobDir = Join-Path $in 'updater-files'
$tars = @($want.Keys | Where-Object { $kinds[$_] -eq 'updater' } | Sort-Object)
if ($tars.Count) {
    New-Item -ItemType Directory -Force -Path $blobDir | Out-Null
    foreach ($tarName in $tars) {
        $list = & tar.exe -tf (Join-Path $in $tarName)
        if ($LASTEXITCODE -ne 0) { Fail "$tarName cannot be read" }
        foreach ($e in $list) { if ($e -notmatch '^([0-9a-f]{64}|manifest\.json)$') { Fail "$tarName holds a name the updater's files never have: $e" } }
        & tar.exe -xf (Join-Path $in $tarName) -C $blobDir
        if ($LASTEXITCODE -ne 0) { Fail "$tarName could not be unpacked" }
    }
    foreach ($f in Get-ChildItem -LiteralPath $blobDir -File) {
        if ($f.Name -eq 'manifest.json') {
            if ((Sha $f.FullName) -ne $manifestJsonSha) { Fail 'the updater manifest.json is not the one that was sent' }
            continue
        }
        if ((Sha $f.FullName) -ne $f.Name) { Fail "updater file $($f.Name) is not what its name says" }
    }
    Write-Host "  $($tars.Count) updater archive(s)  ok ($(@(Get-ChildItem -LiteralPath $blobDir -File).Count) files)"
}

# the HD textures, checked the same way and kept apart from the client's files until step 6b
$hdDir = Join-Path $in 'hd-files'
$hdTars = @($want.Keys | Where-Object { $kinds[$_] -eq 'hd' } | Sort-Object)
if ($hdTars.Count) {
    New-Item -ItemType Directory -Force -Path $hdDir | Out-Null
    foreach ($tarName in $hdTars) {
        $list = & tar.exe -tf (Join-Path $in $tarName)
        if ($LASTEXITCODE -ne 0) { Fail "$tarName cannot be read" }
        foreach ($e in $list) { if ($e -notmatch '^([0-9a-f]{64}|manifest\.json)$') { Fail "$tarName holds a name the HD textures never have: $e" } }
        & tar.exe -xf (Join-Path $in $tarName) -C $hdDir
        if ($LASTEXITCODE -ne 0) { Fail "$tarName could not be unpacked" }
    }
    foreach ($f in Get-ChildItem -LiteralPath $hdDir -File) {
        if ($f.Name -eq 'manifest.json') {
            if ((Sha $f.FullName) -ne $hdManifestSha) { Fail 'the HD manifest.json is not the one that was sent' }
            continue
        }
        if ((Sha $f.FullName) -ne $f.Name) { Fail "HD texture $($f.Name) is not what its name says" }
    }
    Write-Host "  $($hdTars.Count) HD archive(s)  ok ($(@(Get-ChildItem -LiteralPath $hdDir -File).Count) files)"
}

# 2b. the delta, before anything stops: the updater's new files and the delta's new files go in, and the client ZIPs and the web client
# are built from their recipes (delta.py checks every file's SHA-256 as it goes in and again as it is used)
$recipes = @($want.Keys | Where-Object { $kinds[$_] -eq 'recipe' } | Sort-Object)
$wcRecipe = $want.Keys | Where-Object { $kinds[$_] -eq 'wcrecipe' } | Select-Object -First 1
$blobTars = @($want.Keys | Where-Object { $kinds[$_] -eq 'blobs' } | Sort-Object)
$newTrees = @{}
# the host package (step 3 installs it): setup.ps1 backs h9web up first and keeps every setting, key and all data. It also brings what the delta
# needs (the pinned Python, delta.py), so a host that lacks those has the package go in before the delta; any other host takes it at step 3.
$hostZip = $want.Keys | Where-Object { $kinds[$_] -eq 'host' } | Select-Object -First 1
$pkgDir = ''
$hostDone = $false
function Install-HostPackage {
    Say "installing $hostZip"
    $script:pkgDir = Join-Path 'C:\setup' ([IO.Path]::GetFileNameWithoutExtension($hostZip))
    if (Test-Path -LiteralPath $script:pkgDir) { Remove-Item -LiteralPath $script:pkgDir -Recurse -Force }
    Expand-Archive -LiteralPath (Join-Path $in $hostZip) -DestinationPath 'C:\setup'
    if (-not (Test-Path -LiteralPath (Join-Path $script:pkgDir 'setup.ps1'))) { Fail "$hostZip has no setup.ps1 in $script:pkgDir" }
    # -NoFileIndex leaves the downloads' file index to step 7 (setup.ps1 -FileIndex), which makes it once the downloads
    # are in place: made in this run as well, it would hash every download a second time for an index step 7 replaces
    $setup = Join-Path $script:pkgDir 'setup.ps1'
    $setupArgs = @('-File', $setup, '-Root', $Root, '-NoFingerprint')
    if (Test-ScriptParam $setup 'NoFileIndex') { $setupArgs += '-NoFileIndex' }
    Invoke-Child $setupArgs
    if ($script:childExit -ne 0) { Fail "setup.ps1 of $hostZip failed (above)" }
}
# the standard-library parts of Python that a delta uses; a Python without one of them cannot take a delta
function Test-PythonTools {
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # no double quote inside the -c text: Windows PowerShell 5.1 (the host's) hands a native program its arguments without escaping them
    try { $o = & $Py -I -c 'import zlib, zipfile, struct, hashlib, tarfile, json; print(12345)' 2>&1; $ok = ($LASTEXITCODE -eq 0) -and (("$o") -match '12345') }
    finally { $ErrorActionPreference = $was }
    return @{ Ok = $ok; Text = (($o | ForEach-Object { "$_" }) -join ' ') }
}
if ($recipes.Count -or $wcRecipe -or $blobTars.Count) {
    Say 'the delta: new files in, ZIPs built from recipes'
    if (-not ((Test-Path -LiteralPath $Py) -and (Test-Path -LiteralPath $Delta))) {
        if (-not $hostZip) { Fail "no $Py or ${Delta}, and this delivery has no host package to bring them: install the host package first" }
        Write-Host "  this host has no $Py or ${Delta} yet: the host package goes in first (its setup.ps1 installs the pinned Python and puts delta.py in place)"
        Install-HostPackage
        $hostDone = $true
        if (-not ((Test-Path -LiteralPath $Py) -and (Test-Path -LiteralPath $Delta))) { Fail "the host package is in, but there is still no $Py or $Delta" }
    }
    $tools = Test-PythonTools
    if (-not $tools.Ok) { Fail "the host's Python ($Py) cannot take a delta: $($tools.Text)" }
    # the deflate streams the host keeps of the files it has zipped (store\z): a host that has none yet takes them from the ZIPs it serves now, so a first
    # delta compresses nothing it has compressed before; after that every ZIP built keeps the streams of its new files
    if ($recipes.Count -and -not (Test-Path -LiteralPath (Join-Path $Store 'z'))) {
        $serving = @('H9XASH.zip', 'H9XASH-linux.zip', 'H9XASH-linux-server.zip') | ForEach-Object { Join-Path $Dl $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
        if ($serving) {
            Write-Host '  keeping the deflate streams of the ZIPs the site serves now (a first run)'
            Invoke-Delta (@('seed-zcache') + @($serving) + @('--store', $Store))
            if ($script:deltaExit -ne 0) { Write-Host '  (not kept: the ZIPs are compressed in full this once)' }
        }
    }
    if ($tars.Count) {
        New-Item -ItemType Directory -Force -Path $Files | Out-Null
        foreach ($f in Get-ChildItem -LiteralPath $blobDir -File | Where-Object { $_.Name -ne 'manifest.json' }) {
            $dest = Join-Path $Files $f.Name
            if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $f.FullName -Destination $dest }
        }
    }
    if ($blobTars.Count) {
        Invoke-Delta (@('ingest') + @($blobTars | ForEach-Object { Join-Path $in $_ }) + @('--store', $Store))
        if ($script:deltaExit -ne 0) { Fail 'delta.py could not take the new files in (above)' }
    }
    foreach ($r in $recipes) {
        $zipName = $r -replace '\.recipe\.json$', ''
        $out = Join-Path $in $zipName
        Invoke-Delta @('assemble-zip', (Join-Path $in $r), $out, '--store', $Store, '--files', $Files)
        if ($script:deltaExit -ne 0) { Fail "delta.py could not build $zipName (above)" }
        $want[$zipName] = Sha $out
        $kinds[$zipName] = 'button'
        $newTrees[$zipName] = (Get-Content -Raw -LiteralPath (Join-Path $in $r) | ConvertFrom-Json).tree
    }
    if ($wcRecipe) {
        Invoke-Delta @('assemble-dir', (Join-Path $in $wcRecipe), (Join-Path $in 'webclient'), '--store', $Store, '--files', $Files, '--link')
        if ($script:deltaExit -ne 0) { Fail 'delta.py could not lay out the web client (above)' }
        $newTrees['webclient.zip'] = (Get-Content -Raw -LiteralPath (Join-Path $in $wcRecipe) | ConvertFrom-Json).tree
    }
}

# 3. the host package: its own setup.ps1 (a backup first, every setting and key kept); already in when the delta needed its tools
if ($hostZip -and -not $hostDone) { Install-HostPackage }
if (-not $pkgDir) {
    $pkgDir = Get-ChildItem -LiteralPath 'C:\setup' -Directory -Filter 'havoc9-vps-windows-*' | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
}

# 3b. the official plugin list of this build, into the site's database (h9web's preset-seed.js; it adds, so older builds' hashes stay official)
$presetName = $want.Keys | Where-Object { $kinds[$_] -eq 'preset' } | Select-Object -First 1
$presetFailed = $false
if ($presetName) {
    Say 'the official plugin list'
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Node (Join-Path $Root 'h9web\modules\presence\bin\preset-seed.js') --import-bundle (Join-Path $in $presetName) --config $Config --mode add 2>&1 | ForEach-Object { Write-Host "  $_" }; $presetExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $was }
    if ($presetExit -ne 0) { $presetFailed = $true; Write-Host '  [FAIL] the plugin list was not imported: servers of this build will read "not authenticated" until it is (see above)' -ForegroundColor Red }
    else { $newTrees['preset-bundle'] = $want[$presetName] }
}

# 4. the web client
$wcZip = $want.Keys | Where-Object { $kinds[$_] -eq 'webclient' } | Select-Object -First 1
if ($wcZip -or $wcRecipe) {
    Say "the web client from $(if ($wcZip) { $wcZip } else { 'its recipe' })"
    $wcDir = Join-Path $in 'webclient'
    if ($wcZip) { Expand-Archive -LiteralPath (Join-Path $in $wcZip) -DestinationPath $wcDir }
    $stage = Get-ChildItem -LiteralPath $wcDir -Recurse -Directory -Filter 'stage' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
    if (-not $stage) { Fail "the web client has no stage folder with a manifest.json" }
    # a full setup.ps1 run like Install-HostPackage's, so the file index is left to step 7 the same way
    $setup = Join-Path $pkgDir 'setup.ps1'
    $setupArgs = @('-File', $setup, '-Root', $Root, '-WebClientStage', $stage.FullName, '-NoFingerprint')
    if (Test-ScriptParam $setup 'NoFileIndex') { $setupArgs += '-NoFileIndex' }
    Invoke-Child $setupArgs
    if ($script:childExit -ne 0) { Fail 'setup.ps1 -WebClientStage failed (above)' }
}

# 5. the downloads: each one put in place whole, by a rename in the same folder
Say 'the downloads'
foreach ($n in $want.Keys) {
    if ($kinds[$n] -ne 'button') { continue }
    $dest = Join-Path $Dl $n
    $tmp = Join-Path $Dl ".$n.new"
    # moved, not copied: the delivery folder is on this volume and goes away afterwards, so a ZIP of a gigabyte is a rename here
    Move-Item -LiteralPath (Join-Path $in $n) -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    Write-Host "  $n -> $dest"
}
# the file index is public (https://havoc9.org/downloads/files/): a host package is the site's own installer and code, never a download, so none stays in it
if (Test-Path -LiteralPath $Idx) {
    foreach ($p in @(Get-ChildItem -LiteralPath $Idx -File -Force | Where-Object { $_.Name -like 'havoc9-vps-*' })) {
        Remove-Item -LiteralPath $p.FullName -Force
        Write-Host "  removed $($p.Name) from the public file index (a host package is never published)"
    }
}

# 6. the updater's files: the new ones first, manifest.json last, then the ones no release names any more
if ($tars.Count) {
    Say "H9XASH-Updater's files"
    New-Item -ItemType Directory -Force -Path $Files | Out-Null
    $added = 0
    foreach ($f in Get-ChildItem -LiteralPath $blobDir -File | Where-Object { $_.Name -ne 'manifest.json' }) {
        $dest = Join-Path $Files $f.Name
        if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $f.FullName -Destination $dest; $added++ }
    }
    # a file the delta delivery already put in the store (the same file is in a client ZIP) is the updater's too: copied over, its name is its SHA-256
    foreach ($b in $blobsWanted) {
        $dest = Join-Path $Files $b
        if (Test-Path -LiteralPath $dest) { continue }
        $inStore = Join-Path (Join-Path $Store $b.Substring(0, 2)) $b
        if (Test-Path -LiteralPath $inStore) {
            if ((Sha $inStore) -ne $b) { Fail "the store's copy of $b is not what its name says" }
            Copy-Item -LiteralPath $inStore -Destination ($dest + '.new') -Force
            Move-Item -LiteralPath ($dest + '.new') -Destination $dest -Force
            $added++
        }
    }
    foreach ($b in $blobsWanted) { if (-not (Test-Path -LiteralPath (Join-Path $Files $b))) { Fail "updater file $b is named by the new release but is neither here nor in the delivery nor in the store" } }
    $mj = Join-Path $blobDir 'manifest.json'
    if (Test-Path -LiteralPath $mj) {
        Copy-Item -LiteralPath $mj -Destination (Join-Path $Files '.manifest.json.new') -Force
        Move-Item -LiteralPath (Join-Path $Files '.manifest.json.new') -Destination (Join-Path $Files 'manifest.json') -Force
    }
    $gone = 0
    if ($blobsWanted.Count) {
        foreach ($f in Get-ChildItem -LiteralPath $Files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' -and -not $blobsWanted.Contains($_.Name) }) { Remove-Item -LiteralPath $f.FullName -Force; $gone++ }
    }
    Write-Host "  $added new in this step, $gone no longer named"
}

# 6b. the HD textures: the new ones first, manifest.json last, then the ones the new manifest does not name.
# A delivery that carries no HD archive leaves the folder exactly as it is, which is what [deploy] hd = 0 means.
if ($hdTars.Count) {
    Say 'the HD textures'
    New-Item -ItemType Directory -Force -Path $FilesHd | Out-Null
    $added = 0
    foreach ($f in Get-ChildItem -LiteralPath $hdDir -File | Where-Object { $_.Name -ne 'manifest.json' }) {
        $dest = Join-Path $FilesHd $f.Name
        if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $f.FullName -Destination $dest; $added++ }
    }
    foreach ($b in $hdWanted) { if (-not (Test-Path -LiteralPath (Join-Path $FilesHd $b))) { Fail "HD texture $b is named by the new manifest but is neither here nor in the delivery" } }
    $hmj = Join-Path $hdDir 'manifest.json'
    if (Test-Path -LiteralPath $hmj) {
        Copy-Item -LiteralPath $hmj -Destination (Join-Path $FilesHd '.manifest.json.new') -Force
        Move-Item -LiteralPath (Join-Path $FilesHd '.manifest.json.new') -Destination (Join-Path $FilesHd 'manifest.json') -Force
    }
    $gone = 0
    if ($hdWanted.Count) {
        foreach ($f in Get-ChildItem -LiteralPath $FilesHd -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' -and -not $hdWanted.Contains($_.Name) }) { Remove-Item -LiteralPath $f.FullName -Force; $gone++ }
    }
    Write-Host "  $added new in this step, $gone no longer named"
}

# 7. the file index (under this build's names), the code's fingerprint, and the checks
if ($build) { [IO.File]::WriteAllText((Join-Path $Dl '.build'), "$build`n") }
if ($pkgDir) {
    Say "the downloads' file index"
    Invoke-Child @('-File', (Join-Path $pkgDir 'setup.ps1'), '-Root', $Root, '-FileIndex', '-NoFingerprint')
}
$cc = Join-Path $Root 'code-check.ps1'
$fingerprinted = $false
if (Test-Path -LiteralPath $cc) {
    Say 'the fingerprint of all code'
    Invoke-Child @('-File', $cc, '-Root', $Root, '-Write')
    $fingerprinted = ($script:childExit -eq 0)
}
Say 'checks'
# -SkipCodeCheck: the -Write pass above has fingerprinted these same files and nothing touches them in between, so
# start-all.ps1's code check could only answer "unchanged", after reading every one of them (several GB) again. It is
# passed only when that pass worked, because a failed -Write is what the check would report, and only to a
# start-all.ps1 that declares it (Test-ScriptParam).
$startAll = Join-Path $Root 'start-all.ps1'
$startArgs = @('-File', $startAll, '-Root', $Root)
if ($fingerprinted -and (Test-ScriptParam $startAll 'SkipCodeCheck')) { $startArgs += '-SkipCodeCheck' }
Invoke-Child $startArgs
$ok = ($script:childExit -eq 0) -and -not $presetFailed
if ($ok -and $newTrees.Count) {
    $tr = @{}
    if (Test-Path -LiteralPath $TreeFile) { $old = Get-Content -Raw -LiteralPath $TreeFile | ConvertFrom-Json; foreach ($pn in $old.PSObject.Properties.Name) { $tr[$pn] = $old.$pn } }
    foreach ($k in $newTrees.Keys) { $tr[$k] = $newTrees[$k] }
    [IO.File]::WriteAllText($TreeFile, ($tr | ConvertTo-Json -Compress), (New-Object Text.ASCIIEncoding))
}
Stop-Transcript | Out-Null
if ($ok) { Remove-Item -LiteralPath $in -Recurse -Force; Write-Host '== delivered'; exit 0 }
Write-Host "== delivered, but a check is not OK (above); the delivery is kept in $in" -ForegroundColor Yellow
exit 2

<#
.SYNOPSIS
  One command for a release: builds what packaging.ini says, then delivers it to havoc9.org's host over SSH.

.DESCRIPTION
  Run it in PowerShell 7 from this folder, after a version bump or any change to the client, the site, h9web or the list:
    .\deploy-vps.ps1                 build and deliver everything packaging.ini switches on
    .\deploy-vps.ps1 -NoBuild        deliver what dist\ holds already
    .\deploy-vps.ps1 -Ini <file>     read another ini instead of packaging.ini
    .\deploy-vps.ps1 -SiteOnly       read packaging.site-only.ini instead: the host package alone (the site, h9web and
                                     the list), nothing of the client built or sent. Not together with -Ini.
    .\deploy-vps.ps1 -WhatIf         say what would be built and sent, change nothing

  1. Builds: stage-h9xash.ps1 (the client ZIPs and the updater's files), make-vps-package.ps1 -Target windows (the host package, which
     the host installs and nobody downloads, and the web client's package).
  2. Asks the host what it has (receive-deploy.ps1 -Hashes): each download's SHA-256 and the updater files' names. Only
     what differs is sent: a client ZIP is about 930 MB, so an unchanged one is never sent again, and of the updater's
     files only the new ones go, in archives of at most 400 MB. The question costs the host minutes, so it is asked only
     when the ini switches on something that is compared with the answer. The host package always goes whole, so a
     delivery of the host package alone, such as -SiteOnly, does not ask.
  3. Writes deploy-manifest.txt (each file's SHA-256), sends the files into a new folder under C:\setup\incoming with
     scp, and runs C:\havoc9\receive-deploy.ps1 there. That script is the host's own (administrators only): it takes
     only the names it knows, checks every SHA-256 before it installs anything, installs the host package with its
     setup.ps1 (a backup first), the web client, the downloads and the updater's files, rebuilds the file index and the
     code's fingerprint, and runs start-all.ps1's checks. Its log stays on the host in C:\havoc9\logs\deploy-*.log.

  Security: the connection is SSH with your key only (the host refuses passwords). The key, the address and the user are
  in your own %USERPROFILE%\.ssh\config under the shortcut packaging.ini names, never in this script, packaging.ini or
  git. Nothing is sent to or through GitHub.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Ini = (Join-Path $PSScriptRoot 'packaging.ini'),
    [switch]$NoBuild,
    [switch]$SiteOnly
)

$ErrorActionPreference = 'Stop'
# any error that stops the script stops it with exit code 1, so a caller never reads a failed deploy as done
trap { Write-Host "[FAIL] $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red; exit 1 }
$Here = $PSScriptRoot
$Dist = Join-Path $Here 'dist'
$DryRun = [bool]$WhatIfPreference
$script:deployStart = Get-Date
function Say([string]$t) { Write-Host ("== {0}   [{1:N0} s]" -f $t, ((Get-Date) - $script:deployStart).TotalSeconds) }
function Fail([string]$t) { Write-Host "[FAIL] $t" -ForegroundColor Red; exit 1 }

# -SiteOnly reads packaging.site-only.ini beside this script, and that file is the whole definition of
# a site-only delivery. -Ini names the file to read as well, so the two together are refused rather
# than one of them quietly winning.
if ($SiteOnly) {
    if ($PSBoundParameters.ContainsKey('Ini')) { Fail '-SiteOnly reads packaging.site-only.ini and -Ini names another ini: use one or the other' }
    $Ini = Join-Path $Here 'packaging.site-only.ini'
    Write-Host "-SiteOnly: $Ini" -ForegroundColor Cyan
}

# packaging.ini: [section] key = value, ; comments
$cfg = @{}
$sec = ''
if (-not (Test-Path -LiteralPath $Ini)) { Fail "no $Ini" }
foreach ($raw in [IO.File]::ReadAllLines($Ini)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
    if ($line -match '^\[(.+)\]$') { $sec = $Matches[1].Trim().ToLowerInvariant(); continue }
    if ($line -match '^([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg["$sec.$($Matches[1].ToLowerInvariant())"] = $Matches[2].Trim() }
}
function On([string]$k) { return [string]$cfg[$k] -eq '1' }
# a delta delivery needs no ZIP made here (the host builds them from recipes), so the stage and the packager write LISTS of what each ZIP would hold
# (stage-h9xash.ps1 -Lists, make-vps-package.ps1 -WebClientList): nothing is compressed and read back on this PC. [stage] zips = 1 writes the ZIPs too.
$delta = On 'deploy.delta'
$listMode = $delta -and -not (On 'stage.zips')
# the stage folder the lists point into goes when the delivery is done (a re-run with -NoBuild before that still has it)
function Remove-StageFolders {
    $sd = Join-Path $Dist '.stage'
    if (-not (Test-Path -LiteralPath $sd)) { return }
    foreach ($d in @(Get-ChildItem -LiteralPath $sd -Directory -Filter 'h9xash-stage-*' -ErrorAction SilentlyContinue)) {
        # in the background: a folder of 7,000 files takes a while to delete and nothing waits for it
        Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList @('/c', 'rmdir', '/s', '/q', "`"$($d.FullName)`"") -WindowStyle Hidden | Out-Null
    }
}
# the deploy's own scratch files (the updater archive can be 2 GB): [deploy] scratch in packaging.ini, else dist\.deploy
$Scratch = [string]$cfg['deploy.scratch']
if (-not $Scratch) { $Scratch = Join-Path $Dist '.deploy' }
if (-not (Test-Path -LiteralPath $Scratch)) { New-Item -ItemType Directory -Force -Path $Scratch | Out-Null }
$sshHost = [string]$cfg['deploy.host']
if ($sshHost -notmatch '^[A-Za-z0-9._@-]+$') { Fail "[deploy] host in packaging.ini must be an SSH shortcut such as havoc9-vps" }
# ServerAliveCountMax defaults to 3, so thirty-second keepalives give up after ninety seconds of
# silence. The host goes quiet for longer than that under ordinary load: -Hashes enumerates a store
# of some twelve gigabytes, and delta.py ingests for minutes at a time. On 2026-11-19 that dropped
# the connection mid-query with "client_loop: send disconnect: Connection reset" and failed a deploy
# that had sent nothing and had nothing wrong with it. Twenty keepalives is ten minutes of patience,
# which is longer than any single step the host runs, while a host that is genuinely gone is still
# noticed rather than waited on forever.
$ssh = @('-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=20', '-o', 'ConnectTimeout=20')

# 1. build
if (-not $NoBuild) {
    if (On 'stage.run') {
        $noLinux = [string]$cfg['stage.linux'] -eq '0'
        Say ('stage-h9xash.ps1' + $(if ($noLinux) { ' -NoLinux' } else { '' }) + $(if ($listMode) { ' -Lists' } else { '' }))
        if (-not $DryRun) {
            $stageArgs = @{}
            if ($noLinux) { $stageArgs['NoLinux'] = $true }
            if ($listMode) { $stageArgs['Lists'] = $true }
            & (Join-Path $Here 'stage-h9xash.ps1') @stageArgs
            if ($LASTEXITCODE) { Fail 'stage-h9xash.ps1 failed' }
        }
    }
    if (On 'package.make') {
        $wcSwitch = ''
        if (On 'package.webclient') { $wcSwitch = if ($listMode) { 'WebClientList' } else { 'WebClient' } }
        Say ('make-vps-package.ps1 -Target windows' + $(if ($wcSwitch) { " -$wcSwitch" } else { '' }))
        if (-not $DryRun) {
            # the host is Windows and its package is installed there, never published; a Linux host package is made by hand (make-vps-package.cmd -Target linux)
            $pkArgs = @{ Target = 'windows' }
            if ($wcSwitch) { $pkArgs[$wcSwitch] = $true }
            & (Join-Path $Here 'make-vps-package.ps1') @pkArgs
            if ($LASTEXITCODE) { Fail 'make-vps-package.ps1 failed' }
        }
    }
}

# 1b. the host's own scripts. receive-deploy.ps1 and delta.py are what answers and installs, and the host package installs them only AFTER the
# receiver has run, so an older receiver meets a newer delivery: it refused the preset bundle ("a file this host does not take"). Before the host is
# asked anything, any of the two that differs from this release's is sent and put in place. The host's SSH shell is cmd.
if (-not $DryRun) {
    # lockwatch.cmd travels with them: it is the thing to run when a received file stays unreadable
    # for longer than the receiver's Sha() waits, and it is no use sitting in the repo instead.
    # Every script the host RUNS, not just the ones that answer a delivery: a stale script on the
    # box is invisible until it misbehaves.
    #
    # setup.ps1 and setup.cmd are deliberately absent: they live in the package under C:\setup,
    # never in C:\havoc9, and are covered by the package check below instead.
    $selfFiles = @(
        'receive-deploy.ps1', 'delta.py', 'lockwatch.cmd', 'code-check.ps1',
        'start-all.ps1', 'stop-all.ps1', 'update-game.ps1', 'restore-backup.ps1'
    )
    $selfStale = New-Object System.Collections.Generic.List[string]

    $want = @{}
    foreach ($n in $selfFiles) {
        $local = Join-Path $Here ('vps\windows\' + $n)
        if (-not (Test-Path -LiteralPath $local)) { Fail "no $local" }
        $want[$n] = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    # One round trip for all of them, not one each: eight small files hashed on the host costs
    # nothing, and this is now cheaper than the three separate certutil calls it replaces.
    # -EncodedCommand so none of this has to survive two layers of quoting.
    $list = ($selfFiles | ForEach-Object { "'" + $_ + "'" }) -join ','
    $probe = "foreach (`$n in $list) { `$p = 'C:\havoc9\' + `$n; if (Test-Path -LiteralPath `$p) { `$n + ' ' + (Get-FileHash -LiteralPath `$p -Algorithm SHA256).Hash.ToLowerInvariant() } else { `$n + ' missing' } }"
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
    $out = & ssh @ssh $sshHost "powershell -NoProfile -EncodedCommand $enc" 2>$null

    $have = @{}
    if ($LASTEXITCODE -eq 0) {
        foreach ($l in $out) {
            $parts = ([string]$l).Trim() -split '\s+'
            if ($parts.Count -eq 2 -and $want.ContainsKey($parts[0])) { $have[$parts[0]] = $parts[1].ToLowerInvariant() }
        }
    }
    foreach ($n in $selfFiles) {
        if (-not $have.ContainsKey($n) -or $have[$n] -ne $want[$n]) { $selfStale.Add($n) }
    }
    if ($selfStale.Count) {
        Say "the host's own scripts differ from this release's: $($selfStale -join ', ')"
        & ssh @ssh $sshHost 'mkdir C:\setup\incoming\self 2>nul & echo ok' | Out-Null
        foreach ($n in $selfStale) {
            & scp @ssh -q (Join-Path $Here ('vps\windows\' + $n)) "${sshHost}:C:/setup/incoming/self/$n"
            if ($LASTEXITCODE) { Fail "scp of $n failed" }
            & ssh @ssh $sshHost "copy /y C:\setup\incoming\self\$n C:\havoc9\$n"
            if ($LASTEXITCODE) { Fail "could not put $n in place on the host" }
        }
    }
}

# 2. what the host has
$remote = @{}
$remoteTree = @{}
$blobsThere = New-Object System.Collections.Generic.HashSet[string]
$hdThere = New-Object System.Collections.Generic.HashSet[string]
# This answer exists to spare the big things: a client ZIP the host already has is not sent again,
# and of the updater's files only the new ones go. Getting it means hashing the downloads and
# walking the delivery store, which is minutes of the host's time, so the host is asked only when
# a [deploy] switch that reads the answer is on. Each of these reads it, whole ZIPs or delta alike:
#   client, linux_server  Add-If against $remote, or the delta's have list ($blobsThere) and tree check ($remoteTree)
#   webclient             the web client's manifest against $remote, or the delta as above
#   updater               Add-If against $remote
#   updater_files         $blobsThere, and the files' manifest in $remote
#   hd                    $hdThere, and the HD manifest in $remote
#   preset                the plugin list's entry in $remoteTree
# site is not among them: the host package goes through Add-If with $always set, which never looks
# at the answer. Left empty, every check below reads "the host does not have it" and sends the file.
$readers = @(@('deploy.client', 'deploy.linux_server', 'deploy.webclient', 'deploy.updater',
        'deploy.updater_files', 'deploy.hd', 'deploy.preset') | Where-Object { On $_ })
$answer = @()
if ($readers.Count) {
    Say "asking $sshHost what it has"
    $answer = & ssh @ssh $sshHost 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Hashes'
    if ($LASTEXITCODE) { Fail "the host did not answer (ssh $sshHost). Is the SSH shortcut in your .ssh\config, and C:\havoc9\receive-deploy.ps1 on the host?" }
}
else { Say "not asking $sshHost what it has: nothing $(Split-Path -Leaf $Ini) switches on is compared with it" }
foreach ($l in $answer) {
    if ($l -match '^file ([0-9a-f]{64}) (\S+)$') { $remote[$Matches[2]] = $Matches[1] }
    elseif ($l -match '^(blob|have) ([0-9a-f]{64})$') { [void]$blobsThere.Add($Matches[2]) }
    elseif ($l -match '^hd ([0-9a-f]{64})$') { [void]$hdThere.Add($Matches[1]) }
    elseif ($l -match '^tree (\S+) ([0-9a-f]{64})$') { $remoteTree[$Matches[1]] = $Matches[2] }
}
# Room on the host, asked for BEFORE anything is sent. A delivery stages about 10 GB there and the
# host keeps a failed one so it can be looked at, so two failures in a row fill the disk. On
# 2026-11-19 they did: the box reached zero bytes free, delta.py died mid-write, and sshd could no
# longer complete a login, so the only way in to clear it was the provider's console. The host's own
# receive-deploy.ps1 refuses too, but refusing there is forty minutes of upload spent first, so the
# cheap check belongs here as well. Both are now sized to the delivery rather than fixed: a flat 20 GB
# on the host turned a 0.25 GB delta away from a box with 8.9 GB free, after the upload had finished,
# and 1.68 silently never landed. A delta exists so a small change is a small delivery.
# A floor only. The real check is further down, once the size of THIS delivery is known: a flat
# figure here either refuses a 200 MB delivery for no reason or waves through a 10 GB one. This
# just refuses to begin against a host that is already at death's door, where even building the
# delta would fail and sshd itself starts dropping logins.
$needGB = 6
$freeOut = & ssh @ssh $sshHost 'powershell -NoProfile -Command "[math]::Round((Get-PSDrive C).Free/1GB,1)"'
$freeGB = 0.0
foreach ($l in $freeOut) { if ("$l".Trim() -match '^[0-9]+(\.[0-9]+)?$') { $freeGB = [double]("$l".Trim()); break } }
if ($freeGB -gt 0 -and $freeGB -lt $needGB) {
    Write-Host "[FAIL] $sshHost has $freeGB GB free and a delivery wants about $needGB GB." -ForegroundColor Red
    Write-Host '  Nothing has been sent. Deliveries that failed are kept on the host to be looked at and are the usual cause:'
    & ssh @ssh $sshHost 'powershell -NoProfile -Command "Get-ChildItem C:\setup\incoming -Directory | ForEach-Object { $s=(Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; Write-Host (\"    \" + $_.Name + \"  \" + [math]::Round($s/1GB,2) + \" GB  \" + $_.LastWriteTime.ToString(\"yyyy-MM-dd\")) }"'
    Write-Host '  Remove the ones you do not need:  ssh <host> "rmdir /s /q C:\setup\incoming\<name>"'
    Write-Host '  C:\havoc9\store is the compressed copy of every file ever delivered. It is NOT scratch: deleting it'
    Write-Host '  makes the next delta send everything again.'
    exit 1
}
if ($freeGB -gt 0) { Say ("the host has {0} GB free" -f $freeGB) }

function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function Newest([string]$pattern) { Get-ChildItem -LiteralPath $Dist -File -Filter $pattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1 }

# 3. what goes
$send = New-Object System.Collections.Generic.List[object]
function Add-If([string]$path, [string]$name, [bool]$always) {
    if (-not (Test-Path -LiteralPath $path)) { Write-Host "  [skip] ${name}: no $path"; return }
    $h = Sha $path
    if (-not $always -and $remote[$name] -eq $h) { Write-Host "  same on the host: $name"; return }
    $send.Add([pscustomobject]@{ Path = $path; Name = $name; Sha = $h; Size = (Get-Item -LiteralPath $path).Length })
}
if ((On 'deploy.client') -and -not $delta) { Add-If (Join-Path $Dist 'H9XASH.zip') 'H9XASH.zip' $false; Add-If (Join-Path $Dist 'H9XASH-linux.zip') 'H9XASH-linux.zip' $false }
if (On 'deploy.updater') { Add-If (Join-Path $Dist 'H9XASH-Updater.exe') 'H9XASH-Updater.exe' $false }
if ((On 'deploy.linux_server') -and -not $delta) { Add-If (Join-Path $Dist 'H9XASH-linux-server.zip') 'H9XASH-linux-server.zip' $false }
# the host package: installed by the host from C:\setup, never put in the public downloads' file index
if (On 'deploy.site') {
    $z = Newest 'havoc9-vps-windows-*.zip'
    if ($z) {
        # The package carries its OWN copy of every host script and installs them over whatever is
        # on the box, so a package built before a script changed puts the old one back and the next
        # delivery meets it again. Reading those entries out of the zip is local and costs nothing,
        # so it happens before anything is sent rather than after a long upload.
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $stalePkg = New-Object System.Collections.Generic.List[string]
        try {
            $zip = [IO.Compression.ZipFile]::OpenRead($z.FullName)
            try {
                foreach ($e in $zip.Entries) {
                    if ($e.Name -notmatch '\.(ps1|py|cmd)$') { continue }
                    $local = Join-Path $Here ('vps\windows\' + $e.Name)
                    if (-not (Test-Path -LiteralPath $local)) { continue }
                    $s = $e.Open()
                    try {
                        $ms = New-Object IO.MemoryStream
                        $s.CopyTo($ms)
                        $inZip = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($ms.ToArray())).Replace('-', '').ToLowerInvariant()
                    }
                    finally { $s.Dispose() }
                    if ($inZip -ne (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()) { $stalePkg.Add($e.Name) }
                }
            }
            finally { $zip.Dispose() }
        }
        catch { Write-Host "  [warn] could not read $($z.Name) to check its scripts: $($_.Exception.Message)" }

        if ($stalePkg.Count) {
            Write-Host "[FAIL] $($z.Name) was built before these scripts changed, and installing it would put the old ones back:" -ForegroundColor Red
            foreach ($n in $stalePkg) { Write-Host "    $n" }
            Write-Host '  Re-stage the host package so it carries the current scripts, then deploy again:'
            Write-Host '    .\make-vps-package.ps1 -Target windows'
            Write-Host '  Nothing has been sent.'
            exit 1
        }
        Add-If $z.FullName $z.Name $true
    }
    else { Write-Host '  [skip] no dist\havoc9-vps-windows-*.zip' }
}
if ((On 'deploy.webclient') -and -not $delta) {
    $z = Newest 'havoc9-vps-webclient-*.zip'
    $m = Join-Path $Here 'webclient-build\stage\manifest.json'
    if ($z -and (Test-Path -LiteralPath $m) -and $remote['webclient-manifest.json'] -eq (Sha $m)) { Write-Host '  same on the host: the web client' }
    elseif ($z) { Add-If $z.FullName $z.Name $true }
}
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# deploy-vps.ps1 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
# the build (VERSION.txt, "Build: 1.61"; the stage raises it): the host's file index lists the downloads under it
$vf = Join-Path $Here 'VERSION.txt'
if (Test-Path -LiteralPath $vf) {
    $m = [regex]::Match([IO.File]::ReadAllText($vf), '(?m)^\s*Build:\s*([0-9][A-Za-z0-9._-]{0,31})\s*$')
    if ($m.Success) { $lines.Add("build $($m.Groups[1].Value)"); Say "build $($m.Groups[1].Value)" }
}
$tar = $null
$missing = @()
$files = Join-Path $Dist 'files'
if ((On 'deploy.updater_files') -and (Test-Path -LiteralPath (Join-Path $files 'manifest.json'))) {
    $blobs = @(Get-ChildItem -LiteralPath $files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { $_.Name })
    $missing = @($blobs | Where-Object { -not $blobsThere.Contains($_) })
    $mj = Sha (Join-Path $files 'manifest.json')
    if ($missing.Count -or $remote['manifest.json'] -ne $mj -or ($blobsThere.Count -ne $blobs.Count)) {
        foreach ($b in $blobs) { $lines.Add("blob $b") }
        $lines.Add("updater-manifest $mj")
        # in pieces of at most 400 MB, so they go over several streams at once (manifest.json in the first)
        $pieces = New-Object System.Collections.Generic.List[object]
        $cur = New-Object System.Collections.Generic.List[string]; $cur.Add('manifest.json'); $curSize = 0
        foreach ($b in $missing) {
            $sz = (Get-Item -LiteralPath (Join-Path $files $b)).Length
            if ($cur.Count -gt 0 -and $curSize + $sz -gt 400MB) { $pieces.Add($cur); $cur = New-Object System.Collections.Generic.List[string]; $curSize = 0 }
            $cur.Add($b); $curSize += $sz
        }
        if ($cur.Count) { $pieces.Add($cur) }
        Say "the updater's files: $($missing.Count) of $($blobs.Count) are new to the host, in $($pieces.Count) archive(s)"
        if (-not $DryRun) {
            $tars = @()
            for ($i = 0; $i -lt $pieces.Count; $i++) {
                $name = 'updater-files-{0}.tar' -f ($i + 1)
                $tar = Join-Path $Scratch $name
                $list = Join-Path $Scratch "$name.list"
                [IO.File]::WriteAllLines($list, [string[]]$pieces[$i])
                if (Test-Path -LiteralPath $tar) { [IO.File]::Delete($tar) }
                & "$env:SystemRoot\System32\tar.exe" -cf $tar -C $files -T $list
                if ($LASTEXITCODE) { Fail "could not make $name" }
                $send.Add([pscustomobject]@{ Path = $tar; Name = $name; Sha = (Sha $tar); Size = (Get-Item -LiteralPath $tar).Length })
                $tars += $tar
            }
        }
    } else { Write-Host "  same on the host: the updater's files ($($blobs.Count))" }
}

# The HD textures, when packaging.ini asks for them. Their own store at dist\files\hd, delivered
# into site\files\hd on the host: the host says which blobs it already holds and only the rest
# go over. The first delivery is about 10.5 GB, which is better carried there by hand; after that
# a pass that re-upscales fifty textures sends fifty files (docs\HD_TEXTURES.txt).
$hdFiles = Join-Path $files 'hd'
if ((On 'deploy.hd') -and (Test-Path -LiteralPath (Join-Path $hdFiles 'manifest.json'))) {
    $hdBlobs = @(Get-ChildItem -LiteralPath $hdFiles -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { $_.Name })
    $hdMissing = @($hdBlobs | Where-Object { -not $hdThere.Contains($_) })
    $hmj = Sha (Join-Path $hdFiles 'manifest.json')
    if ($hdMissing.Count -or $remote['hd-manifest.json'] -ne $hmj -or ($hdThere.Count -ne $hdBlobs.Count)) {
        foreach ($b in $hdBlobs) { $lines.Add("hd $b") }
        $lines.Add("hd-manifest $hmj")
        $hdPieces = New-Object System.Collections.Generic.List[object]
        $cur = New-Object System.Collections.Generic.List[string]; $cur.Add('manifest.json'); $curSize = 0
        foreach ($b in $hdMissing) {
            $sz = (Get-Item -LiteralPath (Join-Path $hdFiles $b)).Length
            if ($cur.Count -gt 0 -and $curSize + $sz -gt 400MB) { $hdPieces.Add($cur); $cur = New-Object System.Collections.Generic.List[string]; $curSize = 0 }
            $cur.Add($b); $curSize += $sz
        }
        if ($cur.Count) { $hdPieces.Add($cur) }
        $hdBytes = 0; foreach ($b in $hdMissing) { $hdBytes += (Get-Item -LiteralPath (Join-Path $hdFiles $b)).Length }
        Say ("the HD textures: {0} of {1} are new to the host ({2:N1} GB), in {3} archive(s)" -f $hdMissing.Count, $hdBlobs.Count, ($hdBytes / 1GB), $hdPieces.Count)
        if (-not $DryRun) {
            for ($i = 0; $i -lt $hdPieces.Count; $i++) {
                $name = 'hd-files-{0}.tar' -f ($i + 1)
                $t = Join-Path $Scratch $name
                $list = Join-Path $Scratch "$name.list"
                [IO.File]::WriteAllLines($list, [string[]]$hdPieces[$i])
                if (Test-Path -LiteralPath $t) { [IO.File]::Delete($t) }
                & "$env:SystemRoot\System32\tar.exe" -cf $t -C $hdFiles -T $list
                if ($LASTEXITCODE) { Fail "could not make $name" }
                $send.Add([pscustomobject]@{ Path = $t; Name = $name; Sha = (Sha $t); Size = (Get-Item -LiteralPath $t).Length })
            }
        }
    } else { Write-Host "  same on the host: the HD textures ($($hdBlobs.Count))" }
}
$pyArgs = @(); $pyExe = 'python'
if (Get-Command py -ErrorAction SilentlyContinue) { $pyExe = 'py'; $pyArgs = @('-3') }

# the official plugin list (tools\preset_bundle.py): a release that rebuilds a plugin changes its hash, so the host must get the build's list
# with it or the servers of that build read "not authenticated". Sent when it differs from what the host imported last.
if (On 'deploy.preset') {
    $presetFile = Join-Path $Scratch 'preset-bundle.json'
    $lin = Join-Path $Here 'H9XASH-linux'
    $bargs = $pyArgs + @('-I', (Join-Path $Here 'tools\preset_bundle.py'), '--h9xash', (Join-Path $Here 'H9XASH'), '--out', $presetFile)
    if (Test-Path -LiteralPath $lin) { $bargs += @('--linux', $lin) }
    Say 'the official plugin list of this build'
    if ($DryRun) { Write-Host '  (a dry run: not made)' }
    else {
        & $pyExe @bargs 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -or -not (Test-Path -LiteralPath $presetFile)) { Fail 'tools\preset_bundle.py failed: the release would leave the plugin list behind (preset = 0 in packaging.ini turns this off)' }
        $psha = Sha $presetFile
        if ($remoteTree['preset-bundle'] -eq $psha) { Write-Host '  same list as the host imported last' }
        else { $send.Add([pscustomobject]@{ Path = $presetFile; Name = 'preset-bundle.json'; Sha = $psha; Size = (Get-Item -LiteralPath $presetFile).Length }) }
    }
}

# the delta (vps\windows\delta.py): the client ZIPs and the web client go as recipes plus only the files the host has not seen; the host builds
# the ZIPs. The updater's new files, sent above, count as seen. A source whose tree the host built already is not sent again.
if ($delta) {
    $specs = New-Object System.Collections.Generic.List[object]
    # a package is read from its list when the stage wrote one that is not older than its ZIP, else from its ZIP
    function Add-Spec([string]$name, [string]$zip, [string]$list) {
        $zOk = Test-Path -LiteralPath $zip -PathType Leaf
        $lOk = Test-Path -LiteralPath $list -PathType Leaf
        if ($lOk -and (-not $zOk -or (Get-Item -LiteralPath $list).LastWriteTime -ge (Get-Item -LiteralPath $zip).LastWriteTime)) { $specs.Add([pscustomobject]@{ Kind = 'list'; Name = $name; Path = $list }) }
        elseif ($zOk) { $specs.Add([pscustomobject]@{ Kind = 'zip'; Name = $name; Path = $zip }) }
    }
    if (On 'deploy.client') { foreach ($n in 'H9XASH.zip', 'H9XASH-linux.zip') { Add-Spec $n (Join-Path $Dist $n) ((Join-Path $Dist $n) + '.list.json') } }
    if (On 'deploy.linux_server') { Add-Spec 'H9XASH-linux-server.zip' (Join-Path $Dist 'H9XASH-linux-server.zip') ((Join-Path $Dist 'H9XASH-linux-server.zip') + '.list.json') }
    if (On 'deploy.webclient') { $wz = Newest 'havoc9-vps-webclient-*.zip'; Add-Spec 'webclient.zip' $(if ($wz) { $wz.FullName } else { Join-Path $Dist 'webclient.zip' }) (Join-Path $Dist 'webclient.list.json') }
    if ($specs.Count) {
        $dout = Join-Path $Scratch 'delta'
        $haveFile = Join-Path $Scratch 'have.txt'
        $seen = New-Object System.Collections.Generic.HashSet[string]($blobsThere)
        foreach ($b in $missing) { [void]$seen.Add($b) }
        [IO.File]::WriteAllLines($haveFile, [string[]]@($seen))
        $planArgs = $pyArgs + @('-I', (Join-Path $Here 'vps\windows\delta.py'), 'plan', '--out-dir', $dout, '--have', $haveFile)
        foreach ($s in $specs) { $planArgs += @("--$($s.Kind)", ($s.Name + '=' + $s.Path)) }
        Say ("the delta: $($specs.Count) package(s), from " + (($specs | ForEach-Object { $_.Kind + 's' } | Select-Object -Unique) -join ' and ') + $(if (@($specs | Where-Object { $_.Kind -eq 'zip' }).Count) { ' (a minute for each ZIP read back)' } else { '' }))
        if ($DryRun) { Write-Host '  (a dry run: not read)' }
        else {
            $planLine = @(& $pyExe @planArgs | Where-Object { $_ -like 'PLAN *' }) | Select-Object -Last 1
            if ($LASTEXITCODE -or -not $planLine) { Fail 'delta.py plan failed' }
            $plan = ([string]$planLine).Substring(5) | ConvertFrom-Json
            $anyNew = $false
            foreach ($s in $specs) {
                $name = $s.Name
                $info = $plan.sources.$name
                $rf = Join-Path $dout "$name.recipe.json"
                if ($remoteTree[$name] -eq $info.tree) { Write-Host "  same on the host: $name"; continue }
                $send.Add([pscustomobject]@{ Path = $rf; Name = "$name.recipe.json"; Sha = (Sha $rf); Size = (Get-Item -LiteralPath $rf).Length })
                $anyNew = $true
                Write-Host ('  {0}: {1} files, {2:N0} MB' -f $name, $info.files, ($info.bytes / 1MB))
            }
            if ($anyNew) {
                Write-Host ('  new to the host: {0} files, {1:N0} MB' -f $plan.new_files, ($plan.new_bytes / 1MB))
                foreach ($bt in $plan.tars) { $bp = Join-Path $dout $bt; $send.Add([pscustomobject]@{ Path = $bp; Name = $bt; Sha = (Sha $bp); Size = (Get-Item -LiteralPath $bp).Length }) }
            }
        }
    }
}
if (-not $send.Count) {
    Say 'nothing to send: the host has all of it'
    if ($DryRun) { exit 0 }
    Remove-StageFolders
    # the checks are the end of every deploy, also of one that sent nothing (a re-run after a delivery that stopped before them)
    Say 'verifying the release (verify-release.ps1)'
    & (Join-Path $Here 'verify-release.ps1') -Ini $Ini
    exit $LASTEXITCODE
}
foreach ($s in $send) { $lines.Add("$($s.Sha)  $($s.Name)") }
$sendGB = (($send | Measure-Object Size -Sum).Sum) / 1GB
# The real check, now that the size of this delivery is known rather than guessed. The early check
# above is only a floor against a host already at death's door; refusing a 200 MB delivery because
# the host holds less than some flat figure is a false alarm that sends somebody deleting things for
# nothing. The host needs room for the delivery to land, for the store to take it in, and for the
# ZIPs it builds from the recipes, so ask for three times what is being sent plus a little.
if ($freeGB -gt 0) {
    $wantGB = [math]::Round(($sendGB * 3) + 2, 1)
    if ($freeGB -lt $wantGB) {
        Write-Host ("[FAIL] this delivery is {0:N1} GB and {1} has {2} GB free; it wants about {3} GB." -f $sendGB, $sshHost, $freeGB, $wantGB) -ForegroundColor Red
        Write-Host '  Nothing has been sent. The host needs room for the delivery, for its store to take it in, and for the ZIPs it builds.'
        Write-Host '  On the host, in order of what gives most back:'
        Write-Host '    dism /online /cleanup-image /startcomponentcleanup /resetbase'
        Write-Host '    net stop wuauserv & rmdir /s /q C:\Windows\SoftwareDistribution\Download & net start wuauserv'
        Write-Host '    rmdir /s /q C:\setup\incoming\<an old delivery>'
        Write-Host '  C:\havoc9\store is NOT scratch: deleting it makes the next delta send everything again.'
        exit 1
    }
}
Say ('sending {0} file(s), {1:N0} MB' -f $send.Count, (($send | Measure-Object Size -Sum).Sum / 1MB))
$send | ForEach-Object { Write-Host ('  {0,-48} {1,10:N1} MB' -f $_.Name, ($_.Size / 1MB)) }
if ($DryRun) { exit 0 }

# 4. deliver
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$inbox = "C:/setup/incoming/$stamp"
$man = Join-Path $Scratch 'deploy-manifest.txt'
[IO.File]::WriteAllLines($man, [string[]]$lines)
# the host's SSH shell is cmd: a plain mkdir (which makes the folders on the way), nothing cmd could read as a pipe
& ssh @ssh $sshHost "mkdir C:\setup\incoming\$stamp"
if ($LASTEXITCODE) { Fail 'could not make the delivery folder on the host' }
$send.Add([pscustomobject]@{ Path = $man; Name = 'deploy-manifest.txt'; Sha = ''; Size = 0 })
# several scp at once ([deploy] streams, default 4): one SSH stream to the host is held to a few MB/s by the distance,
# and the connection carries more; the biggest files start first
$streams = 4; if ([string]$cfg['deploy.streams'] -match '^[1-9][0-9]?$') { $streams = [int]$cfg['deploy.streams'] }
# A dropped stream used to be fatal, and the HD pack is 4.55 GB in twelve archives: one broken
# pipe out of twelve and every one had to go again. scp cannot resume, but an archive is at most
# 400 MB, so a failed one is re-queued and only that piece is re-sent. It goes to the BACK of the
# queue, which is the backoff too: a stream usually drops because the link is saturated, so the
# rest drains first. [deploy] tries is the total number of goes at any one file.
$tries = 3; if ([string]$cfg['deploy.tries'] -match '^[1-9]$') { $tries = [int]$cfg['deploy.tries'] }
$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($s in ($send | Sort-Object Size -Descending)) { $queue.Enqueue($s) }
$running = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[string]
$attempts = @{}
$t0 = Get-Date
while ($queue.Count -or $running.Count) {
    while ($queue.Count -and $running.Count -lt $streams) {
        $s = $queue.Dequeue()
        $scpArgs = @($ssh) + @('-q', "`"$($s.Path)`"", "${sshHost}:$inbox/$($s.Name)")
        $p = Start-Process -FilePath 'scp' -ArgumentList $scpArgs -NoNewWindow -PassThru
        $null = $p.Handle
        $running.Add([pscustomobject]@{ Proc = $p; File = $s })
        Write-Host "  scp $($s.Name) ($([int]($s.Size / 1MB)) MB)"
    }
    Start-Sleep -Milliseconds 500
    foreach ($r in $running.ToArray()) {
        if (-not $r.Proc.HasExited) { continue }
        [void]$running.Remove($r)
        if ($r.Proc.ExitCode -ne 0) {
            $n = 1 + [int]$attempts[$r.File.Name]
            $attempts[$r.File.Name] = $n
            if ($n -lt $tries) {
                Write-Host ("  [retry {0} of {1}] scp {2}" -f ($n + 1), $tries, $r.File.Name) -ForegroundColor Yellow
                $queue.Enqueue($r.File)
            }
            else {
                $failed.Add($r.File.Name)
                Write-Host ("  [FAIL] scp {0}, {1} attempt(s)" -f $r.File.Name, $n) -ForegroundColor Red
            }
        }
        else { Write-Host ('  sent {0} ({1:N0} s since the start)' -f $r.File.Name, ((Get-Date) - $t0).TotalSeconds) }
    }
}
if ($failed.Count) { Fail "scp failed for: $($failed -join ', ') after $tries attempt(s) each (nothing was installed; run it again)" }
Say 'the host checks and installs it'
& ssh @ssh $sshHost "powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Incoming C:\setup\incoming\$stamp"
$rc = $LASTEXITCODE
foreach ($t in @($tars)) { if ($t -and (Test-Path -LiteralPath $t)) { [IO.File]::Delete($t); [IO.File]::Delete("$t.list") } }
if ($rc -eq 0) { Say 'deployed'; Remove-StageFolders } else { Write-Host "[FAIL] the host's receive-deploy.ps1 said no (above); its log: C:\havoc9\logs\deploy-*.log" -ForegroundColor Red }
# the release is everywhere it should be (the manifest, the build file, the bot's About Me, the downloads, the join gate, the host's game folder)
if ($rc -eq 0) {
    Say 'verifying the release (verify-release.ps1)'
    & (Join-Path $Here 'verify-release.ps1') -Ini $Ini
    if ($LASTEXITCODE) { Write-Host '[FAIL] the release is not everywhere it should be (above)' -ForegroundColor Red; $rc = 1 }
}
exit $rc

<#
.SYNOPSIS
  One command for a release: builds what packaging.ini says, then delivers it to havoc9.org's host over SSH.

.DESCRIPTION
  Run it in PowerShell 7 from this folder, after a version bump or any change to the client, the site, h9web or the list:
    .\deploy-vps.ps1                 build and deliver everything packaging.ini switches on
    .\deploy-vps.ps1 -NoBuild        deliver what dist\ holds already
    .\deploy-vps.ps1 -WhatIf         say what would be built and sent, change nothing

  1. Builds: stage-h9xash.ps1 (the client ZIPs and the updater's files), make-vps-package.ps1 (the host package, and the
     web client's package).
  2. Asks the host what it has (receive-deploy.ps1 -Hashes): each download's SHA-256 and the updater files' names. Only
     what differs is sent: a client ZIP is about 930 MB, so an unchanged one is never sent again, and of the updater's
     files only the new ones go, in one archive.
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
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
# any error that stops the script stops it with exit code 1, so a caller never reads a failed deploy as done
trap { Write-Host "[FAIL] $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red; exit 1 }
$Here = $PSScriptRoot
$Dist = Join-Path $Here 'dist'
$DryRun = [bool]$WhatIfPreference
function Say([string]$t) { Write-Host "== $t" }
function Fail([string]$t) { Write-Host "[FAIL] $t" -ForegroundColor Red; exit 1 }

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
# the deploy's own scratch files (the updater archive can be 2 GB): [deploy] scratch in packaging.ini, else dist\.deploy
$Scratch = [string]$cfg['deploy.scratch']
if (-not $Scratch) { $Scratch = Join-Path $Dist '.deploy' }
if (-not (Test-Path -LiteralPath $Scratch)) { New-Item -ItemType Directory -Force -Path $Scratch | Out-Null }
$sshHost = [string]$cfg['deploy.host']
if ($sshHost -notmatch '^[A-Za-z0-9._@-]+$') { Fail "[deploy] host in packaging.ini must be an SSH shortcut such as havoc9-vps" }
$ssh = @('-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=20')

# 1. build
if (-not $NoBuild) {
    if (On 'stage.run') {
        $noLinux = [string]$cfg['stage.linux'] -eq '0'
        Say ('stage-h9xash.ps1' + $(if ($noLinux) { ' -NoLinux' } else { '' }))
        if (-not $DryRun) {
            if ($noLinux) { & (Join-Path $Here 'stage-h9xash.ps1') -NoLinux } else { & (Join-Path $Here 'stage-h9xash.ps1') }
            if ($LASTEXITCODE) { Fail 'stage-h9xash.ps1 failed' }
        }
    }
    if (On 'package.make') {
        Say ('make-vps-package.ps1' + $(if (On 'package.webclient') { ' -WebClient' } else { '' }))
        if (-not $DryRun) {
            if (On 'package.webclient') { & (Join-Path $Here 'make-vps-package.ps1') -WebClient } else { & (Join-Path $Here 'make-vps-package.ps1') }
            if ($LASTEXITCODE) { Fail 'make-vps-package.ps1 failed' }
        }
    }
}

# 1b. the host's own scripts. receive-deploy.ps1 and delta.py are what answers and installs, and the host package installs them only AFTER the
# receiver has run, so an older receiver meets a newer delivery: it refused the preset bundle ("a file this host does not take"). Before the host is
# asked anything, any of the two that differs from this release's is sent and put in place. The host's SSH shell is cmd.
if (-not $DryRun) {
    $selfFiles = @('receive-deploy.ps1', 'delta.py')
    $selfStale = New-Object System.Collections.Generic.List[string]
    foreach ($n in $selfFiles) {
        $local = Join-Path $Here ('vps\windows\' + $n)
        if (-not (Test-Path -LiteralPath $local)) { Fail "no $local" }
        $want = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()
        $out = & ssh @ssh $sshHost "certutil -hashfile C:\havoc9\$n SHA256" 2>$null
        $have = ''
        if ($LASTEXITCODE -eq 0) { foreach ($l in $out) { $c = ([string]$l).Replace(' ', '').Trim().ToLowerInvariant(); if ($c -match '^[0-9a-f]{64}$') { $have = $c; break } } }
        if ($have -ne $want) { $selfStale.Add($n) }
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
Say "asking $sshHost what it has"
$remote = @{}
$remoteTree = @{}
$blobsThere = New-Object System.Collections.Generic.HashSet[string]
$answer = & ssh @ssh $sshHost 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Hashes'
if ($LASTEXITCODE) { Fail "the host did not answer (ssh $sshHost). Is the SSH shortcut in your .ssh\config, and C:\havoc9\receive-deploy.ps1 on the host?" }
foreach ($l in $answer) {
    if ($l -match '^file ([0-9a-f]{64}) (\S+)$') { $remote[$Matches[2]] = $Matches[1] }
    elseif ($l -match '^(blob|have) ([0-9a-f]{64})$') { [void]$blobsThere.Add($Matches[2]) }
    elseif ($l -match '^tree (\S+) ([0-9a-f]{64})$') { $remoteTree[$Matches[1]] = $Matches[2] }
}
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
$delta = On 'deploy.delta'
if ((On 'deploy.client') -and -not $delta) { Add-If (Join-Path $Dist 'H9XASH.zip') 'H9XASH.zip' $false; Add-If (Join-Path $Dist 'H9XASH-linux.zip') 'H9XASH-linux.zip' $false }
if (On 'deploy.updater') { Add-If (Join-Path $Dist 'H9XASH-Updater.exe') 'H9XASH-Updater.exe' $false }
if ((On 'deploy.linux_server') -and -not $delta) { Add-If (Join-Path $Dist 'H9XASH-linux-server.zip') 'H9XASH-linux-server.zip' $false }
if (On 'deploy.site') { $z = Newest 'havoc9-vps-windows-*.zip'; if ($z) { Add-If $z.FullName $z.Name $true } else { Write-Host '  [skip] no dist\havoc9-vps-windows-*.zip' } }
if (On 'deploy.publish_host_packages') { $z = Newest 'havoc9-vps-linux-*.zip'; if ($z) { Add-If $z.FullName $z.Name $true } }
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
    $specs = New-Object System.Collections.Generic.List[string]
    if (On 'deploy.client') { foreach ($n in 'H9XASH.zip', 'H9XASH-linux.zip') { if (Test-Path -LiteralPath (Join-Path $Dist $n)) { $specs.Add("$n=" + (Join-Path $Dist $n)) } } }
    if ((On 'deploy.linux_server') -and (Test-Path -LiteralPath (Join-Path $Dist 'H9XASH-linux-server.zip'))) { $specs.Add('H9XASH-linux-server.zip=' + (Join-Path $Dist 'H9XASH-linux-server.zip')) }
    if (On 'deploy.webclient') { $wz = Newest 'havoc9-vps-webclient-*.zip'; if ($wz) { $specs.Add('webclient.zip=' + $wz.FullName) } }
    if ($specs.Count) {
        $dout = Join-Path $Scratch 'delta'
        $haveFile = Join-Path $Scratch 'have.txt'
        $seen = New-Object System.Collections.Generic.HashSet[string]($blobsThere)
        foreach ($b in $missing) { [void]$seen.Add($b) }
        [IO.File]::WriteAllLines($haveFile, [string[]]@($seen))
        $planArgs = $pyArgs + @('-I', (Join-Path $Here 'vps\windows\delta.py'), 'plan', '--out-dir', $dout, '--have', $haveFile)
        foreach ($s in $specs) { $planArgs += @('--zip', $s) }
        Say ("the delta: reading $($specs.Count) ZIP(s) (a minute)")
        if ($DryRun) { Write-Host '  (a dry run: not read)' }
        else {
            $planLine = @(& $pyExe @planArgs | Where-Object { $_ -like 'PLAN *' }) | Select-Object -Last 1
            if ($LASTEXITCODE -or -not $planLine) { Fail 'delta.py plan failed' }
            $plan = ([string]$planLine).Substring(5) | ConvertFrom-Json
            $anyNew = $false
            foreach ($s in $specs) {
                $name = $s.Split('=')[0]
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
if (-not $send.Count) { Say 'nothing to send: the host has all of it'; exit 0 }
foreach ($s in $send) { $lines.Add("$($s.Sha)  $($s.Name)") }
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
$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($s in ($send | Sort-Object Size -Descending)) { $queue.Enqueue($s) }
$running = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[string]
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
        if ($r.Proc.ExitCode -ne 0) { $failed.Add($r.File.Name); Write-Host "  [FAIL] scp $($r.File.Name)" -ForegroundColor Red }
        else { Write-Host ('  sent {0} ({1:N0} s since the start)' -f $r.File.Name, ((Get-Date) - $t0).TotalSeconds) }
    }
}
if ($failed.Count) { Fail "scp failed for: $($failed -join ', ') (nothing was installed; run it again)" }
Say 'the host checks and installs it'
& ssh @ssh $sshHost "powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Incoming C:\setup\incoming\$stamp"
$rc = $LASTEXITCODE
foreach ($t in @($tars)) { if ($t -and (Test-Path -LiteralPath $t)) { [IO.File]::Delete($t); [IO.File]::Delete("$t.list") } }
if ($rc -eq 0) { Say 'deployed' } else { Write-Host "[FAIL] the host's receive-deploy.ps1 said no (above); its log: C:\havoc9\logs\deploy-*.log" -ForegroundColor Red }
exit $rc

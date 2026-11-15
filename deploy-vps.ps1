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

# 2. what the host has
Say "asking $sshHost what it has"
$remote = @{}
$blobsThere = New-Object System.Collections.Generic.HashSet[string]
$answer = & ssh @ssh $sshHost 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Hashes'
if ($LASTEXITCODE) { Fail "the host did not answer (ssh $sshHost). Is the SSH shortcut in your .ssh\config, and C:\havoc9\receive-deploy.ps1 on the host?" }
foreach ($l in $answer) {
    if ($l -match '^file ([0-9a-f]{64}) (\S+)$') { $remote[$Matches[2]] = $Matches[1] }
    elseif ($l -match '^blob ([0-9a-f]{64})$') { [void]$blobsThere.Add($Matches[1]) }
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
if (On 'deploy.client') { Add-If (Join-Path $Dist 'H9XASH.zip') 'H9XASH.zip' $false; Add-If (Join-Path $Dist 'H9XASH-linux.zip') 'H9XASH-linux.zip' $false }
if (On 'deploy.updater') { Add-If (Join-Path $Dist 'H9XASH-Updater.exe') 'H9XASH-Updater.exe' $false }
if (On 'deploy.linux_server') { Add-If (Join-Path $Dist 'H9XASH-linux-server.zip') 'H9XASH-linux-server.zip' $false }
if (On 'deploy.site') { $z = Newest 'havoc9-vps-windows-*.zip'; if ($z) { Add-If $z.FullName $z.Name $true } else { Write-Host '  [skip] no dist\havoc9-vps-windows-*.zip' } }
if (On 'deploy.publish_host_packages') { $z = Newest 'havoc9-vps-linux-*.zip'; if ($z) { Add-If $z.FullName $z.Name $true } }
if (On 'deploy.webclient') {
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
$files = Join-Path $Dist 'files'
if ((On 'deploy.updater_files') -and (Test-Path -LiteralPath (Join-Path $files 'manifest.json'))) {
    $blobs = @(Get-ChildItem -LiteralPath $files -File | Where-Object { $_.Name -match '^[0-9a-f]{64}$' } | ForEach-Object { $_.Name })
    $missing = @($blobs | Where-Object { -not $blobsThere.Contains($_) })
    $mj = Sha (Join-Path $files 'manifest.json')
    if ($missing.Count -or $remote['manifest.json'] -ne $mj -or ($blobsThere.Count -ne $blobs.Count)) {
        foreach ($b in $blobs) { $lines.Add("blob $b") }
        $lines.Add("updater-manifest $mj")
        $tar = Join-Path $Scratch 'updater-files.tar'
        $list = Join-Path $Scratch 'updater-files.list'
        [IO.File]::WriteAllLines($list, [string[]](@($missing) + 'manifest.json'))
        Say "the updater's files: $($missing.Count) of $($blobs.Count) are new to the host"
        if (-not $DryRun) {
            if (Test-Path -LiteralPath $tar) { [IO.File]::Delete($tar) }
            & "$env:SystemRoot\System32\tar.exe" -cf $tar -C $files -T $list
            if ($LASTEXITCODE) { Fail 'could not make updater-files.tar' }
            $send.Add([pscustomobject]@{ Path = $tar; Name = 'updater-files.tar'; Sha = (Sha $tar); Size = (Get-Item -LiteralPath $tar).Length })
        }
    } else { Write-Host "  same on the host: the updater's files ($($blobs.Count))" }
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
foreach ($s in $send) {
    Write-Host "  scp $($s.Name)"
    & scp @ssh $s.Path "${sshHost}:$inbox/$($s.Name)"
    if ($LASTEXITCODE) { Fail "scp of $($s.Name) failed" }
}
Say 'the host checks and installs it'
& ssh @ssh $sshHost "powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\receive-deploy.ps1 -Incoming C:\setup\incoming\$stamp"
$rc = $LASTEXITCODE
if ($tar -and (Test-Path -LiteralPath $tar)) { [IO.File]::Delete($tar) }
if ($rc -eq 0) { Say 'deployed' } else { Write-Host "[FAIL] the host's receive-deploy.ps1 said no (above); its log: C:\havoc9\logs\deploy-*.log" -ForegroundColor Red }
exit $rc

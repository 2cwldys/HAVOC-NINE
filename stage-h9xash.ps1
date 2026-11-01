<#
.SYNOPSIS
  Packs H9XASH into a clean client ZIP for players to extract and play.

.DESCRIPTION
  Copies H9XASH into a temporary folder, leaving out everything that belongs to one
  player or one server rather than to the game:
    - ids: user_id.ini, device_id.ini, userid_resolved.cfg and every other *_resolved.cfg
      h9xash.bat writes on each launch;
    - secrets: ts_advertise.cfg (the Discord bot token), h9_presence.cfg and any *.key or
      *.env (a server's h9web key), ban lists (listip.cfg, banned.cfg);
    - a player's own files: config.cfg (any folder), video.cfg, opengl.cfg, the console
      history, the server history and favorites, saves, screenshots, demos, downloads,
      the font cache, the spray cache, AMXX stats and vaults, RCBot's player-name list;
    - logs, process ids, backups (*.bak*), temporary and junk files.
  A new player then starts from the stock files a fresh install would have:
    - ts\config.cfg from TS 3.0 (reTS\game\ts or ts3.0\ts beside H9XASH);
    - networking.ini from the overlay template (xash3d-h9-patches\overlay);
    - tempdecal.wad from TS 3.0, when there is one.
  Every config-like file left (.cfg .ini .lst .rc .json) is then scrubbed line by line:
  a line is removed when it sets a password, key, token, secret or player id, holds a
  SteamID, or holds a public IP address. The removed values are never printed.
  Last, the whole staged tree is scanned again. A Discord token, a webhook URL or a
  private key anywhere in it stops the run before a ZIP is written.
  H9XASH itself is only read, never changed.

.PARAMETER Source
  The H9XASH folder to pack. Default: H9XASH beside this script.

.PARAMETER OutDir
  Where the ZIP and its report go. Default: dist beside this script (git ignores it).

.PARAMETER Name
  The ZIP's file name without .zip. Default: H9XASH-<build>-<yyyyMMdd-HHmm>, the build
  read from VERSION.txt beside H9XASH.

.PARAMETER AllowIp
  Public IP addresses that may stay in config files (a master server, say).

.PARAMETER DryRun
  Stage and scrub, write the report, keep the staged folder, but make no ZIP.

.PARAMETER KeepStage
  Keep the staged folder after zipping, to test-play it first.

.PARAMETER Compression
  Optimal (default) or Fastest.

.EXAMPLE
  .\stage-h9xash.ps1
  .\stage-h9xash.ps1 -DryRun
  .\stage-h9xash.ps1 -Source D:\Downloads\TSM\H9XASH -KeepStage
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string]$OutDir,
    [string]$Name,
    [string[]]$AllowIp = @(),
    [switch]$DryRun,
    [switch]$KeepStage,
    [ValidateSet('Optimal', 'Fastest')][string]$Compression = 'Optimal'
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param defaults, so the defaults are set here.
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path $Here 'H9XASH' }
if (-not $OutDir) { $OutDir = Join-Path $Here 'dist' }

# ---- rules ----------------------------------------------------------------------------

# Folders left out wherever they are.
$SkipDirNames = @('logs', 'save', 'screenshots', 'scrshots', 'ts_downloads', 'downloads',
    '.fontcache', 'userconfig.d', '__pycache__', '.venv', 'venv', '.git', 'node_modules')
# Folders left out at this path under H9XASH. Each is made again, empty, when $RecreateDirs lists it.
$SkipDirPaths = @('presets\backup', 'ts\addons\amxmodx\data\vault')
$RecreateDirs = @('ts\addons\amxmodx\data\vault', 'ts\addons\amxmodx\logs')

# Files left out wherever they are (lower case).
$SkipNames = @(
    'console_history.txt', 'history_servers.lst', 'favorite_servers.lst', 'xashcomm.lst',
    'user_id.ini', 'device_id.ini', '.xash_id',
    'config.cfg', 'video.cfg', 'opengl.cfg', 'custom.hpk', 'voice_ban.dt', 'tempdecal.wad',
    'tsstats.dat', 'vault.ini', 'bot_playerids.ini',
    'ts_advertise.cfg', 'ts_advertise_local.cfg', 'h9_presence.cfg',
    'listip.cfg', 'banned.cfg', 'mail.env', 'accounts.json', 'networking.ini',
    'thumbs.db', 'desktop.ini', '.ds_store')
$SkipExt = @('.log', '.pid', '.tmp', '.new', '.orig', '.rej', '.dmp', '.mdmp', '.dem', '.env', '.key', '.sav')
# File names matched by pattern: backups, files h9xash.bat writes per launch, stray build output.
$SkipPatterns = @('\.bak($|[._-])', '_resolved\.cfg$', '^user_id\.ini', '^device_id\.ini',
    '^h9_presence.*\.(key|cfg\.bak.*)$', 'downloadstsm')

# Files a new player gets from a stock source instead. Relative to H9XASH, then the candidates
# relative to the folder H9XASH sits in.
$Replacements = @(
    @{ At = 'ts\config.cfg'; From = @('reTS\game\ts\config.cfg', 'ts3.0\ts\config.cfg'); Fallback = 'scrub' },
    @{ At = 'networking.ini'; From = @('xash3d-h9-patches\overlay\networking.ini'); Fallback = 'scrub' },
    @{ At = 'ts\tempdecal.wad'; From = @('reTS\game\ts\tempdecal.wad', 'ts3.0\ts\tempdecal.wad'); Fallback = 'drop' }
)

# Files that must reach the ZIP whenever H9XASH has them.
$Essentials = @('HAVOC 9.exe', 'xash.dll', 'menu.dll', 'ref_gl.dll', 'SDL2.dll', 'filesystem_stdio.dll',
    'h9xash.bat', 'h9_userid.ps1', 'h9_networking.ps1', 'enter_userid.cmd',
    'ts\liblist.gam', 'ts\gameinfo.txt', 'ts\delta.lst', 'ts\dlls\mp.dll', 'ts\cl_dlls\client.dll',
    'ts\autoexec.cfg', 'ts\userconfig.cfg', 'ts\addons\metamod\plugins.ini',
    'ts\addons\amxmodx\configs\plugins.ini', 'ts\addons\amxmodx\configs\amxx.cfg')

# Config-like files are scrubbed line by line; every text file is scanned for hard secrets.
$ConfigExt = @('.cfg', '.ini', '.lst', '.rc', '.json')
$TextExt = @('.cfg', '.ini', '.lst', '.rc', '.json', '.txt', '.md', '.htm', '.html', '.xml', '.yml', '.yaml',
    '.csv', '.bat', '.cmd', '.ps1', '.py', '.sma', '.inc', '.gam', '.example', '.pem', '.url', '.js', '.res')

# Settings whose value is a secret or a player id.
$SecretKeyExact = '^(cl_h9_userid|h9_clientid|h9_userid|h9_deviceid|device_id|_pw|password|rcon_password|sv_password|h9_presence_key|tsm_ad_token)$'
$SecretKeyPart = '(token|secret|webhook|apikey|api_key|passwd|private_key|(^|_)pass$)'
$RxCfgSetting = [regex]'^\s*(?:setinfo\s+)?"?(?<k>[A-Za-z0-9_.\-]+)"?\s+"(?<v>[^"]*)"'
$RxIniSetting = [regex]'^\s*(?<k>[A-Za-z0-9_.\-]+)\s*=\s*(?<v>.*?)\s*$'
$RxSteamId = [regex]'STEAM_\d:\d:\d+|VALVE_\d:\d:\d+|\[U:1:\d+\]|\b7656119\d{10}\b'
$RxIpv4 = [regex]'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])'
# Hard stops: a Discord bot token, a Discord webhook, a private key.
$RxHard = @(
    @{ Why = 'Discord bot token'; Rx = [regex]'[MNO][A-Za-z\d_\-]{23,27}\.[A-Za-z\d_\-]{6}\.[A-Za-z\d_\-]{27,40}' },
    @{ Why = 'Discord webhook URL'; Rx = [regex]'discord(?:app)?\.com/api/webhooks/\d+/[\w\-]+' },
    @{ Why = 'private key'; Rx = [regex]'-----BEGIN [A-Z ]*PRIVATE KEY-----' }
)
# Documentation's own example address, safe to keep.
$ExampleIps = @('123.45.67.89')

# ---- helpers ---------------------------------------------------------------------------

$Latin1 = [Text.Encoding]::GetEncoding(28591)
$Report = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Host $text; $Report.Add($text) }
function Warn([string]$text) { Write-Host "  [WARN] $text" -ForegroundColor Yellow; $Warnings.Add($text) }

function Test-PublicIp([string]$ip) {
    $p = @($ip.Split('.') | ForEach-Object { [int]$_ })
    if (@($p | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
    if ($AllowIp -contains $ip -or $ExampleIps -contains $ip) { return $false }
    if ($p[0] -eq 0 -or $p[0] -eq 10 -or $p[0] -eq 127 -or $p[0] -ge 224) { return $false }
    if ($p[0] -eq 169 -and $p[1] -eq 254) { return $false }
    if ($p[0] -eq 172 -and $p[1] -ge 16 -and $p[1] -le 31) { return $false }
    if ($p[0] -eq 192 -and $p[1] -eq 168) { return $false }
    if ($p[0] -eq 100 -and $p[1] -ge 64 -and $p[1] -le 127) { return $false }
    # TEST-NET-1/2/3, reserved for documentation
    if (($p[0] -eq 192 -and $p[1] -eq 0 -and $p[2] -eq 2) -or ($p[0] -eq 198 -and $p[1] -eq 51 -and $p[2] -eq 100) -or
        ($p[0] -eq 203 -and $p[1] -eq 0 -and $p[2] -eq 113)) { return $false }
    return $true
}

function Get-SkipReason([string]$rel, [bool]$isDir) {
    $low = $rel.ToLowerInvariant()
    $parts = $low.Split('\')
    foreach ($d in $SkipDirPaths) { if ($low -eq $d -or $low.StartsWith($d + '\')) { return "folder $d" } }
    $dirParts = if ($isDir) { $parts } elseif ($parts.Count -gt 1) { $parts[0..($parts.Count - 2)] } else { @() }
    foreach ($part in $dirParts) { if ($SkipDirNames -contains $part) { return "folder $part" } }
    if ($isDir) { return $null }
    $leaf = $parts[-1]
    if ($SkipNames -contains $leaf) { return 'a player''s, a server''s or a secret file' }
    $ext = [IO.Path]::GetExtension($leaf)
    if ($SkipExt -contains $ext) { return "$ext file" }
    foreach ($rx in $SkipPatterns) { if ($leaf -match $rx) { return "matches $rx" } }
    return $null
}

function Read-Text([string]$path) { return $Latin1.GetString([IO.File]::ReadAllBytes($path)) }
function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllBytes($path, $Latin1.GetBytes($text)) }

# Removes the lines of one config-like file that hold a secret, an id, a SteamID or a public IP.
# Returns how many lines went. The report names the setting or the kind, never the value.
function Invoke-Scrub([string]$path, [string]$rel, [switch]$ResetName) {
    $text = Read-Text $path
    $lines = [regex]::Split($text, '(?<=\n)')
    $isIni = [IO.Path]::GetExtension($path).ToLowerInvariant() -ne '.cfg'
    $kept = New-Object System.Text.StringBuilder
    $removed = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line.Length -eq 0) { continue }
        $why = $null
        $m = if ($isIni) { $RxIniSetting.Match($line) } else { $RxCfgSetting.Match($line) }
        if (-not $m.Success -and $isIni) { $m = $RxCfgSetting.Match($line) }
        if ($m.Success) {
            $k = $m.Groups['k'].Value.ToLowerInvariant()
            $v = $m.Groups['v'].Value.Trim().Trim('"')
            if ($v -ne '' -and $v -ne '0' -and ($k -match $SecretKeyExact -or $k -match $SecretKeyPart)) {
                $why = "setting $k (value of $($v.Length) characters)"
            }
        }
        if (-not $why -and $RxSteamId.IsMatch($line)) { $why = 'a SteamID' }
        # a version or build number such as 1.0.0.1 reads like an address; such lines are not IPs
        if (-not $why -and $line -notmatch '(?i)version|\bbuild\b|\bver\b') {
            foreach ($ipm in $RxIpv4.Matches($line)) {
                if (Test-PublicIp $ipm.Value) { $why = 'a public IP address'; break }
            }
        }
        if ($why) {
            $removed++
            $Report.Add("    $rel line $($i + 1): removed, $why")
            continue
        }
        if ($ResetName -and $line -match '^\s*name\s+"') {
            $nl = if ($line.EndsWith("`r`n")) { "`r`n" } elseif ($line.EndsWith("`n")) { "`n" } else { '' }
            $line = 'name "Player"' + $nl
            $Report.Add("    $rel line $($i + 1): player name reset to Player")
        }
        [void]$kept.Append($line)
    }
    $new = $kept.ToString()
    if ($new -ne $text) { Write-Text $path $new }
    return $removed
}

# ---- checks before anything is copied --------------------------------------------------

$Source = [IO.Path]::GetFullPath($Source).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $Source 'ts') -PathType Container)) {
    throw "No H9XASH at $Source (no ts folder in it). Give the folder with -Source."
}
$Root = Split-Path $Source -Parent
$OutDir = [IO.Path]::GetFullPath($OutDir)

$build = 'local'
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path -LiteralPath $versionFile) {
    $vm = Select-String -LiteralPath $versionFile -Pattern '^\s*Build:\s*(\S+)' | Select-Object -First 1
    if ($vm) { $build = $vm.Matches[0].Groups[1].Value }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
if (-not $Name) { $Name = "H9XASH-$build-$stamp" }
$zipPath = Join-Path $OutDir "$Name.zip"
$reportPath = Join-Path $OutDir "$Name.report.txt"

Say "stage-h9xash: $Source"
Say "  build $build, $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# The game may be running from this folder. It is never stopped here; the files it writes
# (config.cfg, logs, histories) are left out anyway.
try {
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($Source, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($running) { Warn "the game is running from this folder ($(($running | Select-Object -ExpandProperty ProcessName -Unique) -join ', ')); files it is writing are left out anyway" }
} catch { }

$stageBase = Join-Path ([IO.Path]::GetTempPath()) "h9xash-stage-$stamp-$PID"
$stage = Join-Path $stageBase 'H9XASH'

$all = Get-ChildItem -LiteralPath $Source -Recurse -Force -File -ErrorAction Stop
$sourceBytes = ($all | Measure-Object -Property Length -Sum).Sum
$tempDrive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($stageBase).Substring(0, 1)) -ErrorAction SilentlyContinue
if ($tempDrive -and $tempDrive.Free -lt ($sourceBytes * 1.1)) {
    throw ("Not enough free space for the stage on {0}: about {1:N0} MB needed, {2:N0} MB free." -f $tempDrive.Name, ($sourceBytes / 1MB * 1.1), ($tempDrive.Free / 1MB))
}

# ---- copy what goes in -----------------------------------------------------------------

Say ''
Say "1. copying into $stage"
$skipped = New-Object System.Collections.Generic.List[string]
$copied = 0
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($dir in (Get-ChildItem -LiteralPath $Source -Recurse -Force -Directory)) {
    $rel = $dir.FullName.Substring($Source.Length + 1)
    if (-not (Get-SkipReason $rel $true)) { New-Item -ItemType Directory -Path (Join-Path $stage $rel) -Force | Out-Null }
}
foreach ($f in $all) {
    $rel = $f.FullName.Substring($Source.Length + 1)
    $why = Get-SkipReason $rel $false
    if ($why) { $skipped.Add("    $rel  ($why)"); continue }
    $dest = Join-Path $stage $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    [IO.File]::Copy($f.FullName, $dest, $true)
    $copied++
}
foreach ($d in $RecreateDirs) {
    if (Test-Path -LiteralPath (Join-Path $Source $d)) { New-Item -ItemType Directory -Path (Join-Path $stage $d) -Force | Out-Null }
}
Say "  $copied files copied, $($skipped.Count) left out:"
foreach ($s in $skipped) { $Report.Add($s) }
Write-Host "  (the list is in the report)"

# ---- stock files for a new player ------------------------------------------------------

Say ''
Say '2. stock files a new player starts from'
foreach ($r in $Replacements) {
    $dest = Join-Path $stage $r.At
    $from = $null
    foreach ($c in $r.From) {
        $p = Join-Path $Root $c
        if (Test-Path -LiteralPath $p -PathType Leaf) { $from = $p; break }
    }
    if ($from) {
        Copy-Item -LiteralPath $from -Destination $dest -Force
        Say "  $($r.At) <- $from"
        continue
    }
    $mine = Join-Path $Source $r.At
    if (-not (Test-Path -LiteralPath $mine -PathType Leaf)) { Say "  $($r.At): none in H9XASH and no stock copy, left out"; continue }
    if ($r.Fallback -eq 'scrub') {
        Copy-Item -LiteralPath $mine -Destination $dest -Force
        $n = Invoke-Scrub $dest $r.At -ResetName
        Warn "$($r.At): no stock copy found beside H9XASH, so this install's own was scrubbed instead ($n lines removed)"
    } else {
        Say "  $($r.At): no stock copy, left out"
    }
}

# ---- scrub what is left ----------------------------------------------------------------

Say ''
Say '3. scrubbing config files (passwords, keys, tokens, player ids, SteamIDs, public IPs)'
$scrubbedFiles = 0
$scrubbedLines = 0
$stageFiles = Get-ChildItem -LiteralPath $stage -Recurse -Force -File
foreach ($f in $stageFiles) {
    $ext = $f.Extension.ToLowerInvariant()
    if ($ConfigExt -notcontains $ext -or $f.Length -gt 4MB) { continue }
    $rel = $f.FullName.Substring($stage.Length + 1)
    $n = Invoke-Scrub $f.FullName $rel
    if ($n -gt 0) { $scrubbedFiles++; $scrubbedLines += $n }
}
Say "  $scrubbedLines lines removed from $scrubbedFiles files (listed in the report, values never shown)"

# ---- final scan ------------------------------------------------------------------------

Say ''
Say '4. final scan'
$stops = New-Object System.Collections.Generic.List[string]
$stageFiles = Get-ChildItem -LiteralPath $stage -Recurse -Force -File
foreach ($f in $stageFiles) {
    $rel = $f.FullName.Substring($stage.Length + 1)
    $isReplacement = $false
    foreach ($r in $Replacements) { if ($rel -ieq $r.At) { $isReplacement = $true } }
    if (-not $isReplacement) {
        $why = Get-SkipReason $rel $false
        if ($why) { $stops.Add("$rel is still in the stage ($why)") }
    }
    $ext = $f.Extension.ToLowerInvariant()
    if ($TextExt -notcontains $ext -or $f.Length -gt 8MB) { continue }
    $text = Read-Text $f.FullName
    foreach ($h in $RxHard) { if ($h.Rx.IsMatch($text)) { $stops.Add("$rel holds a $($h.Why)") } }
    if ($ConfigExt -notcontains $ext) {
        # documents and scripts are reported, not edited
        if ($RxSteamId.IsMatch($text)) { Warn "$rel mentions a SteamID (documentation or script, left as is)" }
        $pub = @($RxIpv4.Matches($text) | ForEach-Object { $_.Value } | Where-Object { Test-PublicIp $_ } | Select-Object -Unique)
        if ($pub.Count -gt 0) { Warn "$rel mentions $($pub.Count) public IP address(es) (documentation or script, left as is)" }
    }
}
foreach ($e in $Essentials) {
    if ((Test-Path -LiteralPath (Join-Path $Source $e)) -and -not (Test-Path -LiteralPath (Join-Path $stage $e))) {
        $stops.Add("$e is in H9XASH but missing from the stage")
    }
}

function Write-Report {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $lines = @($Report) + @('', 'Warnings:') + @(if ($Warnings.Count) { $Warnings | ForEach-Object { "  $_" } } else { '  none' })
    [IO.File]::WriteAllLines($reportPath, [string[]]$lines, $Latin1)
}

if ($stops.Count -gt 0) {
    Say '  STOPPED, nothing was zipped:'
    foreach ($s in $stops) { Say "    $s" }
    Write-Report
    Say "  stage kept for a look: $stage"
    Say "  report: $reportPath"
    exit 1
}
Say "  clean: no tokens, webhooks or private keys; nothing left out came back; essentials present"

# ---- zip -------------------------------------------------------------------------------

if ($DryRun) {
    Write-Report
    Say ''
    Say "Dry run: no ZIP. Stage kept: $stage"
    Say "Report: $reportPath"
    exit 0
}

Say ''
Say "5. zipping to $zipPath"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$level = [IO.Compression.CompressionLevel]::$Compression
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, $level, $true)
$zipInfo = Get-Item -LiteralPath $zipPath
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Say ("  {0:N0} MB, SHA-256 {1}" -f ($zipInfo.Length / 1MB), $hash)

if ($KeepStage) { Say "  stage kept: $stage" }
else { Remove-Item -LiteralPath $stageBase -Recurse -Force }

Write-Report
Say "Report: $reportPath"
if ($Warnings.Count) { Write-Host "$($Warnings.Count) warning(s); see the report." -ForegroundColor Yellow }
exit 0

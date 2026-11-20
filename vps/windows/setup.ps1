<#
.SYNOPSIS
  havoc9.org on a Windows host: h9web, the site, the H9 server list, HTTPS through Caddy, the
  firewall and the backups. README-WINDOWS.txt beside it is the guide.

.DESCRIPTION
  Run it in an administrator PowerShell from the unpacked package (or from vps\windows in a
  clone of the repository). It is safe to run again, and running it again is how a new package
  goes in: it brings the code, the site, the tools and the services up to date, takes a backup
  before it touches a running h9web, and never overwrites a setting, a key or any data.

    .\setup.ps1                            install or update everything, and start it
    .\setup.ps1 -WhatIf                    show every step, change nothing (a dry run)
    .\setup.ps1 -Check                     only show what is installed and running
    .\setup.ps1 -Restore <file.h9backup> [-Keys <folder>] [-PassphraseFile <file>]
                                           the same, with that backup restored before h9web
                                           starts; <folder> holds secrets.json and data.key
                                           unless the backup holds them
    .\setup.ps1 -WebClientStage <folder>   also lay out the web client from webclient-build\stage
    .\setup.ps1 -FileIndex                 only the downloads' file index: after new files go into
                                           site\downloads, its links, their check and its
                                           SHA256SUMS.txt (README-WINDOWS.txt step 13)
    .\setup.ps1 -P2P module                the P2P relay's code for h9web's p2p module, and its UDP port
                                           in the firewall (docs\P2P_HOSTING.txt, README-WINDOWS.txt step 16)
    .\setup.ps1 -P2P standalone            the relay as a service of its own (havoc9-p2p), its settings in
                                           etc\p2p, and the same firewall rule; -P2PPort 27248 is the UDP port
                                           (the one in its settings). Without -P2P nothing of it is touched.
    .\setup.ps1 -WebFrom cloudflare        TCP 80 and 443 from Cloudflare's addresses only, so the site cannot be
                                           reached around Cloudflare (-WebFrom any undoes it); remembered for
                                           later runs. Only once the padlock shows and the orange cloud is on.

  The stack, and why: Node.js 24 runs h9web as it does on Linux; Caddy is the web server
  because it makes and renews the Let's Encrypt certificate by itself (one program, no
  scheduled renewals to keep working); WinSW (MIT) runs h9web, the list and Caddy as real
  Windows services, started at boot, restarted when they stop, as LocalService (no password
  stored, no administrator rights at run time), with their logs in logs\; Python runs the list.
  Each download is a pinned version, checked against its SHA-256 or SHA-512 before use. The
  backups are scheduled tasks, run as LocalService whether or not anyone is signed in.

  Everything lives under -Root (C:\havoc9):
    tools\     node, python, caddy, winsw           h9web\      h9web's code
    serverlist\ the list's code and its Python      site\       the site
    p2p\       the P2P relay's code (only with -P2P)
    game\      the web client's game files          etc\        config.json, servers.json,
    data\h9web  h9web's data and backups                         Caddyfile, backup-passphrase
    data\serverlist  the list's settings and secrets   data\caddy  the certificates
    services\  the service wrappers                 logs\       the services' logs (30 days)
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Root = 'C:\havoc9',
    [string]$Domain = 'havoc9.org',
    [string]$GameHost = '',
    [string]$Email = '',
    [string[]]$GamePorts = @('27015/udp'),
    [string]$H9Xash = '',
    [string]$Restore = '',
    [string]$Keys = '',
    [string]$PassphraseFile = '',
    [string]$WebClientStage = '',
    [ValidateSet('', 'module', 'standalone')][string]$P2P = '',
    [ValidateRange(1, 65535)][int]$P2PPort = 27248,
    [ValidateSet('', 'cloudflare', 'any')][string]$WebFrom = '',
    [switch]$NoFirewall,
    # Skip step 13. receive-deploy.ps1 passes this because it writes the fingerprint itself, once
    # everything else is in place. Writing it here as well hashed the whole tree TWICE per
    # delivery -- about an hour of a deploy on this host -- and this earlier pass was stale the
    # moment receive-deploy carried on working after setup returned. A standalone setup.ps1 still
    # writes it, which is the case the step exists for.
    [switch]$NoFingerprint,
    # Skip the downloads' file index in step 5. receive-deploy.ps1 passes this: it runs setup.ps1
    # -FileIndex itself once the delivery's downloads are in place, and the index reads every
    # published download in full (several GB), so one made here, before those downloads, would be
    # made again minutes later. A standalone setup.ps1 makes it.
    [switch]$NoFileIndex,
    [switch]$Check,
    [switch]$FileIndex
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# -GamePorts 27015/udp,27016/udp arrives as one string from powershell -File: split it
$GamePorts = @($GamePorts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+/(udp|tcp)$' })
# without -GamePorts: the port the networking.ini of the H9XASH folder -H9Xash names (port= under
# [server], the one its launchers use), 1 to 65535, else 27015
if (-not $PSBoundParameters.ContainsKey('GamePorts') -and $H9Xash -and (Test-Path -LiteralPath (Join-Path $H9Xash 'networking.ini'))) {
    $section = ''
    $port = 27015
    foreach ($raw in [IO.File]::ReadAllLines((Join-Path $H9Xash 'networking.ini'))) {
        $line = $raw.Trim()
        if ($line -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
        if ($section -eq 'server' -and $line -match '^port\s*=\s*([1-9][0-9]{0,4})\s*$' -and [int]$Matches[1] -le 65535) { $port = [int]$Matches[1] }
    }
    $GamePorts = @("$port/udp")
}
# the name game servers use (h9_presence_url, heartbeats): a DNS-only record with an IPv4 address only, game.<domain>
if (-not $GameHost) { $GameHost = "game.$Domain" }
$Here = $PSScriptRoot
$Src = $Here
if (-not (Test-Path -LiteralPath (Join-Path $Src 'h9web\server.js'))) { $Src = [IO.Path]::GetFullPath((Join-Path $Here '..\..')) }

# the downloads: pinned versions and the publishers' checksums (Node.js SHASUMS256.txt, Caddy's
# checksums file; WinSW publishes none, so its SHA-256 is of the release's file; Python's
# installer is also signed by the Python Software Foundation)
$Pins = @(
    @{ Name = 'node'; Version = '24.15.0'; Url = 'https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip'; Algo = 'SHA256'
       Hash = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62' },
    @{ Name = 'caddy'; Version = '2.11.7'; Url = 'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip'; Algo = 'SHA512'
       Hash = 'c308154504e53755958ffc62d8a2657ab17eefd6dd25c45dbb2c3d93d29519971f77ca652f7d0f2bcb7f980b9ba3822478865e29969d0272d7613550a43152b1' },
    @{ Name = 'winsw'; Version = '2.12.0'; Url = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'; Algo = 'SHA256'
       Hash = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da' },
    @{ Name = 'python'; Version = '3.14.10'; Url = 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-amd64.exe'; Algo = 'SHA256'
       Hash = '92480239264744fe0386a1bd8275786fefa126e3129e56a68e22b52c73329965' }
)

$Tools = Join-Path $Root 'tools'
$Node = Join-Path $Tools 'node\node.exe'
$Python = Join-Path $Tools 'python\python.exe'
$Caddy = Join-Path $Tools 'caddy\caddy.exe'
$WinSW = Join-Path $Tools 'winsw\WinSW-x64.exe'
$H9web = Join-Path $Root 'h9web'
$ListHome = Join-Path $Root 'serverlist'
$Site = Join-Path $Root 'site'
$Game = Join-Path $Root 'game'
$Etc = Join-Path $Root 'etc'
$Data = Join-Path $Root 'data'
$H9Data = Join-Path $Data 'h9web'
$ListData = Join-Path $Data 'serverlist'
$Services = Join-Path $Root 'services'
$P2PHome = Join-Path $Root 'p2p'
$P2PEtc = Join-Path $Etc 'p2p'
$Logs = Join-Path $Root 'logs'
$Downloads = Join-Path $Root 'downloads'
$Config = Join-Path $Etc 'config.json'
$Passphrase = Join-Path $Etc 'backup-passphrase'
$CfFile = Join-Path $Etc 'cloudflare-ranges.txt'
$WebFromFile = Join-Path $Etc 'web-from.txt'
$Fwd = $Root -replace '\\', '/'
$Warnings = New-Object System.Collections.Generic.List[string]
$DryRun = [bool]$WhatIfPreference

function Say([string]$Text) { Write-Host ''; Write-Host "== $Text" }
function Note([string]$Text) { Write-Host "  $Text" }
function Warn([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow; $Warnings.Add($Text) }
function Fail([string]$Text) { Write-Host "[FAIL] $Text" -ForegroundColor Red; exit 1 }

# Every change goes through here: with -WhatIf it is only shown.
function Step([string]$What, [scriptblock]$Do)
{
    if ($PSCmdlet.ShouldProcess($What, 'setup')) { & $Do }
}

function Invoke-Native([string]$Exe, [string[]]$Arguments)
{
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe exited with $LASTEXITCODE" }
}

function Get-ServiceState([string]$Name)
{
    $s = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($s) { return [string]$s.Status } else { return 'not installed' }
}

function Test-Http([string]$Url)
{
    try { return [string](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5).StatusCode } catch { return 'no answer' }
}

# The downloads' file index, site\downloads\files (README-WINDOWS.txt step 13). The DOWNLOADS
# page's three files (and the native Linux server, kept in site\downloads too but on no button) are
# symbolic links there, so the disk holds one copy and a link always opens the file downloads\
# holds now, whatever replaced it. With the build in site\downloads\.build (receive-deploy.ps1
# writes it, a dot file nobody is served) each link carries it in its name, H9XASH-1.61.zip, and
# the link of another build goes; without one the link has the file's own name. Each link is made
# again when it is missing or points elsewhere, then checked: its SHA-256 must be that of the file
# in downloads\. A file not there yet is skipped (an old link to it goes). Last, SHA256SUMS.txt
# lists the SHA-256 of every file the index serves. The index is public: a host package (havoc9-vps-*, the site's own installer and code) is never
# in it, and any file of that name that someone put there is removed.
$ButtonFiles = @('H9XASH.zip', 'H9XASH-linux.zip', 'H9XASH-Updater.exe', 'H9XASH-linux-server.zip')
function Sync-Downloads
{
    $dl = Join-Path $Site 'downloads'
    $idx = Join-Path $dl 'files'
    if (-not (Test-Path -LiteralPath $idx)) { Step "make $idx" { New-Item -ItemType Directory -Force -Path $idx | Out-Null } }
    $build = ''
    $bf = Join-Path $dl '.build'
    if (Test-Path -LiteralPath $bf) { $b = ([IO.File]::ReadAllText($bf)).Trim(); if ($b -match '^[0-9][A-Za-z0-9._-]{0,31}$') { $build = $b } }
    $sums = @{}
    # the index is public: a host package (the site's installer and code) is never in it, whoever put it there
    foreach ($p in @(Get-ChildItem -LiteralPath $idx -File -Force | Where-Object { $_.Name -like 'havoc9-vps-*' })) {
        Step "remove $($p.FullName) (a host package is never in the public file index)" { Remove-Item -LiteralPath $p.FullName -Force }
    }
    foreach ($src0 in $ButtonFiles) {
        $base = [IO.Path]::GetFileNameWithoutExtension($src0)
        $ext = [IO.Path]::GetExtension($src0)
        $f = if ($build) { "$base-$build$ext" } else { $src0 }
        $src = Join-Path $dl $src0
        $link = Join-Path $idx $f
        # this file's links under another name (another build, or none) go
        $mine = '^' + [regex]::Escape($base) + '(-[0-9][A-Za-z0-9._-]*)?' + [regex]::Escape($ext) + '$'
        foreach ($old in @(Get-ChildItem -LiteralPath $idx -Force | Where-Object { $_.LinkType -eq 'SymbolicLink' -and $_.Name -match $mine -and $_.Name -ne $f })) {
            Step "remove $($old.FullName) (not this build's name)" { Remove-Item -LiteralPath $old.FullName -Force }
        }
        $have = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
            if ($have -and $have.LinkType -eq 'SymbolicLink') { Step "remove $link (no $src)" { Remove-Item -LiteralPath $link -Force } }
            Note "downloads\files\${f}: skipped, there is no $src yet"
            continue
        }
        if (-not ($have -and $have.LinkType -eq 'SymbolicLink' -and [string]@($have.Target)[0] -eq $src)) {
            # made under a dot name (never listed or served) and put in place only once it exists
            $made = @{ ok = $true }
            Step "link $link to $src" {
                $tmp = Join-Path $idx ".$f.new"
                try {
                    $old = Get-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                    if ($old) { $old.Delete() }
                    New-Item -ItemType SymbolicLink -Path $tmp -Target $src -ErrorAction Stop | Out-Null
                    if ($have) { Remove-Item -LiteralPath $link -Force -ErrorAction Stop }
                    Rename-Item -LiteralPath $tmp -NewName $f -ErrorAction Stop
                } catch {
                    $made.ok = $false
                    Warn "could not link downloads\files\$f to ${src}: $($_.Exception.Message)"
                }
            }
        }
        if ($DryRun -or -not (Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue)) { continue }
        $a = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
        $b = (Get-FileHash -LiteralPath $link -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($a -eq $b) {
            Note "downloads\files\$f is downloads\$src0 (SHA-256 $a)"
            $sums[$f] = $a
        } else {
            Warn "downloads\files\$f IS NOT THE SAME FILE as downloads\$src0 (SHA-256 $b, not $a): look at $idx"
        }
    }
    if ($DryRun) { return }
    $names = [string[]]@(Get-ChildItem -LiteralPath $idx -File -Force | Where-Object { $_.Name -match '\.(zip|exe|txt)$' -and $_.Name -ne 'SHA256SUMS.txt' -and -not $_.Name.StartsWith('.') } | ForEach-Object { $_.Name })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $lines = @(foreach ($n in $names) {
        $h = $sums[$n]
        if (-not $h) { $h = (Get-FileHash -LiteralPath (Join-Path $idx $n) -Algorithm SHA256).Hash.ToLowerInvariant() }
        "$h  $n"
    })
    $text = if ($lines.Count) { ($lines -join "`n") + "`n" } else { '' }
    Step "write $idx\SHA256SUMS.txt" { [IO.File]::WriteAllText((Join-Path $idx 'SHA256SUMS.txt'), $text, (New-Object Text.UTF8Encoding $false)) }
    Note "downloads\files\SHA256SUMS.txt: $($lines.Count) files"
}

$ServiceNames = @('havoc9-h9web', 'havoc9-serverlist', 'havoc9-caddy')
if ($P2P -eq 'standalone' -or (Get-Service -Name 'havoc9-p2p' -ErrorAction SilentlyContinue)) { $ServiceNames += 'havoc9-p2p' }

if ($Check)
{
    Say 'what is here'
    foreach ($n in $ServiceNames) { Note ('{0,-20} {1}' -f $n, (Get-ServiceState $n)) }
    if (Test-Path -LiteralPath $Node) { Note ('node                 ' + (& $Node --version)) } else { Note 'node                 not installed' }
    Note ('h9web                HTTP ' + (Test-Http 'http://127.0.0.1:8090/api/me') + ' (127.0.0.1:8090)')
    Note ('list                 HTTP ' + (Test-Http 'http://127.0.0.1:8081/v1/servers/ts') + ' (127.0.0.1:8081)')
    Note ('site                 HTTP ' + (Test-Http "https://$Domain/") + " (https://$Domain/)")
    if (Test-Path -LiteralPath $P2PHome) { Note ('p2p                  HTTP ' + (Test-Http 'http://127.0.0.1:8090/api/p2p/v1/health') + " from h9web's module (200 = on, 404 = off), code in $P2PHome") }
    foreach ($t in @('havoc9 h9web backup', 'havoc9 h9web backup offsite', 'havoc9 log cleanup')) {
        $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($task) { $i = $task | Get-ScheduledTaskInfo; Note ('{0,-28} last run {1}, result {2}' -f $t, $i.LastRunTime, $i.LastTaskResult) } else { Note "$t  not installed" }
    }
    foreach ($k in @('secrets.json', 'data.key')) { if (Test-Path -LiteralPath (Join-Path $H9Data $k)) { Note "$k is in $H9Data" } }
    $wf = 'any'; if (Test-Path -LiteralPath $WebFromFile) { $wf = ([IO.File]::ReadAllText($WebFromFile)).Trim() }
    Note "TCP 80 and 443 from  $wf (-WebFrom)"
    exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $DryRun) { Fail 'run it in a PowerShell started as administrator' }

# -FileIndex: after new files went into site\downloads, only their links, the check and SHA256SUMS.txt
if ($FileIndex)
{
    Say "the downloads' file index ($Site\downloads\files)"
    if (-not (Test-Path -LiteralPath (Join-Path $Site 'downloads'))) { Fail "no $Site\downloads yet: run .\setup.ps1 first" }
    Sync-Downloads
    # -NoFingerprint: the delivery writes it once at the end. This is a SECOND place the
    # fingerprint was written from, besides step 13, so a delivery that called setup.ps1 three
    # times (full, -WebClientStage, -FileIndex) and then wrote it itself hashed the whole tree
    # four times over.
    $cc = Join-Path $Root 'code-check.ps1'
    if (-not $NoFingerprint -and (Test-Path -LiteralPath $cc)) { & $cc -Root $Root -Write }
    foreach ($w in $Warnings) { Write-Host "  [WARN] $w" -ForegroundColor Yellow }
    exit 0
}

foreach ($need in @('h9web\server.js', 'h9web\bin\h9web-backup.js', 'h9web\config.example.json', 'havoc9.org\index.html', 'serverlist-bot\h9_serverlist.py')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Src $need))) { Fail "$Src\$need is missing: run this from the unpacked package" }
}
if (-not (Test-Path -LiteralPath (Join-Path $Here 'Caddyfile.template'))) { Fail "$Here\Caddyfile.template is missing" }
if ($Restore -and -not (Test-Path -LiteralPath $Restore)) { Fail "-Restore: no file $Restore" }
if ($Keys -and -not (Test-Path -LiteralPath (Join-Path $Keys 'secrets.json'))) { Fail "-Keys: no secrets.json in $Keys" }
if ($PassphraseFile -and -not (Test-Path -LiteralPath $PassphraseFile)) { Fail "-PassphraseFile: no file $PassphraseFile" }
if ($DryRun) { Note 'a dry run (-WhatIf): nothing below is done, only shown' }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

Say "1. folders under $Root"
foreach ($d in @($Root, $Tools, $H9web, $ListHome, $Site, $Game, $Etc, $Data, $H9Data, $ListData, (Join-Path $Data 'caddy'), $Services, $Logs, $Downloads)) {
    if (-not (Test-Path -LiteralPath $d)) { Step "make $d" { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
}
# data and logs: SYSTEM, Administrators and LocalService (the services' account) only; etc the
# same, LocalService reading. *S-1-5-18 SYSTEM, *S-1-5-32-544 Administrators, *S-1-5-19 LocalService.
# the root and everything that is code (h9web, site, serverlist, tools, services, game, p2p): SYSTEM and Administrators change it,
# everyone else (LocalService too) only reads it, so a service that is broken into cannot rewrite its own code, the tools or
# start-all.ps1 (which runs as SYSTEM at boot). Without this the root inherits C:\'s "Authenticated Users: Modify".
Step "lock ${Root}: code only administrators may change" {
    Invoke-Native 'icacls.exe' @($Root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX', '/Q') | Out-Null
}
Step "lock $Data, $Logs and $Etc to SYSTEM, Administrators and LocalService" {
    foreach ($d in @($Data, $Logs)) { Invoke-Native 'icacls.exe' @($d, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)M', '/Q') | Out-Null }
    Invoke-Native 'icacls.exe' @($Etc, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)RX', '/Q') | Out-Null
    # what is already inside takes the folder's rules again: the same grants given to the files themselves with /T leave
    # them with no rules at all on a second run, and then no service can read its settings
    foreach ($d in @($Data, $Logs, $Etc)) {
        if (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1) { Invoke-Native 'icacls.exe' @((Join-Path $d '*'), '/reset', '/T', '/C', '/Q') | Out-Null }
    }
}

# which services are running before anything is replaced, for the line printed about each one at the end
$wasRunning = @{}
foreach ($n in $ServiceNames) { $wasRunning[$n] = ((Get-ServiceState $n) -eq 'Running') }

Say '2. the tools (pinned, checked)'
function Get-Pinned($pin)
{
    $file = Join-Path $Downloads ([IO.Path]::GetFileName($pin.Url))
    if ((Test-Path -LiteralPath $file) -and (Get-FileHash -LiteralPath $file -Algorithm $pin.Algo).Hash -ieq $pin.Hash) { return $file }
    Step "download $($pin.Url)" {
        Invoke-WebRequest -UseBasicParsing -Uri $pin.Url -OutFile $file -TimeoutSec 600
        $got = (Get-FileHash -LiteralPath $file -Algorithm $pin.Algo).Hash
        if ($got -ine $pin.Hash) { Remove-Item -LiteralPath $file -Force; throw "$($pin.Url): its $($pin.Algo) is $got, not the pinned $($pin.Hash). Nothing was installed from it." }
        Note "$([IO.Path]::GetFileName($file)): $($pin.Algo) checked"
    }
    return $file
}
$pin = @{}; foreach ($p in $Pins) { $pin[$p.Name] = $p }
# what the services run is replaced here: Node.js (h9web, the relay), Caddy, WinSW (every service's wrapper) and Python (the
# list's venv). Step 6 stops every service when any of them is replaced in this run.
$toolsReplaced = New-Object System.Collections.Generic.List[string]

$nodeNow = ''; if (Test-Path -LiteralPath $Node) { $nodeNow = (& $Node --version) }
if ($nodeNow -ne ('v' + $pin.node.Version)) {
    $toolsReplaced.Add('Node.js')
    $zip = Get-Pinned $pin.node
    Step "Node.js $($pin.node.Version) into $Tools\node (stopping havoc9-h9web, and havoc9-p2p when installed, first)" {
        $tmp = Join-Path $Downloads 'node-unpack'
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        # tools\node\node.exe is the running image of both services, and Windows does not delete a running image
        foreach ($n in @('havoc9-h9web', 'havoc9-p2p')) { if (Get-Service $n -ErrorAction SilentlyContinue) { Stop-Service $n -Force } }
        if (Test-Path -LiteralPath (Join-Path $Tools 'node')) { Remove-Item -LiteralPath (Join-Path $Tools 'node') -Recurse -Force }
        Move-Item -LiteralPath (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName -Destination (Join-Path $Tools 'node')
        Remove-Item -LiteralPath $tmp -Recurse -Force
    }
} else { Note "Node.js $nodeNow" }

$caddyNow = ''; if (Test-Path -LiteralPath $Caddy) { $caddyNow = [string](& $Caddy version) }
if ($caddyNow -notmatch ('^v' + [regex]::Escape($pin.caddy.Version) + '\b')) {
    $toolsReplaced.Add('Caddy')
    $zip = Get-Pinned $pin.caddy
    Step "Caddy $($pin.caddy.Version) into $Tools\caddy (stopping havoc9-caddy first)" {
        if (Get-Service havoc9-caddy -ErrorAction SilentlyContinue) { Stop-Service havoc9-caddy -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path (Join-Path $Tools 'caddy') | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Tools 'caddy') -Force
    }
} else { Note "Caddy $($caddyNow.Split(' ')[0])" }

if (-not ((Test-Path -LiteralPath $WinSW) -and (Get-FileHash -LiteralPath $WinSW -Algorithm SHA256).Hash -ieq $pin.winsw.Hash)) {
    $toolsReplaced.Add('WinSW')
    $exe = Get-Pinned $pin.winsw
    Step "WinSW $($pin.winsw.Version) into $Tools\winsw" {
        New-Item -ItemType Directory -Force -Path (Join-Path $Tools 'winsw') | Out-Null
        Copy-Item -LiteralPath $exe -Destination $WinSW -Force
    }
} else { Note "WinSW $($pin.winsw.Version)" }

$pyNow = ''; if (Test-Path -LiteralPath $Python) { $pyNow = [string](& $Python --version 2>&1) }
if ($pyNow -ne ('Python ' + $pin.python.Version)) {
    $toolsReplaced.Add('Python')
    $exe = Get-Pinned $pin.python
    Step "Python $($pin.python.Version) into $Tools\python (its own installer, quietly)" {
        if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid') { throw "$exe is not signed as it should be" }
        $p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList @('/quiet', 'InstallAllUsers=1', "TargetDir=$Tools\python", 'PrependPath=0', 'Include_launcher=0',
            'Include_test=0', 'Include_doc=0', 'Include_tcltk=0', 'Shortcuts=0', 'AssociateFiles=0', 'Include_pip=1')
        if ($p.ExitCode -ne 0) { throw "the Python installer exited with $($p.ExitCode)" }
    }
} else { Note $pyNow }

Say '3. a backup of h9web before the update'
if ((Test-Path -LiteralPath (Join-Path $H9Data 'h9web.db')) -and (Test-Path -LiteralPath (Join-Path $H9web 'bin\h9web-backup.js')) -and (Test-Path -LiteralPath $Config)) {
    Step 'a backup before the update' {
        & $Node (Join-Path $H9web 'bin\h9web-backup.js') --config $Config backup --out (Join-Path $H9Data 'backups') --keep 14
        if ($LASTEXITCODE -ne 0) { Warn 'the backup before the update failed (above); the update goes on' }
    }
} else { Note 'nothing to back up yet: no h9web database, backup tool or config.json' }

Say '4. Caddy (HTTPS for the domain)'
$emailLine = ''; if ($Email) { $emailLine = "email $Email" }
# Cloudflare's published ranges (https://www.cloudflare.com/ips/), fetched on every run and kept in etc\cloudflare-ranges.txt,
# whose copy is used when they cannot be fetched. Only well-formed ranges are taken: an odd answer must not become Caddy syntax.
# Caddy believes CF-Connecting-IP only from them; -WebFrom cloudflare lets ports 80 and 443 in from them only.
$cidr = '^((\d{1,3}\.){3}\d{1,3}/\d{1,2}|[0-9a-fA-F:]+/\d{1,3})$'
$CfRanges = @()
try {
    $got = @()
    foreach ($u in @('https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6')) {
        $got += @(([string](Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 30).Content) -split '\s+' | Where-Object { $_ })
    }
    $odd = @($got | Where-Object { $_ -notmatch $cidr })
    if ($odd.Count -or $got.Count -lt 4) { throw "an unexpected answer ($($got.Count) lines, $($odd.Count) of them not a range)" }
    $CfRanges = $got
    Step "write $CfFile ($($got.Count) ranges)" { [IO.File]::WriteAllText($CfFile, (($got -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false)) }
} catch {
    $why = $_.Exception.Message
    if (Test-Path -LiteralPath $CfFile) {
        $CfRanges = @([IO.File]::ReadAllLines($CfFile) | ForEach-Object { $_.Trim() } | Where-Object { $_ -match $cidr })
        Warn "Cloudflare's ranges could not be fetched ($why): the copy in $CfFile is used"
    } else {
        Warn "Cloudflare's ranges could not be fetched ($why) and there is no copy: behind Cloudflare every visitor looks like Cloudflare until setup.ps1 runs again"
    }
}
$trusted = ''; if ($CfRanges.Count) { $trusted = 'trusted_proxies static ' + ($CfRanges -join ' ') }
# who may ask for the site by its own name: Cloudflare's ranges; with none known, everyone (the site must not go dark over a failed fetch)
$cfList = '0.0.0.0/0 ::/0'; if ($CfRanges.Count) { $cfList = $CfRanges -join ' ' }
$caddyfile = (Get-Content -Raw -LiteralPath (Join-Path $Here 'Caddyfile.template')).Replace('{DOMAIN}', $Domain).Replace('{GAMEHOST}', $GameHost).Replace('{ROOT}', $Fwd).Replace('{EMAIL_LINE}', $emailLine).Replace('{TRUSTED_PROXIES}', $trusted).Replace('{CF_RANGES}', $cfList)
# etc\Caddyfile is written only when this text differs from it, and havoc9-caddy takes a new one at the end of step 10: by a reload
# while it keeps running, or by a restart of havoc9-caddy alone when the reload fails. etc\Caddyfile.pending marks a file it has yet
# to take, so a run that ends before then leaves that to the next run. Without Cloudflare's ranges the text trusts no proxy and lets
# every address ask for the site by name, so it is written only where there is no etc\Caddyfile yet (the site must come up) and
# never over one that a running Caddy may be using.
$caddyConf = Join-Path $Etc 'Caddyfile'
$caddyPending = Join-Path $Etc 'Caddyfile.pending'
$caddyHave = $null; if (Test-Path -LiteralPath $caddyConf) { $caddyHave = [IO.File]::ReadAllText($caddyConf) }
$caddyChanged = Test-Path -LiteralPath $caddyPending
if ([string]::Equals($caddyHave, $caddyfile, [StringComparison]::Ordinal)) {
    if ($caddyChanged) { Note "$caddyConf is as it should be, and havoc9-caddy has yet to take it ($caddyPending)" } else { Note "$caddyConf is as it should be" }
} elseif (-not $CfRanges.Count -and $null -ne $caddyHave) {
    Warn "$caddyConf is kept as it is: with no Cloudflare ranges known the new one would trust no proxy and take every address"
} else {
    $caddyChanged = $true
    Step "write $caddyConf" {
        [IO.File]::WriteAllText($caddyPending, "havoc9-caddy has yet to take etc\Caddyfile: setup.ps1 reloads or restarts it at the end of step 10`n")
        [IO.File]::WriteAllText($caddyConf, $caddyfile, (New-Object Text.UTF8Encoding $false))
    }
}
$caddyExtra = Join-Path $Etc 'Caddyfile.extra'
if (-not (Test-Path -LiteralPath $caddyExtra)) { Step "make $caddyExtra" { [IO.File]::WriteAllText($caddyExtra, "# Your own Caddy settings; setup.ps1 imports this file and never writes it.`n") } }
Step "check $caddyConf (caddy validate)" { Invoke-Native $Caddy @('validate', '--config', $caddyConf, '--adapter', 'caddyfile') | Out-Null }

# robocopy /MIR removes what the source no longer has one file at a time, stat-ing and logging
# each, which is slow for a large tree that has gone away entirely. So any DIRECTORY the source
# does not have is removed wholesale first, top down, and the mirror is left with only the files
# that actually changed.
function Remove-Gone([string]$From, [string]$To, [int]$Depth = 3)
{
    if (-not (Test-Path -LiteralPath $To) -or -not (Test-Path -LiteralPath $From)) { return }
    foreach ($d in @(Get-ChildItem -LiteralPath $To -Directory -Force -ErrorAction SilentlyContinue)) {
        $peer = Join-Path $From $d.Name
        if (-not (Test-Path -LiteralPath $peer)) {
            $n = @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue).Count
            Note ("dropping {0} ({1:N0} files): the source no longer carries it" -f $d.FullName, $n)
            Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        elseif ($Depth -gt 1) {
            Remove-Gone $peer $d.FullName ($Depth - 1)
        }
    }
}

# Copy-Mirror returns how many files and folders robocopy copied or removed, counted from its own list of them; with -ListOnly (/L)
# it changes nothing and counts what the same copy would copy or remove. 8 and up from robocopy is a failure and throws. The count
# comes from that list and not from robocopy's exit code, which also counts an excluded item that only the destination has (the
# list's venv, say) as an extra although the copy leaves it alone.
function Copy-Mirror([string]$From, [string]$To, [string[]]$ExcludeDirs, [string[]]$ExcludeFiles, [switch]$ListOnly)
{
    $a = @($From, $To, '/MIR', '/NJH', '/NJS', '/NDL', '/NC', '/NS', '/FP', '/NP')
    if ($ListOnly) { $a += '/L' }
    if ($ExcludeDirs) { $a += '/XD'; $a += $ExcludeDirs }
    if ($ExcludeFiles) { $a += '/XF'; $a += $ExcludeFiles }
    $listed = @(& robocopy.exe @a | Where-Object { "$_".Trim() }).Count
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
    return $listed
}
# whether a copy changed its tree, or would: anything but a count counts as changed, so what is not known (a dry run's Step runs
# nothing and returns nothing) is never taken for unchanged
function Test-TreeChanged($Count)
{
    if ($Count -isnot [int]) { return $true }
    return ($Count -ne 0)
}

Say '5. the site'
# What robocopy leaves out it also leaves alone: the downloads (the ZIPs, H9XASH-Updater.exe), the
# downloads' file index (downloads\files) and H9XASH-Updater's files\ are kept.
Step "the site into $Site" {
    $null = Copy-Mirror (Join-Path $Src 'havoc9.org') $Site @('deploy', 'engine', '.git', 'files') @('DEPLOY.txt', 'manifest.json', 'preload.json', '*.bak*', '*.zip', '*.orig', 'README.md', 'HAVOC_NINE_MASTER_SERVER.txt', '.*', 'H9XASH-Updater.exe')
}
if ($NoFileIndex) { Note "the downloads' file index: left to the delivery, which runs setup.ps1 -FileIndex once its downloads are in place" } else { Sync-Downloads }
if ($WebClientStage) {
    foreach ($f in @('manifest.json', 'preload.json', 'engine\xash.js', 'engine\xash.wasm')) { if (-not (Test-Path -LiteralPath (Join-Path $WebClientStage $f))) { Fail "-WebClientStage: no $f in $WebClientStage" } }
    Step "the web client from $WebClientStage" {
        # whole trees the stage no longer carries go in one go, not file by file
        Remove-Gone (Join-Path $WebClientStage 'game') $Game
        $null = Copy-Mirror (Join-Path $WebClientStage 'game') $Game @() @()
        $null = Copy-Mirror (Join-Path $WebClientStage 'engine') (Join-Path $Site 'webclient\engine') @() @()
        foreach ($f in @('manifest.json', 'preload.json')) { Copy-Item -LiteralPath (Join-Path $WebClientStage $f) -Destination (Join-Path $Site 'webclient') -Force }
    }
}

# the host's own scripts, beside the folders: start-all.ps1 (start and check everything), receive-deploy.ps1 (takes a
# delivery from deploy-vps.ps1) and code-check.ps1 (the fingerprint of all code). The root is administrators-only.
foreach ($f in @('start-all.ps1', 'stop-all.ps1', 'receive-deploy.ps1', 'code-check.ps1', 'restore-backup.ps1', 'update-game.ps1', 'delta.py')) {
    $from = Join-Path $Here $f
    if (Test-Path -LiteralPath $from) { Step "$f into $Root" { Copy-Item -LiteralPath $from -Destination (Join-Path $Root $f) -Force } }
}
# their shortcuts on every administrator's desktop (Remote Desktop): right-click, Run as administrator
$desk = Join-Path $env:PUBLIC 'Desktop'
if (Test-Path -LiteralPath $desk) {
    Step "the desktop shortcuts in $desk" {
        foreach ($c in @(@('Start-HAVOC9.cmd', 'start-all.ps1', 'Starts everything havoc9.org runs here and shows whether it works.'),
                         @('Stop-HAVOC9.cmd', 'stop-all.ps1', 'Stops everything havoc9.org runs here (the next boot starts it again).'),
                         @('Restore-HAVOC9-Backup.cmd', 'restore-backup.ps1', 'Lists the backups and puts the one you choose back.'))) {
            $text = "@echo off`r`nrem $($c[2]) Right-click, Run as administrator.`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Root\$($c[1])`"`r`npause`r`n"
            [IO.File]::WriteAllText((Join-Path $desk $c[0]), $text, (New-Object Text.ASCIIEncoding))
        }
        $l = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'HAVOC9 Backups.lnk'))
        $l.TargetPath = Join-Path $H9Data 'backups'
        $l.Description = 'h9web backups: daily at 03:30, the newest 14 kept; log: logs\backup.log'
        $l.Save()
    }
}

Say '6. which services stop for the update'
# A service stops only for what it runs: havoc9-h9web for h9web's code (and for the relay's code when h9web's p2p module runs it),
# havoc9-serverlist for the list's code or its Python packages, havoc9-p2p for the relay's code. Every service stops for -Restore or
# -Keys, a tool replaced in step 2, a service wrapper or definition that changes, or a service not installed yet (a first install).
# The code checks are robocopy /L with the very arguments of the copies in steps 7 and 8, so they see what those copies will do.
# Nothing stops for the site or Caddy's settings: Caddy serves the site straight off disk and takes a new Caddyfile by a reload.
$defs = @(
    @{ Id = 'havoc9-h9web'; Name = 'havoc9 h9web'; Desc = 'HAVOC 9 accounts, forum and web client relay (h9web)'; Exe = $Node
       Args = "`"$H9web\server.js`" --config `"$Config`""; Dir = $H9web; Env = @{} },
    @{ Id = 'havoc9-serverlist'; Name = 'havoc9 server list'; Desc = 'The H9 server list (serverlist-bot), behind Caddy at /serverlist/'; Exe = (Join-Path $ListHome 'venv\Scripts\python.exe')
       Args = "`"$ListHome\h9_serverlist.py`""; Dir = $ListData; Env = @{ H9_SERVERLIST_HOME = $ListData; PYTHONUNBUFFERED = '1'; PYTHONDONTWRITEBYTECODE = '1' } },
    @{ Id = 'havoc9-caddy'; Name = 'havoc9 Caddy'; Desc = 'HTTPS for the site, h9web and the server list (Caddy)'; Exe = $Caddy
       Args = "run --config `"$Etc\Caddyfile`" --adapter caddyfile"; Dir = (Join-Path $Data 'caddy'); Env = @{ XDG_DATA_HOME = (Join-Path $Data 'caddy'); XDG_CONFIG_HOME = (Join-Path $Data 'caddy') } }
)
$p2pDef = $null
if ($P2P -eq 'standalone') {
    # Start (whether step 10 starts it) comes from the check of its settings in step 8b
    $p2pDef = @{ Id = 'havoc9-p2p'; Name = 'havoc9 p2p relay'; Desc = 'The P2P relay (h9rv): rendezvous and relay for listen games'; Exe = $Node
                 Args = "`"$P2PHome\bin\h9rv.js`" --config `"$P2PEtc\relay.config.json`""; Dir = $P2PHome; Env = @{}; Start = $false }
    $defs += $p2pDef
}
# each service's wrapper and definition (its WinSW XML) as step 10 writes them
foreach ($d in $defs) {
    $d.ExePath = Join-Path $Services ($d.Id + '.exe')
    $d.XmlPath = Join-Path $Services ($d.Id + '.xml')
    $envXml = ($d.Env.GetEnumerator() | ForEach-Object { "  <env name=`"$($_.Key)`" value=`"$($_.Value)`"/>" }) -join "`r`n"
    $body = @"
<!-- $($d.Id): written by vps\windows\setup.ps1 on every run -->
<service>
  <id>$($d.Id)</id>
  <name>$($d.Name)</name>
  <description>$($d.Desc)</description>
  <executable>$($d.Exe)</executable>
  <arguments>$([Security.SecurityElement]::Escape($d.Args))</arguments>
  <workingdirectory>$($d.Dir)</workingdirectory>
$envXml
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$Logs</logpath>
  <log mode="roll-by-time">
    <pattern>yyyyMMdd</pattern>
  </log>
</service>
"@
    $d.Body = $body
}
$everything = New-Object System.Collections.Generic.List[string]
if ($Restore) { $everything.Add('-Restore') }
if ($Keys) { $everything.Add('-Keys') }
if ($toolsReplaced.Count) { $everything.Add('a tool is replaced: ' + ($toolsReplaced -join ', ')) }
foreach ($d in $defs) {
    if (-not (Get-Service $d.Id -ErrorAction SilentlyContinue)) { $everything.Add("$($d.Id) is not installed yet"); continue }
    if (-not ((Test-Path -LiteralPath $d.ExePath) -and (Get-FileHash -LiteralPath $d.ExePath -Algorithm SHA256).Hash -ieq $pin.winsw.Hash)) { $everything.Add("the wrapper of $($d.Id) is not the pinned WinSW") }
    if (-not ((Test-Path -LiteralPath $d.XmlPath) -and [string]::Equals([IO.File]::ReadAllText($d.XmlPath), $d.Body, [StringComparison]::Ordinal))) { $everything.Add("the definition of $($d.Id) changes") }
}
# the copies of steps 7 and 8 with every argument they take; the checks run the very same copies with /L
$h9webMirror = @{ From = (Join-Path $Src 'h9web'); To = $H9web; ExcludeDirs = @('data', 'test', 'node_modules'); ExcludeFiles = @('config.json', 'servers.json', '*.bak*', '*.cmd', '*.ps1') }
$listMirror = @{ From = (Join-Path $Src 'serverlist-bot'); To = $ListHome; ExcludeDirs = @('venv', '__pycache__'); ExcludeFiles = @('serverlist.cfg', 'serverlist.cfg.example', 'serverlist.ini', 'servers.txt', 'blacklisted.ini', 'serverlist.log', '*.bat', '.gitignore') }
$h9webCheck = Copy-Mirror @h9webMirror -ListOnly
$listCheck = Copy-Mirror @listMirror -ListOnly
# the relay's code by name (step 8b copies exactly these): changed when one of them is missing or differs
$P2PFiles = @('lib\service.js', 'lib\wire.js', 'lib\codes.js', 'lib\limits.js', 'lib\auth.js', 'lib\config.js', 'bin\h9rv.js', 'package.json', 'README.txt',
              'relay.config.example.json', 'hosts.example.json', 'relay.site.ini.example', 'run.bat')
$p2pChanged = $false
if ($P2P) {
    foreach ($f in $P2PFiles) {
        $from = Join-Path $Src "p2p\$f"
        $to = Join-Path $P2PHome $f
        if (-not (Test-Path -LiteralPath $from -PathType Leaf) -or -not (Test-Path -LiteralPath $to -PathType Leaf) -or
            (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) { $p2pChanged = $true; break }
    }
}
# the list's Python packages go in again only when the venv has no python.exe or its key differs: requirements.txt's SHA-256 and the
# pinned Python version, so a new Python pin installs them again as well. The key is kept in the venv and written once pip succeeds.
$venvPython = Join-Path $ListHome 'venv\Scripts\python.exe'
$pipKeyFile = Join-Path $ListHome 'venv\pip-key.txt'
$pipKey = (Get-FileHash -LiteralPath (Join-Path $Src 'serverlist-bot\requirements.txt') -Algorithm SHA256).Hash.ToLowerInvariant() + ' python ' + $pin.python.Version
$pipKeyHave = ''; if (Test-Path -LiteralPath $pipKeyFile) { $pipKeyHave = ([IO.File]::ReadAllText($pipKeyFile)).Trim() }
$pipNeeded = (-not (Test-Path -LiteralPath $venvPython)) -or ($pipKeyHave -ne $pipKey)

$stopWhy = [ordered]@{}
function Add-Stop([string]$Name, [string]$Reason)
{
    if ($stopWhy.Contains($Name)) { $stopWhy[$Name] = $stopWhy[$Name] + '; ' + $Reason } else { $stopWhy[$Name] = $Reason }
}
if ($everything.Count) { foreach ($n in $ServiceNames) { Add-Stop $n ($everything -join '; ') } }
if (Test-TreeChanged $h9webCheck) { Add-Stop 'havoc9-h9web' "h9web's code changed" }
if ($p2pChanged -and $P2P -eq 'module') { Add-Stop 'havoc9-h9web' "the relay's code changed (h9web's p2p module runs it)" }
if ($p2pChanged -and $P2P -eq 'standalone') { Add-Stop 'havoc9-p2p' "the relay's code changed" }
if (Test-TreeChanged $listCheck) { Add-Stop 'havoc9-serverlist' "the list's code changed" }
if ($pipNeeded) { Add-Stop 'havoc9-serverlist' 'its Python packages go in again' }
$stopThese = @($stopWhy.Keys)
Note ("robocopy /L: {0} file(s) or folder(s) to copy or remove in h9web's code, {1} in the list's code" -f $h9webCheck, $listCheck)
foreach ($n in $ServiceNames) {
    if ($stopWhy.Contains($n)) { Note ('{0,-20} stops: {1}' -f $n, $stopWhy[$n]) }
    elseif ($n -eq 'havoc9-caddy' -and $caddyChanged) { Note ('{0,-20} does not stop: its new Caddyfile goes in by a reload at the end of step 10' -f $n) }
    else { Note ('{0,-20} does not stop: nothing it runs changed' -f $n) }
}
# what happens to each service, for the line printed about it at the end, and which ones this run stops, starts or restarts
$Outcome = @{}
$Cycled = @{}
if ($stopThese.Count) {
    Step ('stop ' + ($stopThese -join ', ') + ' for the update') { foreach ($n in $stopThese) { if (Get-Service $n -ErrorAction SilentlyContinue) { Stop-Service $n -Force } } }
    foreach ($n in $stopThese) { $Cycled[$n] = $true }
} else {
    Note 'nothing stops for this update'
}
# A running service whose code a copy changed although step 6 found nothing is restarted at once, so no process keeps running code
# that differs from what is on disk. One that is not running is left alone: it takes the new code when it starts.
function Restart-Changed([string]$Name, [string]$Reason)
{
    if ((Get-ServiceState $Name) -ne 'Running') { Note "$Name is not running: it takes the new code when it starts"; return }
    Step "restart $Name ($Reason)" { Restart-Service -Name $Name -Force }
    $Outcome[$Name] = "restarted ($Reason)"
    $Cycled[$Name] = $true
    Warn "$Name was restarted: $Reason"
}

Say '7. h9web'
$rc = Step "h9web's code into $H9web" { Copy-Mirror @h9webMirror }
if (-not $DryRun -and $stopThese -notcontains 'havoc9-h9web' -and (Test-TreeChanged $rc)) { Restart-Changed 'havoc9-h9web' 'the copy changed its code while it was running' }
if (-not (Test-Path -LiteralPath $Config)) {
    Step "make $Config from config.example.json (this host's paths and domain)" {
        $c = Get-Content -Raw -LiteralPath (Join-Path $Src 'h9web\config.example.json') | ConvertFrom-Json
        $c.allowedOrigins = @("https://$Domain")
        $c.dataDir = "$Fwd/data/h9web"
        $c.serversFile = "$Fwd/etc/servers.json"
        $c.modulesDir = "$Fwd/h9web/modules"
        if ($c.moduleSettings.discord) { $c.moduleSettings.discord.redirectUri = "https://$Domain/api/discord/callback" }
        [IO.File]::WriteAllText($Config, ($c | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
    }
} else { Note "$Config is kept as it is" }
$serversJson = Join-Path $Etc 'servers.json'
if (-not (Test-Path -LiteralPath $serversJson)) {
    Step "make an empty $serversJson (h9web/README.txt section 6)" { [IO.File]::WriteAllText($serversJson, "{ `"servers`": [] }`n", (New-Object Text.UTF8Encoding $false)) }
} else { Note "$serversJson is kept as it is" }

Say '8. the server list'
$rc = Step "the list's code into $ListHome" { Copy-Mirror @listMirror }
if (-not $DryRun -and $stopThese -notcontains 'havoc9-serverlist' -and (Test-TreeChanged $rc)) { Restart-Changed 'havoc9-serverlist' 'the copy changed its code while it was running' }
if ($pipNeeded) {
    Step "its Python packages (requirements.txt) into $ListHome\venv" {
        if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-Native $Python @('-m', 'venv', (Join-Path $ListHome 'venv')) }
        Invoke-Native $venvPython @('-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--upgrade', '-r', (Join-Path $ListHome 'requirements.txt'))
        [IO.File]::WriteAllText($pipKeyFile, "$pipKey`n", (New-Object Text.ASCIIEncoding))
    }
} else { Note "its Python packages are in already for this requirements.txt and Python $($pin.python.Version) ($pipKeyFile)" }
foreach ($f in @('serverlist.ini', 'servers.txt')) {
    $dst = Join-Path $ListData $f
    if (-not (Test-Path -LiteralPath $dst)) { Step "make $dst" { [IO.File]::WriteAllText($dst, ((Get-Content -Raw -LiteralPath (Join-Path $Src "serverlist-bot\$f")) -replace 'havoc9\.org', $Domain)) } }
}
$listCfg = Join-Path $ListData 'serverlist.cfg'
if (-not (Test-Path -LiteralPath $listCfg)) { Step "make $listCfg (no heartbeat key, no Discord token yet)" { Copy-Item -LiteralPath (Join-Path $Src 'serverlist-bot\serverlist.cfg.example') -Destination $listCfg } }
$listBlack = Join-Path $ListData 'blacklisted.ini'
if (-not (Test-Path -LiteralPath $listBlack)) { Step "make $listBlack (it blacklists nothing until you add a line)" { Copy-Item -LiteralPath (Join-Path $Src 'serverlist-bot\blacklisted.ini.example') -Destination $listBlack } }

$p2pReady = $false
if ($P2P) {
    Say "8b. the P2P relay (-P2P $P2P)"
    foreach ($need in @('p2p\lib\service.js', 'p2p\lib\auth.js', 'p2p\bin\h9rv.js', 'p2p\relay.config.example.json', 'p2p\hosts.example.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Src $need))) { Fail "$Src\$need is missing: run this from the unpacked package" }
    }
    # its code by name: never a real config or hosts file from a clone
    Step "the relay's code into $P2PHome" {
        foreach ($f in $P2PFiles) {
            $to = Join-Path $P2PHome $f
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
            Copy-Item -LiteralPath (Join-Path $Src "p2p\$f") -Destination $to -Force
        }
    }
    if ($P2P -eq 'module') {
        Note "h9web's p2p module finds the code there (it sits beside h9web). Switch the module on in $Config (README-WINDOWS.txt step 16), then: Restart-Service havoc9-h9web"
    } else {
        Step "settings in $P2PEtc (made from the examples when there are none, never overwritten)" {
            New-Item -ItemType Directory -Force -Path $P2PEtc | Out-Null
            foreach ($f in @('relay.config', 'hosts')) {
                $dst = Join-Path $P2PEtc "$f.json"
                if (-not (Test-Path -LiteralPath $dst)) { Copy-Item -LiteralPath (Join-Path $Src "p2p\$f.example.json") -Destination $dst }
            }
        }
        if (-not $DryRun) {
            $out = & $Node (Join-Path $P2PHome 'bin\h9rv.js') --config (Join-Path $P2PEtc 'relay.config.json') --check 2>&1
            $p2pReady = ($LASTEXITCODE -eq 0)
            if ($p2pReady) {
                Note ($out | Where-Object { $_ -match 'who may host' } | Select-Object -First 1)
            } else {
                foreach ($line in $out) { Note "    $line" }
                Warn "the P2P relay is installed but not started: finish $P2PEtc\relay.config.json (publicUdp.host) and make a host token (& '$Node' '$P2PHome\bin\h9rv.js' token <name> --hosts '$P2PEtc\hosts.json'), then: Start-Service havoc9-p2p"
            }
        }
    }
}

if ($Keys -or $Restore) {
    Say '9. the keys and the restore'
    if ($Keys) {
        foreach ($k in @('secrets.json', 'data.key')) {
            $from = Join-Path $Keys $k
            if (-not (Test-Path -LiteralPath $from)) { continue }
            $to = Join-Path $H9Data $k
            if ((Test-Path -LiteralPath $to) -and (Get-FileHash $to).Hash -ne (Get-FileHash $from).Hash) { Fail "$to is there already and differs from $from. Move it away first if $Keys holds the right one" }
            Step "$to from $Keys" { Copy-Item -LiteralPath $from -Destination $to -Force }
        }
    }
    if ($Restore) {
        $copy = Join-Path $H9Data ('restore-' + [IO.Path]::GetFileName($Restore))
        $passCopy = Join-Path $H9Data '.restore-passphrase'
        Step "restore $Restore (checked first)" {
            Copy-Item -LiteralPath $Restore -Destination $copy -Force
            $extra = @()
            if ($PassphraseFile) { Copy-Item -LiteralPath $PassphraseFile -Destination $passCopy -Force; $extra = @('--passphrase-file', $passCopy) }
            try {
                Invoke-Native $Node (@((Join-Path $H9web 'bin\h9web-backup.js'), 'verify', $copy) + $extra)
                Invoke-Native $Node (@((Join-Path $H9web 'bin\h9web-backup.js'), '--config', $Config, 'restore', $copy, '--yes') + $extra)
            } finally {
                Remove-Item -LiteralPath $passCopy -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $copy -Force
        }
    }
}

Say '10. the services (WinSW, LocalService, started at boot)'
$firstKeys = -not (Test-Path -LiteralPath (Join-Path $H9Data 'secrets.json'))
# the relay is started only when its settings passed the check in step 8b
if ($null -ne $p2pDef) { $p2pDef.Start = $p2pReady }
foreach ($d in $defs) {
    $exe = $d.ExePath
    $xml = $d.XmlPath
    $body = $d.Body
    # The wrapper is copied only when it is not the pinned WinSW: Windows does not overwrite the image of a running service, and
    # step 6 stopped every service when one was not. WinSW reads the XML when the service starts, so a running service whose XML
    # changes, and that step 6 did not stop, is restarted.
    $wrapperOk = (Test-Path -LiteralPath $exe) -and (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ieq $pin.winsw.Hash
    $xmlSame = (Test-Path -LiteralPath $xml) -and [string]::Equals([IO.File]::ReadAllText($xml), $body, [StringComparison]::Ordinal)
    $installed = [bool](Get-Service $d.Id -ErrorAction SilentlyContinue)
    $running = (Get-ServiceState $d.Id) -eq 'Running'
    $held = $d.ContainsKey('Start') -and -not $d.Start
    Step "service $($d.Id)" {
        if (-not $wrapperOk) { Copy-Item -LiteralPath $WinSW -Destination $exe -Force }
        if (-not $xmlSame) { [IO.File]::WriteAllText($xml, $body, (New-Object Text.UTF8Encoding $false)) }
        if (-not (Get-Service $d.Id -ErrorAction SilentlyContinue)) { Invoke-Native $exe @('install') | Out-Null }
        $change = Get-CimInstance Win32_Service -Filter "Name = '$($d.Id)'" | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
        if ($change.ReturnValue -ne 0) { throw "$($d.Id): the service account could not be set to LocalService ($($change.ReturnValue))" }
        if ($held) {
            if ((Get-ServiceState $d.Id) -eq 'Running') { Stop-Service $d.Id -Force; Note "$($d.Id): stopped, not started (its settings are unfinished: step 8b)" }
            else { Note "$($d.Id): installed, not started (its settings are unfinished: step 8b)" }
        }
        elseif ($running -and -not $xmlSame -and $stopThese -notcontains $d.Id) { Restart-Service $d.Id -Force }
        else { Start-Service $d.Id }
    }
    if ($held) {
        $Outcome[$d.Id] = 'not started: its settings are unfinished (step 8b)'
        if (-not $installed) { $Outcome[$d.Id] = 'installed, ' + $Outcome[$d.Id] }
        elseif ($running -or ($stopThese -contains $d.Id -and $wasRunning[$d.Id])) { $Outcome[$d.Id] = 'stopped, ' + $Outcome[$d.Id] }
    }
    elseif (-not $installed) { $Outcome[$d.Id] = 'installed and started'; $Cycled[$d.Id] = $true }
    elseif ($stopThese -contains $d.Id) { $Outcome[$d.Id] = $(if ($wasRunning[$d.Id]) { 'restarted' } else { 'started' }) + " ($($stopWhy[$d.Id]))" }
    elseif ($running -and -not $xmlSame) { $Outcome[$d.Id] = 'restarted (its definition changed)'; $Cycled[$d.Id] = $true }
    elseif (-not $running) { $Outcome[$d.Id] = 'started (it was not running)'; $Cycled[$d.Id] = $true }
    elseif (-not $Outcome.ContainsKey($d.Id)) { $Outcome[$d.Id] = 'left running' }
}
# a service with no definition in this run (havoc9-p2p without -P2P standalone) is never started here
foreach ($n in $ServiceNames) {
    if ($Outcome.ContainsKey($n)) { continue }
    if ($stopThese -contains $n -and $wasRunning[$n]) { $Outcome[$n] = "stopped ($($stopWhy[$n])), not started: setup.ps1 starts it only with -P2P standalone" }
    elseif ((Get-ServiceState $n) -eq 'Running') { $Outcome[$n] = 'left running' }
    else { $Outcome[$n] = 'left as it is (' + (Get-ServiceState $n) + ')' }
}
# step 4's new etc\Caddyfile goes into a havoc9-caddy that kept running by a reload, run with the service's own XDG folders (its
# definition in step 6); when the reload fails, havoc9-caddy alone is restarted
function Invoke-CaddyReload
{
    $caddyHome = Join-Path $Data 'caddy'
    $keep = @{ Data = $env:XDG_DATA_HOME; Config = $env:XDG_CONFIG_HOME }
    $env:XDG_DATA_HOME = $caddyHome
    $env:XDG_CONFIG_HOME = $caddyHome
    try {
        & $Caddy @('reload', '--config', $caddyConf, '--adapter', 'caddyfile') | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        $env:XDG_DATA_HOME = $keep.Data
        $env:XDG_CONFIG_HOME = $keep.Config
    }
}
$caddyTook = $false
if ($caddyChanged -and -not $Cycled['havoc9-caddy'] -and (Get-ServiceState 'havoc9-caddy') -eq 'Running') {
    $reloaded = Step "reload havoc9-caddy with the new $caddyConf" { Invoke-CaddyReload }
    if ($DryRun -or $reloaded -eq $true) {
        $Outcome['havoc9-caddy'] = 'reloaded (its Caddyfile changed)'
        $caddyTook = $true
    } else {
        Warn "caddy reload failed (above): havoc9-caddy alone is restarted to take the new $caddyConf"
        Step 'restart havoc9-caddy (the reload failed)' { Restart-Service -Name 'havoc9-caddy' -Force }
        $Outcome['havoc9-caddy'] = 'restarted (its Caddyfile changed and the reload failed)'
        $Cycled['havoc9-caddy'] = $true
    }
}
# started, restarted or reloaded in this run, havoc9-caddy runs on etc\Caddyfile: the mark that it has yet to take it goes
if (($caddyTook -or $Cycled['havoc9-caddy']) -and (Test-Path -LiteralPath $caddyPending)) { Step "remove $caddyPending" { Remove-Item -LiteralPath $caddyPending -Force } }
# the wait for h9web and the three lines below only when havoc9-h9web was stopped, started or restarted here (start-all.ps1 checks
# every part at the end of a delivery)
if (-not $DryRun -and $Cycled['havoc9-h9web']) {
    for ($i = 0; $i -lt 20 -and (Test-Http 'http://127.0.0.1:8090/api/me') -ne '200'; $i++) { Start-Sleep -Seconds 1 }
    Note ('h9web ' + (Get-ServiceState 'havoc9-h9web') + ', HTTP ' + (Test-Http 'http://127.0.0.1:8090/api/me'))
    Note ('list  ' + (Get-ServiceState 'havoc9-serverlist') + ', HTTP ' + (Test-Http 'http://127.0.0.1:8081/v1/servers/ts'))
    Note ('Caddy ' + (Get-ServiceState 'havoc9-caddy'))
}
if (-not $DryRun -and $firstKeys -and (Test-Path -LiteralPath (Join-Path $H9Data 'secrets.json'))) { Warn "h9web made new keys: copy $H9Data\secrets.json and $H9Data\data.key somewhere safe and offline NOW (README-WINDOWS.txt step 6)" }

Say '11. backups and log cleanup (scheduled tasks, LocalService)'
$svc = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCALSERVICE' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$cli = "`"$Node`" `"$H9web\bin\h9web-backup.js`" --config `"$Config`""
$tasks = @(
    @{ Name = 'havoc9 h9web backup'; At = '03:30'; Line = "$cli backup --out `"$H9Data\backups`" --keep 14 >> `"$Logs\backup.log`" 2>&1"; On = $true },
    @{ Name = 'havoc9 h9web backup offsite'; At = '03:45'; Line = "$cli backup --encrypt --with-keys --passphrase-file `"$Passphrase`" --out `"$H9Data\offsite`" --keep 7 >> `"$Logs\backup.log`" 2>&1"; On = (Test-Path -LiteralPath $Passphrase) },
    @{ Name = 'havoc9 log cleanup'; At = '04:00'; Line = "forfiles /p `"$Logs`" /m *.log /d -30 /c `"cmd /c del @path`" 2>nul & exit /b 0"; On = $true },
    @{ Name = 'havoc9 code check'; At = '05:30'; Line = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$Root\code-check.ps1`" -Root `"$Root`" -Check >> `"$Logs\code-check-task.log`" 2>&1"; On = (Test-Path -LiteralPath (Join-Path $Root 'code-check.ps1')) }
)
foreach ($t in $tasks) {
    if (-not $t.On) {
        Note "$($t.Name): off until $Passphrase exists (README-WINDOWS.txt step 8)"
        continue
    }
    Step "scheduled task '$($t.Name)' daily at $($t.At)" {
        $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c "' + $t.Line + '"')
        $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($t.At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
        Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Principal $svc -Settings $settings -Description 'havoc9.org (vps\windows\setup.ps1)' -Force | Out-Null
    }
}

if (-not $NoFirewall) {
    Say '12. the firewall'
    # who may reach 80 and 443: every address, or with -WebFrom cloudflare Cloudflare's ranges only (remembered in etc\web-from.txt)
    $webScope = 'any'
    if ($WebFrom) {
        $webScope = $WebFrom
        Step "remember -WebFrom $WebFrom in $WebFromFile" { [IO.File]::WriteAllText($WebFromFile, "$WebFrom`n") }
    } elseif (Test-Path -LiteralPath $WebFromFile) {
        $webScope = ([IO.File]::ReadAllText($WebFromFile)).Trim()
    }
    $webAddr = @('Any')
    if ($webScope -eq 'cloudflare') {
        if ($CfRanges.Count) { $webAddr = $CfRanges } else { Warn "-WebFrom cloudflare: no Cloudflare ranges are known, so TCP 80 and 443 stay open to every address" }
    }
    $rules = @(@{ Name = 'havoc9 web (Caddy, TCP 80 and 443)'; Proto = 'TCP'; Ports = @('80', '443'); From = $webAddr; FromText = $webScope })
    # the game servers' name (Caddyfile: {GAMEHOST}) is reached directly, from any address, over IPv4: TCP 443 for everyone
    $rules += @{ Name = "havoc9 game API ($GameHost, TCP 443)"; Proto = 'TCP'; Ports = @('443') }
    foreach ($g in $GamePorts) {
        $parts = $g.Split('/')
        $rules += @{ Name = "havoc9 game server ($g)"; Proto = $parts[1].ToUpper(); Ports = @($parts[0]) }
    }
    if ($P2P) { $rules += @{ Name = "havoc9 p2p relay (UDP $P2PPort)"; Proto = 'UDP'; Ports = @([string]$P2PPort) } }
    foreach ($r in $rules) {
        $from = @('Any'); if ($r.From) { $from = $r.From }
        if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) {
            if (-not $r.From) { Note "$($r.Name): there"; continue }
            Step "firewall rule '$($r.Name)': from $($r.FromText)" { Set-NetFirewallRule -DisplayName $r.Name -RemoteAddress $from }
            continue
        }
        Step "firewall rule '$($r.Name)'" { New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol $r.Proto -LocalPort $r.Ports -RemoteAddress $from -Action Allow -Profile Any | Out-Null }
    }
    Note 'h9web and the list listen on 127.0.0.1 only: no rule needed for them'
}

if ($NoFingerprint) {
    Say '13. the fingerprint of all code: left to the delivery, which writes it once at the end'
}
elseif (-not $DryRun -and (Test-Path -LiteralPath (Join-Path $Root 'code-check.ps1'))) {
    Say '13. the fingerprint of all code (code-check.ps1)'
    try { if (-not [Diagnostics.EventLog]::SourceExists('havoc9')) { New-EventLog -LogName Application -Source 'havoc9' } } catch { }
    & (Join-Path $Root 'code-check.ps1') -Root $Root -Write
}

Say 'done'
# what this run did to each service
foreach ($n in $ServiceNames) {
    $outcomeText = $Outcome[$n]
    if ($DryRun) { $outcomeText = "(a dry run, nothing was done) $outcomeText" }
    Note ('{0,-20} {1}' -f $n, $outcomeText)
}
Note "site     https://$Domain/  (Caddy makes the certificate once DNS points here and ports 80 and 443 reach this machine)"
Note "check    .\setup.ps1 -Check"
Note "next     README-WINDOWS.txt: the first admin (step 6), the game servers and the list (step 7), backups (step 8)"
foreach ($w in $Warnings) { Write-Host "  [WARN] $w" -ForegroundColor Yellow }
exit 0

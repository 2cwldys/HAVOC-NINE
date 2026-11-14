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
    [string]$Email = '',
    [string[]]$GamePorts = @('27015/udp'),
    [string]$H9Xash = '',
    [string]$Restore = '',
    [string]$Keys = '',
    [string]$PassphraseFile = '',
    [string]$WebClientStage = '',
    [ValidateSet('', 'module', 'standalone')][string]$P2P = '',
    [ValidateRange(1, 65535)][int]$P2PPort = 27248,
    [switch]$NoFirewall,
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

# The downloads' file index, site\downloads\files (README-WINDOWS.txt step 13). The three files
# the DOWNLOADS page's buttons fetch from site\downloads are symbolic links there, so the disk
# holds one copy and a link always opens the file downloads\ holds now, whatever replaced it.
# Each link is made again when it is missing or points elsewhere, then checked: its SHA-256 must
# be that of the file in downloads\. A button file not there yet is skipped (an old link to it
# goes). Last, SHA256SUMS.txt lists the SHA-256 of every file the index serves.
$ButtonFiles = @('H9XASH.zip', 'H9XASH-linux.zip', 'H9XASH-Updater.exe')
function Sync-Downloads
{
    $dl = Join-Path $Site 'downloads'
    $idx = Join-Path $dl 'files'
    if (-not (Test-Path -LiteralPath $idx)) { Step "make $idx" { New-Item -ItemType Directory -Force -Path $idx | Out-Null } }
    $sums = @{}
    foreach ($f in $ButtonFiles) {
        $src = Join-Path $dl $f
        $link = Join-Path $idx $f
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
            Note "downloads\files\$f is downloads\$f (SHA-256 $a)"
            $sums[$f] = $a
        } else {
            Warn "downloads\files\$f IS NOT THE SAME FILE as downloads\$f (SHA-256 $b, not $a): look at $idx"
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
Step "lock $Data, $Logs and $Etc to SYSTEM, Administrators and LocalService" {
    foreach ($d in @($Data, $Logs)) { Invoke-Native 'icacls.exe' @($d, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)M', '/T', '/Q') | Out-Null }
    Invoke-Native 'icacls.exe' @($Etc, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)RX', '/T', '/Q') | Out-Null
}

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

$nodeNow = ''; if (Test-Path -LiteralPath $Node) { $nodeNow = (& $Node --version) }
if ($nodeNow -ne ('v' + $pin.node.Version)) {
    $zip = Get-Pinned $pin.node
    Step "Node.js $($pin.node.Version) into $Tools\node" {
        $tmp = Join-Path $Downloads 'node-unpack'
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        if (Test-Path -LiteralPath (Join-Path $Tools 'node')) { Remove-Item -LiteralPath (Join-Path $Tools 'node') -Recurse -Force }
        Move-Item -LiteralPath (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName -Destination (Join-Path $Tools 'node')
        Remove-Item -LiteralPath $tmp -Recurse -Force
    }
} else { Note "Node.js $nodeNow" }

$caddyNow = ''; if (Test-Path -LiteralPath $Caddy) { $caddyNow = [string](& $Caddy version) }
if ($caddyNow -notmatch ('^v' + [regex]::Escape($pin.caddy.Version) + '\b')) {
    $zip = Get-Pinned $pin.caddy
    Step "Caddy $($pin.caddy.Version) into $Tools\caddy (stopping havoc9-caddy first)" {
        if (Get-Service havoc9-caddy -ErrorAction SilentlyContinue) { Stop-Service havoc9-caddy -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path (Join-Path $Tools 'caddy') | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Tools 'caddy') -Force
    }
} else { Note "Caddy $($caddyNow.Split(' ')[0])" }

if (-not ((Test-Path -LiteralPath $WinSW) -and (Get-FileHash -LiteralPath $WinSW -Algorithm SHA256).Hash -ieq $pin.winsw.Hash)) {
    $exe = Get-Pinned $pin.winsw
    Step "WinSW $($pin.winsw.Version) into $Tools\winsw" {
        New-Item -ItemType Directory -Force -Path (Join-Path $Tools 'winsw') | Out-Null
        Copy-Item -LiteralPath $exe -Destination $WinSW -Force
    }
} else { Note "WinSW $($pin.winsw.Version)" }

$pyNow = ''; if (Test-Path -LiteralPath $Python) { $pyNow = [string](& $Python --version 2>&1) }
if ($pyNow -ne ('Python ' + $pin.python.Version)) {
    $exe = Get-Pinned $pin.python
    Step "Python $($pin.python.Version) into $Tools\python (its own installer, quietly)" {
        if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid') { throw "$exe is not signed as it should be" }
        $p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList @('/quiet', 'InstallAllUsers=1', "TargetDir=$Tools\python", 'PrependPath=0', 'Include_launcher=0',
            'Include_test=0', 'Include_doc=0', 'Include_tcltk=0', 'Shortcuts=0', 'AssociateFiles=0', 'Include_pip=1')
        if ($p.ExitCode -ne 0) { throw "the Python installer exited with $($p.ExitCode)" }
    }
} else { Note $pyNow }

Say '3. h9web'
if ((Test-Path -LiteralPath (Join-Path $H9Data 'h9web.db')) -and (Test-Path -LiteralPath (Join-Path $H9web 'bin\h9web-backup.js')) -and (Test-Path -LiteralPath $Config)) {
    Step 'a backup before the update' {
        & $Node (Join-Path $H9web 'bin\h9web-backup.js') --config $Config backup --out (Join-Path $H9Data 'backups') --keep 14
        if ($LASTEXITCODE -ne 0) { Warn 'the backup before the update failed (above); the update goes on' }
    }
}
Step 'stop the services for the update' { foreach ($n in $ServiceNames) { if (Get-Service $n -ErrorAction SilentlyContinue) { Stop-Service $n -Force } } }
function Copy-Mirror([string]$From, [string]$To, [string[]]$ExcludeDirs, [string[]]$ExcludeFiles)
{
    $a = @($From, $To, '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP')
    if ($ExcludeDirs) { $a += '/XD'; $a += $ExcludeDirs }
    if ($ExcludeFiles) { $a += '/XF'; $a += $ExcludeFiles }
    & robocopy.exe @a | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
}
Step "h9web's code into $H9web" { Copy-Mirror (Join-Path $Src 'h9web') $H9web @('data', 'test', 'node_modules') @('config.json', 'servers.json', '*.bak*', '*.cmd', '*.ps1') }
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

Say '4. the server list'
Step "the list's code into $ListHome" { Copy-Mirror (Join-Path $Src 'serverlist-bot') $ListHome @('venv', '__pycache__') @('serverlist.cfg', 'serverlist.cfg.example', 'serverlist.ini', 'servers.txt', 'serverlist.log', '*.bat', '.gitignore') }
Step "its Python packages (requirements.txt) into $ListHome\venv" {
    if (-not (Test-Path -LiteralPath (Join-Path $ListHome 'venv\Scripts\python.exe'))) { Invoke-Native $Python @('-m', 'venv', (Join-Path $ListHome 'venv')) }
    Invoke-Native (Join-Path $ListHome 'venv\Scripts\python.exe') @('-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--upgrade', '-r', (Join-Path $ListHome 'requirements.txt'))
}
foreach ($f in @('serverlist.ini', 'servers.txt')) {
    $dst = Join-Path $ListData $f
    if (-not (Test-Path -LiteralPath $dst)) { Step "make $dst" { [IO.File]::WriteAllText($dst, ((Get-Content -Raw -LiteralPath (Join-Path $Src "serverlist-bot\$f")) -replace 'havoc9\.org', $Domain)) } }
}
$listCfg = Join-Path $ListData 'serverlist.cfg'
if (-not (Test-Path -LiteralPath $listCfg)) { Step "make $listCfg (no heartbeat key, no Discord token yet)" { Copy-Item -LiteralPath (Join-Path $Src 'serverlist-bot\serverlist.cfg.example') -Destination $listCfg } }

$p2pReady = $false
if ($P2P) {
    Say "4b. the P2P relay (-P2P $P2P)"
    foreach ($need in @('p2p\lib\service.js', 'p2p\lib\auth.js', 'p2p\bin\h9rv.js', 'p2p\relay.config.example.json', 'p2p\hosts.example.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Src $need))) { Fail "$Src\$need is missing: run this from the unpacked package" }
    }
    # its code by name: never a real config or hosts file from a clone
    Step "the relay's code into $P2PHome" {
        foreach ($f in @('lib\service.js', 'lib\wire.js', 'lib\codes.js', 'lib\limits.js', 'lib\auth.js', 'lib\config.js', 'bin\h9rv.js', 'package.json', 'README.txt',
                         'relay.config.example.json', 'hosts.example.json', 'relay.site.ini.example', 'run.bat')) {
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

Say '5. the site'
# What robocopy leaves out it also leaves alone: the downloads (the ZIPs, H9XASH-Updater.exe), the
# downloads' file index (downloads\files) and H9XASH-Updater's files\ are kept.
Step "the site into $Site" {
    Copy-Mirror (Join-Path $Src 'havoc9.org') $Site @('deploy', 'engine', '.git', 'files') @('DEPLOY.txt', 'manifest.json', 'preload.json', '*.bak*', '*.zip', '*.orig', 'README.md', 'HAVOC_NINE_MASTER_SERVER.txt', '.*', 'H9XASH-Updater.exe')
}
Sync-Downloads
if ($WebClientStage) {
    foreach ($f in @('manifest.json', 'preload.json', 'engine\xash.js', 'engine\xash.wasm')) { if (-not (Test-Path -LiteralPath (Join-Path $WebClientStage $f))) { Fail "-WebClientStage: no $f in $WebClientStage" } }
    Step "the web client from $WebClientStage" {
        Copy-Mirror (Join-Path $WebClientStage 'game') $Game @() @()
        Copy-Mirror (Join-Path $WebClientStage 'engine') (Join-Path $Site 'webclient\engine') @() @()
        foreach ($f in @('manifest.json', 'preload.json')) { Copy-Item -LiteralPath (Join-Path $WebClientStage $f) -Destination (Join-Path $Site 'webclient') -Force }
    }
}

Say '6. Caddy (HTTPS for the domain)'
$emailLine = ''; if ($Email) { $emailLine = "email $Email" }
$caddyfile = (Get-Content -Raw -LiteralPath (Join-Path $Here 'Caddyfile.template')).Replace('{DOMAIN}', $Domain).Replace('{ROOT}', $Fwd).Replace('{EMAIL_LINE}', $emailLine)
Step "write $Etc\Caddyfile" {
    [IO.File]::WriteAllText((Join-Path $Etc 'Caddyfile'), $caddyfile, (New-Object Text.UTF8Encoding $false))
    $extra = Join-Path $Etc 'Caddyfile.extra'
    if (-not (Test-Path -LiteralPath $extra)) { [IO.File]::WriteAllText($extra, "# Your own Caddy settings; setup.ps1 imports this file and never writes it.`n") }
    Invoke-Native $Caddy @('validate', '--config', (Join-Path $Etc 'Caddyfile'), '--adapter', 'caddyfile') | Out-Null
}

if ($Keys -or $Restore) {
    Say '7. the keys and the restore'
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

Say '8. the services (WinSW, LocalService, started at boot)'
$firstKeys = -not (Test-Path -LiteralPath (Join-Path $H9Data 'secrets.json'))
$defs = @(
    @{ Id = 'havoc9-h9web'; Name = 'havoc9 h9web'; Desc = 'HAVOC 9 accounts, forum and web client relay (h9web)'; Exe = $Node
       Args = "`"$H9web\server.js`" --config `"$Config`""; Dir = $H9web; Env = @{} },
    @{ Id = 'havoc9-serverlist'; Name = 'havoc9 server list'; Desc = 'The H9 server list (serverlist-bot), behind Caddy at /serverlist/'; Exe = (Join-Path $ListHome 'venv\Scripts\python.exe')
       Args = "`"$ListHome\h9_serverlist.py`""; Dir = $ListData; Env = @{ H9_SERVERLIST_HOME = $ListData; PYTHONUNBUFFERED = '1'; PYTHONDONTWRITEBYTECODE = '1' } },
    @{ Id = 'havoc9-caddy'; Name = 'havoc9 Caddy'; Desc = 'HTTPS for the site, h9web and the server list (Caddy)'; Exe = $Caddy
       Args = "run --config `"$Etc\Caddyfile`" --adapter caddyfile"; Dir = (Join-Path $Data 'caddy'); Env = @{ XDG_DATA_HOME = (Join-Path $Data 'caddy'); XDG_CONFIG_HOME = (Join-Path $Data 'caddy') } }
)
if ($P2P -eq 'standalone') {
    $defs += @{ Id = 'havoc9-p2p'; Name = 'havoc9 p2p relay'; Desc = 'The P2P relay (h9rv): rendezvous and relay for listen games'; Exe = $Node
                Args = "`"$P2PHome\bin\h9rv.js`" --config `"$P2PEtc\relay.config.json`""; Dir = $P2PHome; Env = @{}; Start = $p2pReady }
}
foreach ($d in $defs) {
    $exe = Join-Path $Services ($d.Id + '.exe')
    $xml = Join-Path $Services ($d.Id + '.xml')
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
    Step "service $($d.Id)" {
        Copy-Item -LiteralPath $WinSW -Destination $exe -Force
        [IO.File]::WriteAllText($xml, $body, (New-Object Text.UTF8Encoding $false))
        if (-not (Get-Service $d.Id -ErrorAction SilentlyContinue)) { Invoke-Native $exe @('install') | Out-Null }
        $change = Get-CimInstance Win32_Service -Filter "Name = '$($d.Id)'" | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
        if ($change.ReturnValue -ne 0) { throw "$($d.Id): the service account could not be set to LocalService ($($change.ReturnValue))" }
        if ($d.ContainsKey('Start') -and -not $d.Start) { Note "$($d.Id): installed, not started (its settings are unfinished: step 4b)" } else { Start-Service $d.Id }
    }
}
if (-not $DryRun) {
    for ($i = 0; $i -lt 20 -and (Test-Http 'http://127.0.0.1:8090/api/me') -ne '200'; $i++) { Start-Sleep -Seconds 1 }
    Note ('h9web ' + (Get-ServiceState 'havoc9-h9web') + ', HTTP ' + (Test-Http 'http://127.0.0.1:8090/api/me'))
    Note ('list  ' + (Get-ServiceState 'havoc9-serverlist') + ', HTTP ' + (Test-Http 'http://127.0.0.1:8081/v1/servers/ts'))
    Note ('Caddy ' + (Get-ServiceState 'havoc9-caddy'))
    if ($firstKeys -and (Test-Path -LiteralPath (Join-Path $H9Data 'secrets.json'))) { Warn "h9web made new keys: copy $H9Data\secrets.json and $H9Data\data.key somewhere safe and offline NOW (README-WINDOWS.txt step 6)" }
}

Say '9. backups and log cleanup (scheduled tasks, LocalService)'
$svc = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCALSERVICE' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$cli = "`"$Node`" `"$H9web\bin\h9web-backup.js`" --config `"$Config`""
$tasks = @(
    @{ Name = 'havoc9 h9web backup'; At = '03:30'; Line = "$cli backup --out `"$H9Data\backups`" --keep 14 >> `"$Logs\backup.log`" 2>&1"; On = $true },
    @{ Name = 'havoc9 h9web backup offsite'; At = '03:45'; Line = "$cli backup --encrypt --with-keys --passphrase-file `"$Passphrase`" --out `"$H9Data\offsite`" --keep 7 >> `"$Logs\backup.log`" 2>&1"; On = (Test-Path -LiteralPath $Passphrase) },
    @{ Name = 'havoc9 log cleanup'; At = '04:00'; Line = "forfiles /p `"$Logs`" /m *.log /d -30 /c `"cmd /c del @path`" 2>nul & exit /b 0"; On = $true }
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
    Say '10. the firewall'
    $rules = @(@{ Name = 'havoc9 web (Caddy, TCP 80 and 443)'; Proto = 'TCP'; Ports = @('80', '443') })
    foreach ($g in $GamePorts) {
        $parts = $g.Split('/')
        $rules += @{ Name = "havoc9 game server ($g)"; Proto = $parts[1].ToUpper(); Ports = @($parts[0]) }
    }
    if ($P2P) { $rules += @{ Name = "havoc9 p2p relay (UDP $P2PPort)"; Proto = 'UDP'; Ports = @([string]$P2PPort) } }
    foreach ($r in $rules) {
        if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) { Note "$($r.Name): there"; continue }
        Step "firewall rule '$($r.Name)'" { New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol $r.Proto -LocalPort $r.Ports -Action Allow -Profile Any | Out-Null }
    }
    Note 'h9web and the list listen on 127.0.0.1 only: no rule needed for them'
}

Say 'done'
Note "site     https://$Domain/  (Caddy makes the certificate once DNS points here and ports 80 and 443 reach this machine)"
Note "check    .\setup.ps1 -Check"
Note "next     README-WINDOWS.txt: the first admin (step 6), the game servers and the list (step 7), backups (step 8)"
foreach ($w in $Warnings) { Write-Host "  [WARN] $w" -ForegroundColor Yellow }
exit 0

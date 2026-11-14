<#
.SYNOPSIS
  Packs havoc9.org for a host: dist\havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip (vps\linux\setup.sh)
  and dist\havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip (vps\windows\setup.ps1).

.DESCRIPTION
  Each ZIP has one folder in it, named like the ZIP (havoc9-vps-<target>-<build>-<yyyyMMdd-HHmm>\), holding:
    linux:    README-VPS.txt, setup.sh, systemd\, hardening\      from vps\linux\
    windows:  README-WINDOWS.txt, setup.ps1, setup.cmd,
              Caddyfile.template                                  from vps\windows\
    both:
      h9web\            h9web's code: server.js, package.json, lib, bin, modules, the README
                        and the two example configs; never data\, config.json, servers.json,
                        tests, backups or the Windows scripts
      havoc9.org\       the site, with deploy\ (the nginx and certificate scripts); never
                        backups (*.bak*), archives (*.zip) or dot files
      serverlist-bot\   the list's code, requirements.txt, README.md, serverlist.ini,
                        servers.txt, serverlist.cfg.example and blacklisted.ini.example; never
                        serverlist.cfg (the Discord token and heartbeat key), blacklisted.ini or its log
      p2p\              the P2P relay: the service's code (lib\ without the helper, bin\h9rv.js),
                        package.json, README.txt, the examples of its settings and of its host
                        list, run.sh, run.bat and its systemd unit; never hosts.json or
                        relay.config.json (its settings and its hosts' token hashes), the
                        helper or the tests
      BUILD.txt         the build, the time and the commit it was packed from, never a folder of this PC
  Only files picked by name and kind go in. Last, each staged tree is scanned: a secret's file
  name (secrets.json, data.key, serverlist.cfg, ts_advertise.cfg, hosts.json and
  relay.config.json of the relay, a database, a key or certificate, a backup) or a secret's
  content (a Discord bot token or webhook URL, a private key, a filled-in heartbeat_key,
  discord_token, password pepper or player id key, a P2P host token or the hash of one) stops
  the run before a ZIP is written. The values found are never printed.

  The build comes from VERSION.txt beside this script ("Build: ..."), with the time it was
  packed: havoc9-vps-linux-1.54-lift6-20261102-0130.zip. The sources are only read.

  With -WebClient, the web client's files go in a third ZIP, havoc9-vps-webclient-<build>-<yyyyMMdd-HHmm>.zip:
  webclient-build\stage (about 1.2 GB, made by export.bat or tools\make_webclient_game.py) and
  tools\make_webclient_game.py, laid out for either package (README-VPS.txt and
  README-WINDOWS.txt, step 12). A stage file that never ships (an id, a secret, a game server's
  settings, a config.cfg) stops the run before that ZIP is written; the one config.cfg let through is
  TS 3.0's own, at game/ts/config.cfg, when it is byte for byte reTS\game\ts\config.cfg.

.PARAMETER Target
  all (the default), linux or windows.

.PARAMETER OutDir
  Where the ZIPs and the reports go. Default: dist beside this script (git ignores it).

.PARAMETER WebClient
  Also pack the web client's files.

.PARAMETER KeepStage
  Keep the staged folders after zipping, to look through them.

.EXAMPLE
  .\make-vps-package.ps1
  .\make-vps-package.ps1 -Target windows
  .\make-vps-package.ps1 -WebClient
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'linux', 'windows')][string]$Target = 'all',
    [string]$OutDir,
    [switch]$WebClient,
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Say([string]$text) { Write-Host $text }
function Fail([string]$text) { Write-Host "[FAIL] $text" -ForegroundColor Red; exit 1 }

$Targets = @('linux', 'windows')
if ($Target -ne 'all') { $Targets = @($Target) }
$Own = @{
    linux = @(@('vps\linux\README-VPS.txt', 'README-VPS.txt'), @('vps\linux\setup.sh', 'setup.sh'), @('vps\linux\systemd', 'systemd'), @('vps\linux\hardening', 'hardening'))
    windows = @(@('vps\windows\README-WINDOWS.txt', 'README-WINDOWS.txt'), @('vps\windows\setup.ps1', 'setup.ps1'), @('vps\windows\setup.cmd', 'setup.cmd'),
                @('vps\windows\Caddyfile.template', 'Caddyfile.template'))
}
# the relay's files, picked by name: its service, never the helper, the tests or a real config
$P2pFiles = @('lib\service.js', 'lib\wire.js', 'lib\codes.js', 'lib\limits.js', 'lib\auth.js', 'lib\config.js', 'bin\h9rv.js', 'package.json', 'README.txt',
              'relay.config.example.json', 'hosts.example.json', 'relay.site.ini.example', 'run.sh', 'run.bat', 'h9-p2p.service.example')
$need = @('h9web\server.js', 'h9web\bin\h9web-backup.js', 'havoc9.org\index.html', 'havoc9.org\deploy\nginx-setup.sh', 'serverlist-bot\h9_serverlist.py')
foreach ($f in $P2pFiles) { $need += "p2p\$f" }
foreach ($t in $Targets) { foreach ($pair in $Own[$t]) { $need += $pair[0] } }
foreach ($n in $need) { if (-not (Test-Path -LiteralPath (Join-Path $Root $n))) { Fail "$n is missing beside this script ($Root)" } }

# A clone made without Git LFS holds pointer files in place of maps, models and archives: what this
# packs is checked first (tools\check-lfs.ps1, docs\BUILDING.txt), the web client's stage with it.
$lfsCheck = Join-Path $Root 'tools\check-lfs.ps1'
if (-not (Test-Path -LiteralPath $lfsCheck)) { Fail "tools\check-lfs.ps1 is missing beside this script ($Root)" }
$lfsPaths = @('h9web', 'havoc9.org', 'serverlist-bot', 'p2p', 'vps') | ForEach-Object { Join-Path $Root $_ }
if ($WebClient) { $lfsPaths += Join-Path $Root 'webclient-build\stage' }
& $lfsCheck -Path $lfsPaths
if ($LASTEXITCODE -ne 0) { Fail 'files this packs are Git LFS pointers or cut short (listed above); no ZIP was written' }

$build = 'dev'
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path -LiteralPath $versionFile) {
    $m = [regex]::Match([IO.File]::ReadAllText($versionFile), '(?m)^\s*Build:\s*(\S+)')
    if ($m.Success) { $build = $m.Groups[1].Value }
}
$build = ($build -replace '[^A-Za-z0-9._-]', '-')
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmm')
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('havoc9-vps-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# Leaves out what never belongs on a host, whatever folder it is in.
$SkipFile = '(\.bak|\.orig$|\.rej$|\.tmp$|\.log$|~$|\.zip$|\.7z$|^Thumbs\.db$|^desktop\.ini$|^\.)'
$SkipDir = '^(\.git|\.vs|node_modules|__pycache__|data|test)$'

function Copy-One([string]$from, [string]$to, $list, [string]$stage) {
    $dir = Split-Path -Parent $to
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $from -Destination $to -Force
    $list.Add($to.Substring($stage.Length + 1))
}

function Copy-Tree([string]$from, [string]$to, $list, [string]$stage) {
    foreach ($item in Get-ChildItem -LiteralPath $from -Force) {
        if ($item.PSIsContainer) {
            if ($item.Name -match $SkipDir) { continue }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            Copy-Tree $item.FullName (Join-Path $to $item.Name) $list $stage
        } else {
            if ($item.Name -match $SkipFile) { continue }
            Copy-One $item.FullName (Join-Path $to $item.Name) $list $stage
        }
    }
}

# entries: { Src = <file>; Entry = <path in the ZIP, with /> }
function Write-Zip([string]$zipPath, $entries, [string]$level) {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($e in $entries) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $e.Src, $e.Entry, [IO.Compression.CompressionLevel]::$level)
        }
    } finally {
        $zip.Dispose()
    }
}

# TS 3.0's own config.cfg, as the SHA-256 of the copy tools\make_webclient_game.py takes the stage's from
# (reTS\game\ts beside this script, else ts3.0\ts); $null when neither is there.
function Get-StockConfigHash([string]$Base) {
    foreach ($c in @('reTS\game\ts\config.cfg', 'ts3.0\ts\config.cfg')) {
        $p = Join-Path $Base $c
        if (Test-Path -LiteralPath $p) { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
    }
    return $null
}

# True for a web client stage file that must never be served, which stops the web client ZIP: an id, a
# secret, a game server's settings, or a config.cfg. The one config.cfg that may ship is TS 3.0's own,
# which tools\make_webclient_game.py puts in the stage at game/ts/config.cfg for a new player to start
# from: it passes only at that path and only when it is byte for byte the stock file ($StockHash, from
# Get-StockConfigHash). Any other config.cfg, or a changed one, is refused.
function Test-StageFileRefused([IO.FileInfo]$File, [string]$Rel, [string]$StockHash) {
    if ($File.Name -notmatch '^(ts_advertise.*|\.xash_id|user_id\.ini|device_id\.ini|.*_resolved\.cfg|config\.cfg|secrets\.json|serverlist\.cfg)$') { return $false }
    if ($Rel -ceq 'game/ts/config.cfg' -and $StockHash -and (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash -eq $StockHash) { return $false }
    return $true
}

# Where the package was packed from, for BUILD.txt and the report, which the host ZIPs carry to the public
# file index: never a folder of this PC. The checkout's commit and branch when it is a git checkout (a .git
# of its own beside this script), else only that it is a checkout of the repository.
function Get-SourceText([string]$Dir) {
    $plain = 'a checkout of the repository'
    if (-not (Test-Path -LiteralPath (Join-Path $Dir '.git'))) { return $plain }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $commit = [string]@(& git -C $Dir rev-parse --short HEAD 2>$null)[0]
        if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{4,40}$') { return $plain }
        $branch = [string]@(& git -C $Dir rev-parse --abbrev-ref HEAD 2>$null)[0]
        if ($LASTEXITCODE -ne 0 -or $branch -notmatch '^[A-Za-z0-9._/-]+$' -or $branch -eq 'HEAD') { return "commit $commit of the repository" }
        return "commit $commit on branch $branch of the repository"
    } catch {
        return $plain
    } finally {
        $ErrorActionPreference = $saved
    }
}

$BadName = '^(secrets\.json|data\.key|serverlist\.cfg|blacklisted\.ini|ts_advertise\.cfg|backup-passphrase.*|\.env|id_rsa.*|id_ed25519.*|id_ecdsa.*)$|\.(db|db-wal|db-shm|db-journal|sqlite3?|h9backup|pem|key|p12|pfx|crt|ppk)$'
$TextExt = '\.(js|mjs|cjs|json|html|htm|css|txt|md|ini|cfg|sh|ps1|cmd|py|service|timer|conf|example|template|xml|svg)$|^[^.]+$'
$Hard = @(
    @{ Why = 'a Discord bot token'; Rx = [regex]'[MNO][A-Za-z\d_\-]{23,27}\.[A-Za-z\d_\-]{6}\.[A-Za-z\d_\-]{27,40}' },
    @{ Why = 'a Discord webhook URL'; Rx = [regex]'discord(?:app)?\.com/api/webhooks/\d+/[\w\-]+' },
    @{ Why = 'a private key'; Rx = [regex]'-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    @{ Why = 'a filled-in heartbeat_key or discord_token'; Rx = [regex]'(?m)^[ \t]*(heartbeat_key|discord_token)[ \t]*=[ \t]*[^\s;#<]' },
    @{ Why = "h9web's password pepper or player id key"; Rx = [regex]'"(passwordPepper|playerIdKey)"\s*:\s*"[A-Za-z0-9+/=]{16,}"' },
    @{ Why = 'a filled-in client secret or bot token'; Rx = [regex]'"(clientSecret|botToken|client_secret|bot_token)"\s*:\s*"[^"]{8,}"' },
    @{ Why = 'a P2P host token'; Rx = [regex]'h9t_[A-Za-z0-9_\-]{30,}' }
)
# only in the relay's own files: the hash of a P2P host token, which is what a filled-in hosts file holds
$P2pHard = @{ Why = 'the hash of a P2P host token (a filled-in hosts file)'; Rx = [regex]'sha256:[0-9a-fA-F]{64}' }
$Latin1 = [Text.Encoding]::GetEncoding(28591)
$made = @()
$Source = Get-SourceText $Root

$step = 0
foreach ($t in $Targets) {
    $step++
    $Name = "havoc9-vps-$t-$build-$Stamp"
    $Stage = Join-Path $Temp $Name
    $copied = New-Object System.Collections.Generic.List[string]
    Say "$step. $Name"
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    foreach ($pair in $Own[$t]) {
        $from = Join-Path $Root $pair[0]
        if (Test-Path -LiteralPath $from -PathType Container) { Copy-Tree $from (Join-Path $Stage $pair[1]) $copied $Stage }
        else { Copy-One $from (Join-Path $Stage $pair[1]) $copied $Stage }
    }
    $h9web = Join-Path $Root 'h9web'
    foreach ($f in @('server.js', 'package.json', 'README.txt', 'config.example.json', 'servers.example.json')) { Copy-One (Join-Path $h9web $f) (Join-Path $Stage "h9web\$f") $copied $Stage }
    foreach ($d in @('lib', 'bin', 'modules')) { Copy-Tree (Join-Path $h9web $d) (Join-Path $Stage "h9web\$d") $copied $Stage }
    Copy-Tree (Join-Path $Root 'havoc9.org') (Join-Path $Stage 'havoc9.org') $copied $Stage
    $list = Join-Path $Root 'serverlist-bot'
    foreach ($f in @('h9_serverlist.py', 'requirements.txt', 'README.md', 'serverlist.ini', 'servers.txt', 'serverlist.cfg.example', 'blacklisted.ini.example')) {
        Copy-One (Join-Path $list $f) (Join-Path $Stage "serverlist-bot\$f") $copied $Stage
    }
    foreach ($f in $P2pFiles) { Copy-One (Join-Path $Root "p2p\$f") (Join-Path $Stage "p2p\$f") $copied $Stage }
    $guide = 'README-VPS.txt'; if ($t -eq 'windows') { $guide = 'README-WINDOWS.txt' }
    $buildText = @("havoc9.org $t host package ($guide)", '', "Build:   $build", ('Packed:  ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')),
                   "Source:  $Source", ('Files:   ' + ($copied.Count + 1))) -join "`n"
    [IO.File]::WriteAllText((Join-Path $Stage 'BUILD.txt'), $buildText + "`n", (New-Object Text.UTF8Encoding $false))
    $copied.Add('BUILD.txt')
    Say ("  {0} files staged" -f $copied.Count)

    $found = New-Object System.Collections.Generic.List[string]
    foreach ($rel in $copied) {
        $leaf = Split-Path -Leaf $rel
        if ($leaf -match $BadName) { $found.Add("$rel (a secret's file name)"); continue }
        if ($rel -match '^h9web\\(config|servers)\.json$') { $found.Add("$rel (a real config)"); continue }
        if ($rel -match '^p2p\\(hosts|relay\.config)\.json$') { $found.Add("$rel (a real config)"); continue }
        if ($leaf -notmatch $TextExt) { continue }
        $text = $Latin1.GetString([IO.File]::ReadAllBytes((Join-Path $Stage $rel)))
        foreach ($h in $Hard) { if ($h.Rx.IsMatch($text)) { $found.Add("$rel ($($h.Why))") } }
        if ($rel -like 'p2p\*' -and $P2pHard.Rx.IsMatch($text)) { $found.Add("$rel ($($P2pHard.Why))") }
    }
    if ($found.Count -gt 0) {
        foreach ($f in $found) { Write-Host "  [STOP] $f" -ForegroundColor Red }
        Remove-Item -LiteralPath $Temp -Recurse -Force
        Fail ('the scan found ' + $found.Count + ' secret(s) above; no ZIP was written. Take them out of the sources and pack again.')
    }
    Say '  scan: no secret files, tokens, webhooks, private keys or filled-in keys'

    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $zipPath = Join-Path $OutDir ($Name + '.zip')
    $entries = $copied | Sort-Object | ForEach-Object { [pscustomobject]@{ Src = (Join-Path $Stage $_); Entry = ($Name + '/' + ($_ -replace '\\', '/')) } }
    Write-Zip $zipPath $entries 'Optimal'
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    $size = (Get-Item -LiteralPath $zipPath).Length
    Say ("  {0} ({1:N1} MB), SHA-256 {2}" -f $zipPath, ($size / 1MB), $hash)
    $report = @("$Name.zip", "SHA-256: $hash", "Size:    $size bytes", $buildText, '', 'Scan: clean', '', 'Files:') + ($copied | Sort-Object | ForEach-Object { '  ' + $_ })
    [IO.File]::WriteAllText((Join-Path $OutDir ($Name + '.report.txt')), (($report -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
    $made += $zipPath
}

if ($WebClient) {
    $step++
    $Name = "havoc9-vps-webclient-$build-$Stamp"
    Say "$step. $Name"
    $stageDir = Join-Path $Root 'webclient-build\stage'
    $tool = Join-Path $Root 'tools\make_webclient_game.py'
    if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'manifest.json'))) { Fail "no $stageDir\manifest.json: build the web client first with build-webclient.cmd (docs\BUILDING.txt section 9)" }
    if (-not (Test-Path -LiteralPath $tool)) { Fail "no $tool" }
    $entries = New-Object System.Collections.Generic.List[object]
    $entries.Add([pscustomobject]@{ Src = $tool; Entry = "$Name/tools/make_webclient_game.py" })
    $stockHash = Get-StockConfigHash $Root
    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($f in Get-ChildItem -LiteralPath $stageDir -Recurse -File -Force) {
        $rel = $f.FullName.Substring($stageDir.Length + 1) -replace '\\', '/'
        if (Test-StageFileRefused $f $rel $stockHash) { $bad.Add($rel) }
        $entries.Add([pscustomobject]@{ Src = $f.FullName; Entry = "$Name/webclient-build/stage/$rel" })
    }
    if ($bad.Count -gt 0) {
        foreach ($x in $bad) { Write-Host "  [STOP] $x" -ForegroundColor Red }
        if ($bad -contains 'game/ts/config.cfg') { Write-Host "  game/ts/config.cfg ships only as TS 3.0's own, byte for byte: reTS\game\ts\config.cfg, else ts3.0\ts\config.cfg" }
        Fail 'the web client stage holds files that never ship; no web client ZIP was written'
    }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $wcZip = Join-Path $OutDir ($Name + '.zip')
    Write-Zip $wcZip $entries 'Fastest'
    Say ("  {0} ({1:N0} MB, {2} files)" -f $wcZip, ((Get-Item -LiteralPath $wcZip).Length / 1MB), $entries.Count)
    $made += $wcZip
}

if ($KeepStage) { Say "the staged folders stay: $Temp" } elseif (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
Say 'done:'
foreach ($z in $made) { Say "  $z" }
Say '  Linux: unzip, cd into the folder, sudo bash setup.sh (README-VPS.txt).'
Say '  Windows: Extract All, right-click setup.cmd, Run as administrator (README-WINDOWS.txt).'
exit 0

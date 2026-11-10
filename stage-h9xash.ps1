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
    - ts\config.cfg from TS 3.0: H9XASH\ts\config.stock.cfg, or reTS\game\ts or ts3.0\ts
      beside H9XASH;
    - networking.ini from the overlay template (xash3d-h9-patches\overlay);
    - tempdecal.wad from TS 3.0, when there is one.
  Every config-like file left (.cfg .ini .lst .rc .json) is then scrubbed line by line:
  a line is removed when it sets a password, key, token, secret or player id, holds a
  SteamID, or holds a public IP address. The removed values are never printed.
  Last, the whole staged tree is scanned again. A Discord token, a webhook URL or a
  private key anywhere in it stops the run before a ZIP is written.
  H9XASH itself is only read, never changed.

  One run writes two packages, each in its own ZIP, from the same scrubbed stage:
    - dist\H9XASH.zip for Windows players: every file of H9XASH except the Linux-only ones
      (h9xash.sh, h9_userid.sh, README_LINUX.txt, *.so);
    - dist\H9XASH-linux.zip for Linux players, with one H9XASH\ folder in it. Python's zipfile
      (through the py launcher) writes it as a Unix ZIP: the .sh files and every ELF binary at
      mode 0755, the .sh files with LF line ends, which unzip and Linux archive managers give
      back.
  What the Linux ZIP holds depends on whether a native Linux build exists. A native build is a
  folder laid out like H9XASH, H9XASH-linux beside this script or the one -LinuxNative names,
  with the xash3d client in it (xash3d, libxash.so, ts\dlls\ts_i386.so, h9xash.sh ...). Then
  the ZIP is native: the game's data from H9XASH with the build's files laid over it, and no
  .exe .dll .bat .cmd .ps1, no WebView2 folder and none of H9XASH's stock Linux .so files (the
  build brings its own); the read-back refuses a Windows file in it. A build with only xashds
  (the dedicated server) also gives dist\H9XASH-linux-server.zip the same way, and the players'
  Linux ZIP stays the Wine/Proton package. With no native build the Linux ZIP is that Wine/Proton
  package: the Windows game plus h9xash.sh, h9_userid.sh and README_LINUX.txt (from xash3d-h9-
  patches\overlay when H9XASH has none yet), run under Wine or Proton; the run warns about it.
  Without Python 3 the Wine package keeps no file modes (its players start it with "bash
  h9xash.sh") and a native package is not made. Left out of every package: a Wine prefix kept
  inside H9XASH (drive_c, dosdevices, its .reg files), the MOTD web view's webview2\data and
  webview2\runtime folders, and .gitattributes.

  H9XASH.zip and H9XASH-linux.zip are the names havoc9.org's downloads page links to: both
  go in the site's downloads folder. The run warns when that page (havoc9.org\downloads\
  index.html beside this script) does not link them or shows another build.

  Unless -NoWebFiles is given, the same staged tree is published for H9XASH-Updater too
  (tools\updater\publish_files.py, through the py launcher), into -FilesDir: manifest.json,
  the build and every file's path, size, SHA-256 and mode, and each distinct file once,
  named by its SHA-256. havoc9.org serves that folder as /files/, and the updater downloads
  only the files a player's folder lacks or has changed. The files a new player starts from
  (the stock config.cfg, networking.ini and tempdecal.wad above) go in as seeds, which the
  updater puts only where a player has none. Files neither this release nor the one before
  it names are removed. Copy the folder to the site's files/ (tools\updater\
  README_UPDATER.txt, section 3).

  The same packages are built on Linux by stage-h9xash.sh, which starts stage_h9xash.py: a
  Python 3.8 port of this script (standard library only; it runs on Windows too). It follows
  the rules above in the same order and writes the same ZIPs, report and web files; its
  options are the parameters below as --dry-run, --linux-native DIR and so on. A rule changed
  here is changed there as well: stage_h9xash_test.py builds a small fake H9XASH, runs both
  scripts on it and compares the ZIPs, the staged files, the report and the stop conditions.

.PARAMETER Source
  The H9XASH folder to pack. Default: H9XASH beside this script.

.PARAMETER OutDir
  Where the two ZIPs and the report go. Default: dist beside this script (git ignores it).

.PARAMETER StageDir
  Where the temporary copy is built before zipping (about 1.3 GB). Default: .stage inside
  OutDir, on the output's own drive; never %TEMP%, which is usually on C:.

.PARAMETER Name
  The ZIP's file name without .zip. Default: H9XASH, the name the downloads page links;
  the Linux package is <Name>-linux.zip. The build, read from VERSION.txt beside H9XASH,
  is in the report.

.PARAMETER AllowIp
  Public IP addresses that may stay in config files (a master server, say).

.PARAMETER DryRun
  Stage and scrub, write the report, keep the staged folder, but make no ZIP and no
  Linux package. The report lists what each package leaves out.

.PARAMETER KeepStage
  Keep the staged folder after zipping, to test-play it first.

.PARAMETER Compression
  Optimal (default) or Fastest.

.PARAMETER NoLinux
  Make the Windows ZIP only, no Linux package.

.PARAMETER LinuxNative
  The native Linux build: a folder laid out like H9XASH (see the description). Default:
  H9XASH-linux beside this script. Missing, or without xash3d, the Linux ZIP is the
  Wine/Proton package.

.PARAMETER FilesDir
  Where the web files for H9XASH-Updater go. Default: dist\files beside this script (git
  ignores it).

.PARAMETER NoWebFiles
  Publish no web files for H9XASH-Updater.

.EXAMPLE
  .\stage-h9xash.ps1
  .\stage-h9xash.ps1 -DryRun
  .\stage-h9xash.ps1 -Source D:\Downloads\TSM\H9XASH -KeepStage
  .\stage-h9xash.ps1 -NoLinux
  .\stage-h9xash.ps1 -LinuxNative D:\build\H9XASH-linux
  .\stage-h9xash.ps1 -NoWebFiles
  ./stage-h9xash.sh --dry-run        (Linux; the options are written --dry-run, --no-linux ...)
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string]$OutDir,
    [string]$StageDir,
    [string]$Name,
    [string[]]$AllowIp = @(),
    [switch]$DryRun,
    [switch]$KeepStage,
    [switch]$NoLinux,
    [string]$LinuxNative,
    [string]$FilesDir,
    [switch]$NoWebFiles,
    [ValidateSet('Optimal', 'Fastest')][string]$Compression = 'Optimal'
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param defaults, so the defaults are set here.
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path $Here 'H9XASH' }
if (-not $OutDir) { $OutDir = Join-Path $Here 'dist' }
if (-not $StageDir) { $StageDir = Join-Path $OutDir '.stage' }
if (-not $FilesDir) { $FilesDir = Join-Path $OutDir 'files' }
if (-not $LinuxNative) { $LinuxNative = Join-Path $Here 'H9XASH-linux' }

# ---- rules ----------------------------------------------------------------------------

# Folders left out wherever they are.
$SkipDirNames = @('logs', 'save', 'screenshots', 'scrshots', 'ts_downloads', 'downloads',
    '.fontcache', 'userconfig.d', '__pycache__', '.venv', 'venv', '.git', 'node_modules')
# Folders left out at this path under H9XASH. Each is made again, empty, when $RecreateDirs lists it.
# webview2\data is the splash MOTD's embedded browser's own files; webview2\runtime a player's own WebView2 runtime.
$SkipDirPaths = @('presets\backup', 'ts\addons\amxmodx\data\vault', 'webview2\data', 'webview2\runtime')
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
# A Wine prefix someone keeps inside H9XASH (its drive_c and dosdevices folders and its
# registry files), and git's attribute file: never in a package.
$SkipDirNames += @('drive_c', 'dosdevices')
# H9XASH-Updater's own folder in an install it keeps (tools\updater): its record of the
# installed files, its log, and the previous files it keeps for a rollback.
$SkipDirNames += @('.h9xash-updater')
$SkipNames += @('.gitattributes', 'system.reg', 'user.reg', 'userdef.reg', '.update-timestamp')

# Files a new player gets from a stock source instead. Relative to H9XASH, then the candidates
# relative to the folder H9XASH sits in.
$Replacements = @(
    @{ At = 'ts\config.cfg'; From = @('H9XASH\ts\config.stock.cfg', 'reTS\game\ts\config.cfg', 'ts3.0\ts\config.cfg'); Fallback = 'scrub' },
    @{ At = 'networking.ini'; From = @('xash3d-h9-patches\overlay\networking.ini'); Fallback = 'scrub' },
    @{ At = 'ts\tempdecal.wad'; From = @('reTS\game\ts\tempdecal.wad', 'ts3.0\ts\tempdecal.wad'); Fallback = 'drop' }
)

# Files that must reach the ZIP whenever H9XASH has them.
$Essentials = @('HAVOC 9.exe', 'xash.dll', 'menu.dll', 'ref_gl.dll', 'SDL2.dll', 'filesystem_stdio.dll',
    'h9xash.bat', 'h9_userid.ps1', 'h9_networking.ps1', 'enter_userid.cmd',
    'ts\liblist.gam', 'ts\gameinfo.txt', 'ts\delta.lst', 'ts\dlls\mp.dll', 'ts\cl_dlls\client.dll',
    'ts\autoexec.cfg', 'ts\userconfig.cfg', 'ts\addons\metamod\plugins.ini',
    'ts\addons\amxmodx\configs\plugins.ini', 'ts\addons\amxmodx\configs\amxx.cfg')
# The Linux launcher, its id tool and their README (README_LINUX.txt), in H9XASH from the overlay.
$LinuxFiles = @('h9xash.sh', 'h9_userid.sh', 'README_LINUX.txt')
$Essentials += $LinuxFiles

# What only Windows runs and what only Linux runs, by path under H9XASH. The Windows ZIP leaves out the
# second; a native Linux package leaves out both (the build brings its own Linux files); the Wine/Proton
# package keeps both. A DLL's .patch note goes with the DLL, a .so's with the .so.
$WindowsOnlyExt = @('.exe', '.dll', '.bat', '.cmd', '.ps1', '.pdb', '.lib', '.exp')
$WindowsOnlyDirPaths = @('webview2')
$WindowsOnlyPatterns = @('\.(exe|dll)\.patch$')
$LinuxOnlyNames = @($LinuxFiles | ForEach-Object { $_.ToLowerInvariant() })
$LinuxOnlyPatterns = @('\.so(\.\d+)*$', '\.so(\.\d+)*\.patch$')

# Config-like files are scrubbed line by line; every text file is scanned for hard secrets.
$ConfigExt = @('.cfg', '.ini', '.lst', '.rc', '.json')
$TextExt = @('.cfg', '.ini', '.lst', '.rc', '.json', '.txt', '.md', '.htm', '.html', '.xml', '.yml', '.yaml',
    '.csv', '.bat', '.cmd', '.ps1', '.py', '.sma', '.inc', '.gam', '.example', '.pem', '.url', '.js', '.res')
$TextExt += @('.sh')

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
# The Linux packages' writer, run through the py launcher: the staged H9XASH folder (less a skip list,
# plus an overlay folder when the build is native) as one H9XASH/ folder in a .zip made as a Unix one --
# folders 0755, files 0644, .sh files and ELF binaries 0755, .sh files with LF line ends, in sorted order --
# then read back and checked against those rules. unzip and Linux archive managers give the modes back.
$LinuxZipPy = @'
import os, shutil, stat, sys, time, zipfile

# usage: make_linux_zip.py STAGE OUT [--skip LISTFILE] [--overlay DIR] [--no-windows]
#   STAGE      the staged H9XASH folder
#   OUT        the .zip to write
#   --skip     a text file of paths (relative to STAGE, with /) left out of the package
#   --overlay  a folder laid out like H9XASH whose files go in on top of the staged ones
#   --no-windows  the read-back refuses any .exe .dll .bat .cmd .ps1 in the package
args = sys.argv[1:]
stage, out = args[0], args[1]
skip_file = None
overlay = None
no_windows = False
i = 2
while i < len(args):
    if args[i] == '--skip':
        skip_file = args[i + 1]
        i += 2
    elif args[i] == '--overlay':
        overlay = args[i + 1]
        i += 2
    elif args[i] == '--no-windows':
        no_windows = True
        i += 1
    else:
        sys.exit('unknown argument ' + args[i])

part = out + '.part'
top = 'H9XASH'
skip = set()
if skip_file:
    with open(skip_file, encoding='utf-8') as fh:
        skip = set(line.rstrip('\r\n') for line in fh if line.strip())

files = {}
dirs = set([''])


def add_dirs(rel):
    parts = rel.split('/')[:-1]
    for n in range(1, len(parts) + 1):
        dirs.add('/'.join(parts[:n]))


def walk(base, skipping):
    for root, dnames, fnames in os.walk(base):
        dnames.sort()
        fnames.sort()
        rel_root = os.path.relpath(root, base).replace(os.sep, '/')
        if rel_root == '.':
            rel_root = ''
        if rel_root and not dnames and not fnames:
            dirs.add(rel_root)
        for f in fnames:
            rel = rel_root + '/' + f if rel_root else f
            if skipping and rel in skip:
                continue
            files[rel] = os.path.join(root, f)
            add_dirs(rel)


walk(stage, True)
staged = len(files)
over_added = 0
over_replaced = 0
if overlay:
    before = dict(files)
    walk(overlay, False)
    over_replaced = sum(1 for r, p in before.items() if files[r] != p)
    over_added = len(files) - len(before)

now = time.time()


def entry(name, mode, mtime):
    when = time.localtime(mtime)[:6]
    if when[0] < 1980:
        when = (1980, 1, 1, 0, 0, 0)
    zi = zipfile.ZipInfo(name, when)
    zi.create_system = 3
    zi.external_attr = mode << 16
    if stat.S_ISDIR(mode):
        zi.external_attr |= 0x10
    else:
        zi.compress_type = zipfile.ZIP_DEFLATED
    return zi


count = {'dirs': 0, 'files': 0, 'sh': 0, 'elf': 0}
with zipfile.ZipFile(part, 'w', zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=6) as zf:
    for d in sorted(dirs):
        arc = top + '/' + d + '/' if d else top + '/'
        zf.writestr(entry(arc, stat.S_IFDIR | 0o755, now), b'')
        count['dirs'] += 1
    for rel in sorted(files):
        p = files[rel]
        st = os.stat(p)
        arc = top + '/' + rel
        with open(p, 'rb') as fh:
            head = fh.read(4)
        if rel.lower().endswith('.sh'):
            with open(p, 'rb') as fh:
                data = fh.read().replace(b'\r\n', b'\n')
            zf.writestr(entry(arc, stat.S_IFREG | 0o755, st.st_mtime), data)
            count['sh'] += 1
        else:
            elf = head == b'\x7fELF'
            zi = entry(arc, stat.S_IFREG | (0o755 if elf else 0o644), st.st_mtime)
            with open(p, 'rb') as fh, zf.open(zi, 'w', force_zip64=st.st_size > 0x7fffffff) as dst:
                shutil.copyfileobj(fh, dst, 1 << 20)
            if elf:
                count['elf'] += 1
        count['files'] += 1

problems = []
windows_ext = ('.exe', '.dll', '.bat', '.cmd', '.ps1')
with zipfile.ZipFile(part) as zf:
    infos = zf.infolist()
    for zi in infos:
        if not zi.filename.startswith(top + '/'):
            problems.append('outside H9XASH/: ' + zi.filename)
        if zi.create_system != 3:
            problems.append('not a Unix entry: ' + zi.filename)
        if zi.is_dir():
            continue
        mode = (zi.external_attr >> 16) & 0o777
        low = zi.filename.lower()
        if low.endswith('.sh'):
            if mode != 0o755:
                problems.append('mode %o: %s' % (mode, zi.filename))
            if b'\r' in zf.read(zi):
                problems.append('a CR in ' + zi.filename)
        elif zi.file_size >= 4:
            with zf.open(zi) as fh:
                if fh.read(4) == b'\x7fELF' and mode != 0o755:
                    problems.append('a binary at mode %o: %s' % (mode, zi.filename))
        if no_windows and low.endswith(windows_ext):
            problems.append('a Windows file in a native package: ' + zi.filename)
    bad = zf.testzip()
    if bad:
        problems.append('bad CRC: ' + bad)
if len(infos) != count['dirs'] + count['files']:
    problems.append('%d entries read back, %d written' % (len(infos), count['dirs'] + count['files']))
if problems:
    print('STOPPED: ' + '; '.join(problems[:10]))
    os.remove(part)
    sys.exit(1)
os.replace(part, out)
line = '%d files in %d folders, all under H9XASH/' % (count['files'], count['dirs'])
if overlay:
    line += '; %d from the native build folder, %d of them over staged files' % (over_added + over_replaced, over_replaced)
line += '; %d .sh file(s) and %d binaries at mode 0755; read back and checked' % (count['sh'], count['elf'])
print(line)
'@


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

# Whether a path under H9XASH belongs to one platform only (the rules above).
function Test-WindowsOnly([string]$rel) {
    $low = $rel.ToLowerInvariant()
    foreach ($d in $WindowsOnlyDirPaths) { if ($low -eq $d -or $low.StartsWith($d + '\')) { return $true } }
    $leaf = $low.Split('\')[-1]
    if ($WindowsOnlyExt -contains [IO.Path]::GetExtension($leaf)) { return $true }
    foreach ($rx in $WindowsOnlyPatterns) { if ($leaf -match $rx) { return $true } }
    return $false
}
function Test-LinuxOnly([string]$rel) {
    $leaf = $rel.ToLowerInvariant().Split('\')[-1]
    if ($LinuxOnlyNames -contains $leaf) { return $true }
    foreach ($rx in $LinuxOnlyPatterns) { if ($leaf -match $rx) { return $true } }
    return $false
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

# A clone made without Git LFS holds pointer files in place of the maps, models and archives, and
# the ZIP would ship them: tools\check-lfs.ps1 lists them with the fix (docs\BUILDING.txt).
$lfsCheck = Join-Path $Here 'tools\check-lfs.ps1'
if (-not (Test-Path -LiteralPath $lfsCheck)) { throw "No $lfsCheck beside this script: the game files cannot be checked." }
& $lfsCheck -Path $Source
if ($LASTEXITCODE -ne 0) { throw 'H9XASH holds Git LFS pointers or cut-short game files (listed above); no ZIP was written.' }

$build = 'local'
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path -LiteralPath $versionFile) {
    $vm = Select-String -LiteralPath $versionFile -Pattern '^\s*Build:\s*(\S+)' | Select-Object -First 1
    if ($vm) { $build = $vm.Matches[0].Groups[1].Value }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
if (-not $Name) { $Name = 'H9XASH' }
$zipPath = Join-Path $OutDir "$Name.zip"
$linuxZip = Join-Path $OutDir "$Name-linux.zip"
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

$stageBase = Join-Path ([IO.Path]::GetFullPath($StageDir)) "h9xash-stage-$stamp-$PID"
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

# ---- the Linux package's own files -----------------------------------------------------

$linuxOk = $false
$PyVersion = $null
if (-not $NoLinux) {
    Say ''
    Say '2b. Linux files (h9xash.sh, h9_userid.sh, README_LINUX.txt)'
    $overlay = Join-Path $Root 'xash3d-h9-patches\overlay'
    $linuxOk = $true
    foreach ($lf in $LinuxFiles) {
        $dest = Join-Path $stage $lf
        $ov = Join-Path $overlay $lf
        if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) {
            if (Test-Path -LiteralPath $ov -PathType Leaf) {
                Copy-Item -LiteralPath $ov -Destination $dest -Force
                Say "  $lf <- $ov (H9XASH has none yet; xash.bat assets puts it there)"
            } else {
                Warn "$lf is in neither H9XASH nor the overlay, so there is no Linux package"
                $linuxOk = $false
            }
        } elseif ((Test-Path -LiteralPath $ov -PathType Leaf) -and
            ((Get-FileHash -LiteralPath $dest).Hash -ne (Get-FileHash -LiteralPath $ov).Hash)) {
            Warn "$lf in H9XASH differs from the overlay's; H9XASH's goes out (xash.bat assets brings the overlay's in)"
        }
    }
    # a Windows checkout may have given the .sh files CRLF line ends; bash on Linux needs LF
    $lfFixed = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $stage -Recurse -Force -File -Filter '*.sh' | Where-Object { $_.Extension -ieq '.sh' })) {
        $t = Read-Text $f.FullName
        if ($t.Contains("`r`n")) { Write-Text $f.FullName $t.Replace("`r`n", "`n"); $lfFixed++ }
    }
    Say "  .sh files given LF line ends: $lfFixed"
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            $v = @(& py -3 -c "import sys, zipfile, zlib; print(sys.version.split()[0])")
            if ($LASTEXITCODE -eq 0 -and $v.Count -gt 0) { $PyVersion = [string]$v[0] }
        } catch { $PyVersion = $null }
    }
    if ($linuxOk -and $PyVersion) {
        Say "  the Linux packages are written by Python $PyVersion's zipfile (Unix mode 0755 on the .sh files and the binaries)"
    } elseif ($linuxOk) {
        Say "  no Python 3 through the py launcher: the Wine package keeps no file modes (players run bash h9xash.sh), a native package is not made"
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

# ---- what goes in which package --------------------------------------------------------

Say ''
Say '4b. the two packages'
$stageRels = @($stageFiles | ForEach-Object { $_.FullName.Substring($stage.Length + 1) })
$linuxOnlyRels = @($stageRels | Where-Object { Test-LinuxOnly $_ })
$windowsOnlyRels = @($stageRels | Where-Object { Test-WindowsOnly $_ })

# A native Linux build is a folder laid out like H9XASH (xash3d, libxash.so, ts\dlls\ts_i386.so, a launcher ...).
$LinuxNative = [IO.Path]::GetFullPath($LinuxNative).TrimEnd('\')
$nativeCount = 0
$nativeClient = $false
$nativeServer = $false
if (Test-Path -LiteralPath $LinuxNative -PathType Container) {
    $nativeCount = @(Get-ChildItem -LiteralPath $LinuxNative -Recurse -Force -File).Count
    $nativeClient = Test-Path -LiteralPath (Join-Path $LinuxNative 'xash3d') -PathType Leaf
    $nativeServer = Test-Path -LiteralPath (Join-Path $LinuxNative 'xashds') -PathType Leaf
}
$serverZip = Join-Path $OutDir "$Name-linux-server.zip"
$makeServerZip = $linuxOk -and (-not $nativeClient) -and $nativeServer
$linuxKind = if ($nativeClient) { 'native' } else { 'wine' }

Say ("  Windows package {0}: {1} files, the {2} Linux-only files left out" -f "$Name.zip", ($stageRels.Count - $linuxOnlyRels.Count), $linuxOnlyRels.Count)
if ($NoLinux) {
    Say '  Linux package: none (-NoLinux)'
} elseif (-not $linuxOk) {
    Say '  Linux package: none (the Linux launcher files are missing, see 2b)'
} elseif ($nativeClient) {
    Say ("  Linux package {0}: native build from {1} ({2} files); the {3} Windows-only and {4} Linux-only files of H9XASH stay out, the build brings its own" -f "$Name-linux.zip", $LinuxNative, $nativeCount, $windowsOnlyRels.Count, $linuxOnlyRels.Count)
} else {
    if (Test-Path -LiteralPath $LinuxNative -PathType Container) {
        Warn "$LinuxNative holds no xash3d client ($nativeCount files): $Name-linux.zip is the Wine/Proton package, the Windows game with h9xash.sh"
    } else {
        Warn "no native Linux build ($LinuxNative, -LinuxNative): $Name-linux.zip is the Wine/Proton package, the Windows game with h9xash.sh (docs\LINUX_SUPPORT.txt)"
    }
    Say "  Linux package $Name-linux.zip: Wine/Proton package, the Windows game with h9xash.sh"
}
if ($makeServerZip) {
    Say ("  Linux dedicated server package {0}: native build from {1} (xashds, no client)" -f "$Name-linux-server.zip", $LinuxNative)
} elseif ((Test-Path -LiteralPath $serverZip) -and -not $DryRun) {
    Warn "an older $serverZip is in $OutDir; this run made no dedicated server package"
}
if ($nativeClient -or $makeServerZip) {
    # what a native package needs from its build folder, since H9XASH's own Linux files are left out of it
    if (-not (Get-ChildItem -LiteralPath (Join-Path $LinuxNative 'ts\dlls') -Filter '*.so' -ErrorAction SilentlyContinue)) {
        Warn "the native build has no game library in $LinuxNative\ts\dlls (ts_i386.so), so its package cannot start a match"
    }
    $launcher = if ($nativeClient) { 'h9xash.sh' } else { 'h9xash_server.sh' }
    if (-not (Test-Path -LiteralPath (Join-Path $LinuxNative $launcher) -PathType Leaf)) {
        Warn "the native build has no $launcher launcher in $LinuxNative; its package has none"
    }
    foreach ($gf in 'gameinfo.txt', 'liblist.gam') {
        if (-not (Test-Path -LiteralPath (Join-Path $LinuxNative "ts\$gf") -PathType Leaf)) {
            Warn "the native build has no ts\$gf in ${LinuxNative}: the staged one names no Linux game library for Metamod (gamedll_linux), so the game would start without Metamod and AMX Mod X"
        }
    }
}
$Report.Add('  left out of the Windows package (Linux-only):')
foreach ($r in $linuxOnlyRels) { $Report.Add("    $r") }
if ($nativeClient -or $makeServerZip) {
    $Report.Add('  left out of a native Linux package (Windows-only, and the stock Linux files the build replaces):')
    foreach ($r in ($windowsOnlyRels + $linuxOnlyRels)) { $Report.Add("    $r") }
}

# ---- zip -------------------------------------------------------------------------------

if ($DryRun) {
    Write-Report
    Say ''
    Say "Dry run: no ZIP. Stage kept: $stage"
    Say "Report: $reportPath"
    exit 0
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$level = [IO.Compression.CompressionLevel]::$Compression

Say ''
Say "5. Windows package: $zipPath"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$leaveOut = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($r in $linuxOnlyRels) { [void]$leaveOut.Add($r) }
$winFiles = 0
$fs = [IO.File]::Open($zipPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    # the folders that are empty on purpose (the AMXX vault and logs) get an entry of their own
    foreach ($d in (Get-ChildItem -LiteralPath $stage -Recurse -Force -Directory)) {
        if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) {
            [void]$za.CreateEntry('H9XASH/' + $d.FullName.Substring($stage.Length + 1).Replace('\', '/') + '/')
        }
    }
    foreach ($f in $stageFiles) {
        $rel = $f.FullName.Substring($stage.Length + 1)
        if ($leaveOut.Contains($rel)) { continue }
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, 'H9XASH/' + $rel.Replace('\', '/'), $level)
        $winFiles++
    }
} finally {
    $za.Dispose()
    $fs.Dispose()
}
$zipInfo = Get-Item -LiteralPath $zipPath
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Say ("  {0:N0} files, {1:N0} MB, SHA-256 {2}" -f $winFiles, ($zipInfo.Length / 1MB), $hash)

# ---- the Linux packages ----------------------------------------------------------------

if ($linuxOk) {
    $jobs = @(@{ Out = $linuxZip; Kind = $linuxKind; Label = if ($nativeClient) { 'Linux package (native)' } else { 'Linux package (Wine/Proton)' } })
    if ($makeServerZip) { $jobs += @{ Out = $serverZip; Kind = 'native'; Label = 'Linux dedicated server package (native)' } }
    $step = 6
    foreach ($job in $jobs) {
        Say ''
        Say "$step. $($job.Label): $($job.Out)"
        $step++
        $outZip = $job.Out
        if (Test-Path -LiteralPath $outZip) { Remove-Item -LiteralPath $outZip -Force }
        $made = $null
        if ($job.Kind -eq 'native' -and -not $PyVersion) {
            Warn "no Python 3 through the py launcher: a native Linux package needs it for the file modes of its binaries, so $outZip was not made"
        } elseif ($PyVersion) {
            $pyScript = Join-Path $stageBase 'make_linux_zip.py'
            [IO.File]::WriteAllText($pyScript, $LinuxZipPy, [Text.Encoding]::ASCII)
            $pyArgs = @($stage, $outZip)
            if ($job.Kind -eq 'native') {
                $skipFile = Join-Path $stageBase 'native_skip.txt'
                $skipLines = @(($windowsOnlyRels + $linuxOnlyRels) | ForEach-Object { $_.Replace('\', '/') })
                [IO.File]::WriteAllLines($skipFile, [string[]]$skipLines, (New-Object Text.UTF8Encoding($false)))
                $pyArgs += @('--skip', $skipFile, '--overlay', $LinuxNative, '--no-windows')
            }
            $pyOut = @(& py -3 -I $pyScript @pyArgs)
            $pyRc = $LASTEXITCODE
            foreach ($l in $pyOut) { Say "  $l" }
            if ($pyRc -eq 0 -and (Test-Path -LiteralPath $outZip)) { $made = $outZip }
            else { Warn "$outZip was not made (Python exit $pyRc); the Windows ZIP is done" }
        } else {
            Say '  (no Python 3, so no file modes: Linux players start it with bash h9xash.sh)'
            [IO.Compression.ZipFile]::CreateFromDirectory($stage, $outZip, $level, $true)
            $made = $outZip
        }
        if ($made) {
            $info = Get-Item -LiteralPath $made
            Say ("  {0:N0} MB, SHA-256 {1}" -f ($info.Length / 1MB), (Get-FileHash -LiteralPath $made -Algorithm SHA256).Hash)
        }
    }
}

# ---- the web files for H9XASH-Updater -------------------------------------------------

if (-not $NoWebFiles) {
    Say ''
    $FilesDir = [IO.Path]::GetFullPath($FilesDir)
    $publisher = Join-Path $Here 'tools\updater\publish_files.py'
    $webPy = $null
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            $v = @(& py -3 -c "import sys; print(sys.version.split()[0])")
            if ($LASTEXITCODE -eq 0 -and $v.Count -gt 0) { $webPy = [string]$v[0] }
        } catch { $webPy = $null }
    }
    if (-not (Test-Path -LiteralPath $publisher)) {
        Warn "no $publisher, so no web files for H9XASH-Updater were published"
    } elseif (-not $webPy) {
        Warn 'no Python 3 through the py launcher, so no web files for H9XASH-Updater were published'
    } else {
        Say "7. web files for H9XASH-Updater: $FilesDir (Python $webPy)"
        $seedArgs = @()
        foreach ($r in $Replacements) {
            if (Test-Path -LiteralPath (Join-Path $stage $r.At) -PathType Leaf) { $seedArgs += @('--seed', $r.At) }
        }
        $pyOut = @(& py -3 -I $publisher $stage $FilesDir --build $build --name $Name @seedArgs)
        $pyRc = $LASTEXITCODE
        foreach ($l in $pyOut) { Say "  $l" }
        if ($pyRc -ne 0) { Warn "the web files were not published (Python exit $pyRc); the ZIPs are done" }
        else { Say "  copy $FilesDir to the site's files/ (tools\updater\README_UPDATER.txt, section 3)" }
    }
}

# The downloads page beside this script links the two packages by name and shows the build.
$page = Join-Path $Here 'havoc9.org\downloads\index.html'
if (Test-Path -LiteralPath $page) {
    $html = Read-Text $page
    foreach ($want in @("href=`"$Name.zip`"", "href=`"$Name-linux.zip`"")) {
        if (-not $html.Contains($want)) { Warn "the downloads page ($page) has no $want" }
    }
    if (-not $html.Contains("Version $build<")) { Warn "the downloads page does not show Version $build; update its two download notes" }
}

if ($KeepStage) { Say "  stage kept: $stage" }
else { Remove-Item -LiteralPath $stageBase -Recurse -Force }

Write-Report
Say "Report: $reportPath"
if ($Warnings.Count) { Write-Host "$($Warnings.Count) warning(s); see the report." -ForegroundColor Yellow }
exit 0

<#
.SYNOPSIS
  One command for a whole release: builds what changed, stages, deploys to havoc9.org's host, verifies, and says what is left.

.DESCRIPTION
  Run it in PowerShell 7 from this folder (the git copy), with the game closed:
    .\ship.ps1                    do what packaging.ini [ship] says
    .\ship.ps1 -WhatIf            say what would run and why, change nothing
    .\ship.ps1 -From deploy       start at a step: engine, plugins, linux, export, webclient, deploy, server
    .\ship.ps1 -Only engine       run one step and stop
    .\ship.ps1 -UpdateServer      also bring the game server folder on the host (C:\havoc9\H9XASH) up to the build (it must be stopped)

  The steps, in the order of docs\SHIP_A_VERSION.txt (each is gated by [ship] in packaging.ini: 1 = yes, 0 = no, auto = when its inputs changed):
    engine     xash.bat engine in the master tree (when the engine's sources or patches changed since the web client was built); the patch chain must verify
    plugins    tools\release-prepare.mjs: the build number, the join gate's release (the same number), the plugins, the presets, then export
    linux      build-linux.cmd, when the engine or a plugin was built (or H9XASH-linux has no server)
    export     export.bat: the master's builds into the git copy
    webclient  tools\webclient-sync.mjs (a no-op when the browser build is up to date)
    deploy     .\deploy-vps.ps1: stage, package, upload only what changed, install, verify-release.ps1 (the build in the manifest, the bot's About Me, the downloads, the join gate)
    server     update-game.ps1 on the host: a check by default, the update with -UpdateServer

  It stops at the first step that fails and says which log to read and how to continue (-From). Before anything runs it checks: PowerShell 7, the game is not running, no heavy job holds
  D:\temp\HEAVY-JOB.lock, the master's reTS and engine trees have nothing the git copy has newer (that is a merge by hand), the SSH shortcut answers. It commits nothing and pushes nothing.
  Logs: D:\temp\ship-<time>\<step>.log.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Ini = (Join-Path $PSScriptRoot 'packaging.ini'),
    [ValidateSet('', 'engine', 'plugins', 'linux', 'export', 'webclient', 'deploy', 'server')][string]$From = '',
    [ValidateSet('', 'engine', 'plugins', 'linux', 'export', 'webclient', 'deploy', 'server')][string]$Only = '',
    [switch]$UpdateServer
)

$ErrorActionPreference = 'Stop'
trap { Write-Host "[FAIL] $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red; exit 1 }
$Here = $PSScriptRoot
$DryRun = [bool]$WhatIfPreference
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path 'D:\temp' "ship-$Stamp"
$Lock = if ($env:H9_HEAVY_LOCK) { $env:H9_HEAVY_LOCK } else { 'D:\temp\HEAVY-JOB.lock' }
function Say([string]$t) { Write-Host "== $t" }
function Fail([string]$t) { Write-Host "[FAIL] $t" -ForegroundColor Red; exit 1 }
function Warn([string]$t) { Write-Host "[WARN] $t" -ForegroundColor Yellow }

# ---- packaging.ini [ship] ------------------------------------------------------------------------------------------------------------
$cfg = @{}
$sec = ''
foreach ($raw in [IO.File]::ReadAllLines($Ini)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
    if ($line -match '^\[(.+)\]$') { $sec = $Matches[1].Trim().ToLowerInvariant(); continue }
    if ($line -match '^([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg["$sec.$($Matches[1].ToLowerInvariant())"] = $Matches[2].Trim() }
}
function Mode([string]$key, [string]$default) {
    $v = [string]$cfg["ship.$key"]
    if ($v -eq '') { $v = $default }
    if ($v -notin @('0', '1', 'auto')) { Fail "[ship] $key in packaging.ini must be 0, 1 or auto (it says '$v')" }
    return $v
}
$mode = @{
    engine    = Mode 'engine' 'auto'
    plugins   = Mode 'plugins' 'auto'
    linux     = Mode 'linux' 'auto'
    export    = Mode 'export' 'auto'
    webclient = Mode 'webclient' 'auto'
    deploy    = Mode 'deploy' '1'
    server    = Mode 'server' '1'
}
$bumpMode = [string]$cfg['ship.bump']
if ($bumpMode -eq '') { $bumpMode = 'auto' }
if ($bumpMode -notin @('auto', 'engine', 'always', 'never')) { Fail "[ship] bump must be auto, engine, always or never" }

# the master tree (the source of builds)
$bp = Join-Path $Here 'buildpaths.ini'
$tsm = ''
if (Test-Path -LiteralPath $bp) { foreach ($l in [IO.File]::ReadAllLines($bp)) { if ($l -match '^\s*TSM_ROOT\s*=\s*(.+?)\s*$') { $tsm = $Matches[1] } } }
if (-not $tsm -or -not (Test-Path -LiteralPath (Join-Path $tsm 'build.bat'))) { Fail "TSM_ROOT in buildpaths.ini ($tsm) is not the master tree (no build.bat there)" }
$stateFile = Join-Path $Here 'dist\.release-state.json'

$order = @('engine', 'plugins', 'linux', 'export', 'webclient', 'deploy', 'server')
$results = [ordered]@{}
$ran = @{}

function Want([string]$step) {
    if ($Only) { return $step -eq $Only }
    if ($From -and ($order.IndexOf($step) -lt $order.IndexOf($From))) { return $false }
    return $true
}

# ---- preflight -----------------------------------------------------------------------------------------------------------------------
Say 'preflight'
if ($PSVersionTable.PSVersion.Major -lt 7) { Fail 'run this in PowerShell 7 (pwsh)' }
$branch = (git -C $Here symbolic-ref --short HEAD 2>$null)
Write-Host "  git copy: $Here on branch $branch; master: $tsm"

# a game running from either H9XASH holds its DLLs (the builds and the export would stop in the middle)
$folders = @((Join-Path $tsm 'H9XASH'), (Join-Path $Here 'H9XASH')) | ForEach-Object { $_.ToLowerInvariant() }
foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'HAVOC|xash|hlds' })) {
    $path = ''
    try { $path = [string]$p.Path } catch { }
    if ($path -and ($folders | Where-Object { $path.ToLowerInvariant().StartsWith($_) })) { Fail "$path is running: close the game, then run ship.ps1 again" }
}
if (Test-Path -LiteralPath $Lock) { Fail "$Lock exists: another heavy job is running (or a stale lock: $([IO.File]::ReadAllText($Lock).Trim()))" }

# the git copy must not hold engine or client work the master lacks (robocopy /L lists what a copy from the git copy to the master would change)
function Same-Text([byte[]]$a, [byte[]]$b) {
    if ($a.Length -eq $b.Length) {
        $same = $true
        for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { $same = $false; break } }
        if ($same) { return $true }
    }
    # a checkout may have changed the line ends: compare as text with CR LF as LF
    $l1 = [Text.Encoding]::Latin1
    return $l1.GetString($a).Replace("`r`n", "`n") -ceq $l1.GetString($b).Replace("`r`n", "`n")
}
# robocopy /L lists what a copy from the git copy to the master would change (files newer in the git copy, or missing from the master); a checkout gives files new time
# stamps, so each listed file is compared by content and only the ones that really differ count
function Newer-In-GitCopy([string]$rel, [string[]]$skipDirs) {
    $src = Join-Path $Here $rel
    $dst = Join-Path $tsm $rel
    $out = & robocopy $src $dst /L /E /XO /NJH /NJS /NDL /NC /NS /FP /XF *.wav *.md *.MD .gitignore *.bak_* /XD @skipDirs 2>$null
    $differ = New-Object System.Collections.Generic.List[string]
    foreach ($line in $out) {
        $p = ([string]$line).Trim()
        if (-not $p.StartsWith($src, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $sub = $p.Substring($src.Length).TrimStart('\')
        $other = Join-Path $dst $sub
        if (-not (Test-Path -LiteralPath $other -PathType Leaf)) { $differ.Add($sub + ' (missing from the master)'); continue }
        if (-not (Same-Text ([IO.File]::ReadAllBytes($p)) ([IO.File]::ReadAllBytes($other)))) { $differ.Add($sub) }
    }
    return $differ.ToArray()
}
foreach ($t in @(@('reTS', @('.git', 'binaries', 'release_binaries', 'build-win32', 'build-win32-clangcl')), @('xash3d-fwgs', @('.git', 'build', 'build-web', '__pycache__')))) {
    $diff = Newer-In-GitCopy $t[0] $t[1]
    if ($diff.Count) {
        Write-Host "  files in the git copy's $($t[0]) that are newer than, or missing from, the master's:"
        $diff | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" }
        Fail "the git copy holds $($t[0]) work the master lacks ($($diff.Count) file(s)): merge by hand first (docs\SHIP_A_VERSION.txt, 1b: compare, never copy by time stamp)"
    }
}
if ($mode.deploy -ne '0' -and (Want 'deploy')) {
    $sshHost = [string]$cfg['deploy.host']
    if ($sshHost -notmatch '^[A-Za-z0-9._@-]+$') { Fail '[deploy] host in packaging.ini must be an SSH shortcut' }
    $ok = (& ssh -o BatchMode=yes -o ConnectTimeout=20 $sshHost 'echo ok' 2>$null) -join ''
    if ($ok.Trim() -ne 'ok') { Fail "ssh $sshHost does not answer (docs\ADD_AN_SSH_KEY.txt)" }
    Write-Host "  ssh $sshHost answers"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- helpers -------------------------------------------------------------------------------------------------------------------------
# the lock is always read from the script scope ($script:Lock): a function's parameter named $lock (variables are case-insensitive, and a called function sees its caller's)
# once made it the [bool] $true, a file called "True" in the process's folder
function Take-Lock([string]$what) {
    try { $fs = [IO.File]::Open($script:Lock, 'CreateNew', 'Write', 'None'); $b = [Text.Encoding]::ASCII.GetBytes("ship.ps1 | $what | $(Get-Date -Format s)"); $fs.Write($b, 0, $b.Length); $fs.Dispose() }
    catch { Fail "could not take $($script:Lock) ($($_.Exception.Message))" }
}
function Drop-Lock { Remove-Item -LiteralPath $script:Lock -Force -ErrorAction SilentlyContinue }

# runs a .bat or .cmd with its output in a log; the exit code decides
function Run-Bat([string]$name, [string]$bat, [string[]]$batArgs, [bool]$useLock) {
    $log = Join-Path $LogDir "$name.log"
    Write-Host "  $bat $($batArgs -join ' ')   (log $log)"
    if ($useLock) { Take-Lock $name }
    try {
        $cmd = '""' + $bat + '" ' + ($batArgs -join ' ') + ' < NUL > "' + $log + '" 2>&1"'
        $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', $cmd) -NoNewWindow -PassThru -Wait
        if ($p.ExitCode -ne 0) { Fail "$name failed (exit $($p.ExitCode)); read $log, then continue with: .\ship.ps1 -From $name" }
    } finally { if ($useLock) { Drop-Lock } }
}

function Run-Node([string]$name, [string[]]$nodeArgs, [string]$cwd) {
    $log = Join-Path $LogDir "$name.log"
    Write-Host "  node $($nodeArgs -join ' ')   (log $log)"
    Push-Location $cwd
    try {
        # not "*> $log": a redirect to a file is an operation -WhatIf skips, and the log was then missing
        $out = @(& node @nodeArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        if (-not $DryRun) { [IO.File]::WriteAllLines($log, [string[]]$out) }
        $out | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
        if ($code -ne 0) { Fail "$name failed (exit $code); read $log, then continue with: .\ship.ps1 -From $name" }
    } finally { Pop-Location }
}

function Record([string]$step, [string]$what) { $script:results[$step] = $what }

# ---- 1. engine -----------------------------------------------------------------------------------------------------------------------
$engineBuilt = $false
if (Want 'engine') {
    Say 'engine'
    $stale = $false
    $why = ''
    if ($mode.engine -eq '1') { $stale = $true; $why = 'asked for ([ship] engine = 1)' }
    elseif ($mode.engine -eq 'auto') {
        # the browser build's record knows what the engine's sources and the patch chain were when it was last built
        $chk = (& node (Join-Path $tsm 'tools\webclient-sync.mjs') --check 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0 -and $chk -match 'engine|patches|client') { $stale = $true; $why = 'the engine, the patch chain or the client library changed since the browser build was made' }
    }
    if (-not $stale) { Write-Host '  nothing changed'; Record engine 'skipped (unchanged)' }
    elseif ($DryRun) { Write-Host "  WHATIF: xash.bat engine ($why)"; Record engine 'would run' }
    else {
        Write-Host "  $why"
        Run-Bat 'engine' (Join-Path $tsm 'xash3d-h9-patches\xash.bat') @('engine') $true
        $engineBuilt = $true
        $ran.engine = $true
        Record engine 'built'
    }
} else { Record engine 'not in this run' }

# ---- 2. plugins, the build number and the release ------------------------------------------------------------------------------------
$pluginsBuilt = $false
if (Want 'plugins') {
    Say 'plugins, build number, release'
    if ($mode.plugins -eq '0') { Write-Host '  [ship] plugins = 0'; Record plugins 'skipped' }
    else {
        $bump = ($bumpMode -eq 'always') -or ($bumpMode -eq 'engine' -and ($engineBuilt -or $mode.engine -eq '1'))
        $nodeArgs = @('tools\release-prepare.mjs', $(if ($bump) { '--bump' } else { '--auto' }), '--state', $stateFile, '--repo', $Here)
        if ($DryRun) { $nodeArgs += '--dry' }
        Run-Node 'plugins' $nodeArgs $tsm
        if (-not $DryRun) { $pluginsBuilt = $true; $ran.plugins = $true }
        Record plugins $(if ($DryRun) { 'dry run' } else { 'prepared (see the log: a bump builds and exports)' })
    }
} else { Record plugins 'not in this run' }

# ---- 3. linux ------------------------------------------------------------------------------------------------------------------------
if (Want 'linux') {
    Say 'linux server'
    $need = ($mode.linux -eq '1') -or ($mode.linux -eq 'auto' -and ($engineBuilt -or $pluginsBuilt -or -not (Test-Path -LiteralPath (Join-Path $tsm 'H9XASH-linux\xashds'))))
    if (-not $need) { Write-Host '  nothing changed'; Record linux 'skipped (unchanged)' }
    elseif ($DryRun) { Write-Host '  WHATIF: build-linux.cmd'; Record linux 'would run' }
    else { Run-Bat 'linux' (Join-Path $tsm 'build-linux.cmd') @() $false; $ran.linux = $true; Record linux 'built' }
} else { Record linux 'not in this run' }

# ---- 4. export -----------------------------------------------------------------------------------------------------------------------
if (Want 'export') {
    Say 'export (master to the git copy)'
    $need = ($mode.export -eq '1') -or ($mode.export -eq 'auto' -and ($engineBuilt -or $ran.linux))
    if (-not $need) { Write-Host '  nothing changed (the plugin build exports by itself)'; Record export 'skipped (unchanged)' }
    elseif ($DryRun) { Write-Host '  WHATIF: export.bat'; Record export 'would run' }
    else { Run-Bat 'export' (Join-Path $tsm 'export.bat') @() $true; $ran.export = $true; Record export 'done' }
} else { Record export 'not in this run' }

# ---- 5. web client -------------------------------------------------------------------------------------------------------------------
if (Want 'webclient') {
    Say 'web client'
    if ($mode.webclient -eq '0') { Write-Host '  [ship] webclient = 0'; Record webclient 'skipped' }
    elseif ($DryRun) { Write-Host '  WHATIF: node tools\webclient-sync.mjs (builds only when its inputs changed)'; Record webclient 'would run' }
    else { Run-Node 'webclient' @('tools\webclient-sync.mjs') $tsm; Record webclient 'up to date' }
} else { Record webclient 'not in this run' }

# ---- 6. deploy (stage, package, upload, install, verify) -----------------------------------------------------------------------------
if (Want 'deploy') {
    Say 'deploy and verify'
    if ($mode.deploy -eq '0') { Write-Host '  [ship] deploy = 0'; Record deploy 'skipped' }
    elseif ($DryRun) { Write-Host '  WHATIF: .\deploy-vps.ps1 (stage, package, upload, install, verify-release.ps1)'; Record deploy 'would run' }
    else {
        $log = Join-Path $LogDir 'deploy.log'
        Write-Host "  .\deploy-vps.ps1   (log $log)"
        & (Join-Path $Here 'deploy-vps.ps1') *> $log
        $code = $LASTEXITCODE
        Get-Content -LiteralPath $log -Tail 22 | ForEach-Object { Write-Host "    $_" }
        if ($code -ne 0) { Fail "the deploy failed (exit $code); read $log, then continue with: .\ship.ps1 -From deploy" }
        Record deploy 'deployed and verified'
    }
} else { Record deploy 'not in this run' }

# ---- 7. the game server folder on the host -------------------------------------------------------------------------------------------
if (Want 'server') {
    Say 'game server folder on the host'
    if ($mode.server -eq '0' -or $mode.deploy -eq '0') { Write-Host '  [ship] server = 0 or no deploy'; Record server 'skipped' }
    elseif ($DryRun) { Write-Host '  WHATIF: update-game.ps1 on the host (check; -UpdateServer applies)'; Record server 'would run' }
    else {
        $sshHost = [string]$cfg['deploy.host']
        $arg = if ($UpdateServer) { ' -Apply' } else { '' }
        $out = & ssh -o BatchMode=yes $sshHost "powershell -NoProfile -ExecutionPolicy Bypass -File C:\havoc9\update-game.ps1$arg" 2>&1
        $out | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) { Fail "update-game.ps1 on the host said no (the server is probably running: stop it, then .\ship.ps1 -Only server -UpdateServer)" }
        if ($UpdateServer) { Record server 'updated: start it with h9xash_server.bat' }
        else { Record server 'checked (add -UpdateServer, with the server stopped, to update it)' }
    }
} else { Record server 'not in this run' }

# ---- report --------------------------------------------------------------------------------------------------------------------------
Say 'report'
foreach ($k in $results.Keys) { Write-Host ("  {0,-10} {1}" -f $k, $results[$k]) }
$smaPath = Join-Path $Here 'src\ts_matchmode.sma'
if (Test-Path -LiteralPath $smaPath -PathType Leaf) {
    if ([IO.File]::ReadAllText($smaPath) -match '(?m)^#define\s+VERSION\s+"([^"]+)"') { Write-Host "  build $($Matches[1]) (the join gate's release is the same number)" }
}
$dirty = @(git -C $Here status --porcelain 2>$null | Where-Object { $_ -notmatch 'rcbot/botprofiles|\.rld$|\.scr$|README\.txt$' }).Count
Write-Host "  $dirty uncommitted path(s) in the git copy: nothing is committed or pushed by this script"
Write-Host "  logs: $LogDir"
exit 0

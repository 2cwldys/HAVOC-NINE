<#
.SYNOPSIS
  Says where a running release is: which step, how long it has been there, the tail of that step's
  log, and whether it is working or stuck. It changes nothing and is safe to run at any time.

.DESCRIPTION
    .\ship-status.ps1               the newest run, as a readable report
    .\ship-status.ps1 -Tail 40      more of the active step's log
    .\ship-status.ps1 -Json         one JSON object, for a script or an agent to read
    .\ship-status.ps1 -Dir D:\temp\ship-20261117-031457    a particular run

  ship.ps1 writes each step's output to D:\temp\ship-<time>\<step>.log, flushed line by line, so a
  step that takes minutes can be watched while it runs instead of showing nothing until it ends.

  STATE is one of:
    running   a step's log is still growing, or a build process of this run is alive
    stalled?  ship.ps1 is alive, but nothing has been written for -StaleMinutes and no build is running
    done      no ship.ps1 process is left and no step reported a failure
    failed    a step log holds [FAIL] or [ERROR]

  A "stalled?" with vctipHolding = true is the known MSVC trap: VCTIP.EXE (the compiler's telemetry
  helper) inherits the build's pipe and holds it open after the build itself has exited, so the wait
  never ends. ship.ps1 now sets VSCMD_SKIP_SENDTELEMETRY=1 and sweeps it, but if one is ever listed
  here while a run is stuck, "Stop-Process -Name vctip -Force" releases it immediately.
#>
param(
    [int]$Tail = 15,
    [string]$Dir = '',
    [int]$StaleMinutes = 3,
    [switch]$Json
)
$ErrorActionPreference = 'SilentlyContinue'

$order = @('engine', 'plugins', 'linux', 'export', 'webclient', 'deploy', 'server')

if (-not $Dir) {
    $newest = Get-ChildItem 'D:\temp' -Directory -Filter 'ship-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $Dir = $newest.FullName }
}
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) {
    if ($Json) { '{"state":"none","reason":"no ship run under D:\\temp\\ship-*"}' } else { Write-Output 'no ship run found under D:\temp\ship-*' }
    exit 2
}

$now     = Get-Date
$started = (Get-Item -LiteralPath $Dir).CreationTime
$logs    = @(Get-ChildItem (Join-Path $Dir '*.log') | Sort-Object LastWriteTime)
$active  = $logs | Select-Object -Last 1

# ship.ps1 itself, and anything a step is really running. A process counts only when it descends from
# the ship.ps1 process: filtering by start time alone also catches the editor's own node and python,
# which made this say "building" while nothing of the release was running at all.
$ship  = @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*ship.ps1*' })
$names = @('cmd', 'node', 'python', 'py', 'cl', 'link', 'lib', 'rc', 'ssh', 'scp', 'robocopy', 'amxxpc', '7z', 'tar', 'waf')
$parentOf = @{}
foreach ($p in Get-CimInstance Win32_Process) { $parentOf[[int]$p.ProcessId] = [int]$p.ParentProcessId }
$shipIds = @($ship | ForEach-Object { [int]$_.ProcessId })
function Test-FromShip([int]$ProcId, [int[]]$Roots) {
    $hops = 0
    while ($ProcId -gt 0 -and $hops -lt 24) {
        if ($Roots -contains $ProcId) { return $true }
        if (-not $parentOf.ContainsKey($ProcId)) { return $false }
        $ProcId = $parentOf[$ProcId]; $hops++
    }
    return $false
}
$busy = @()
if ($shipIds.Count) {
    $busy = @(Get-Process | Where-Object { $names -contains $_.ProcessName -and (Test-FromShip $_.Id $shipIds) } | Select-Object -Expand ProcessName -Unique)
}
$vctip = @(Get-Process -Name 'vctip')

$staleFor = if ($active) { [math]::Round(($now - $active.LastWriteTime).TotalMinutes, 1) } else { [math]::Round(($now - $started).TotalMinutes, 1) }
$failed = $false
$failLine = ''
foreach ($l in $logs) {
    $hit = Select-String -LiteralPath $l.FullName -Pattern '^\[FAIL\]|^\[ERROR\]|\[ERROR\] ' | Select-Object -First 1
    if ($hit) { $failed = $true; $failLine = "$($l.BaseName): $($hit.Line.Trim())"; break }
}

# The heavy lock and the active log's freshness are the signals that can be trusted. Finding the
# ship.ps1 process is not one: when a runner starts it the script name need not appear in the command
# line at all, which once made this report "done" while the Linux build was running perfectly well.
$lockPath = if ($env:H9_HEAVY_LOCK) { $env:H9_HEAVY_LOCK } else { 'D:\temp\HEAVY-JOB.lock' }
$lockHeld = Test-Path -LiteralPath $lockPath
$lockBy   = if ($lockHeld) { (Get-Content -LiteralPath $lockPath -Raw).Trim() } else { '' }
$fresh    = ($staleFor -lt $StaleMinutes)

$state = if ($failed) { 'failed' }
         elseif ($fresh -or $busy.Count -gt 0) { 'running' }
         elseif ($lockHeld -or $ship.Count -gt 0) { 'stalled?' }
         else { 'done' }

$steps = foreach ($s in $order) {
    $f = $logs | Where-Object { $_.BaseName -eq $s } | Select-Object -First 1
    [pscustomobject]@{
        step    = $s
        state   = if (-not $f) { 'not yet' } elseif ($active -and $f.FullName -eq $active.FullName -and $state -ne 'done') { 'ACTIVE' } else { 'done' }
        kb      = if ($f) { [math]::Round($f.Length / 1KB, 1) } else { 0 }
        written = if ($f) { $f.LastWriteTime.ToString('HH:mm:ss') } else { '' }
    }
}

$tailLines = if ($active) { @(Get-Content -LiteralPath $active.FullName -Tail $Tail) } else { @() }

if ($Json) {
    [pscustomobject]@{
        state         = $state
        dir           = $Dir
        activeStep    = if ($active) { $active.BaseName } else { $null }
        startedAt     = $started.ToString('s')
        elapsedMin    = [math]::Round(($now - $started).TotalMinutes, 1)
        quietForMin   = $staleFor
        shipAlive     = ($ship.Count -gt 0)
        lockHeld      = $lockHeld
        lockBy        = $lockBy
        busyProcesses = $busy
        vctipHolding  = ($vctip.Count -gt 0)
        failure       = $failLine
        steps         = $steps
        tail          = $tailLines
    } | ConvertTo-Json -Depth 5
    exit 0
}

Write-Output "run        : $Dir"
Write-Output ("state      : {0}   (started {1}, {2} min ago)" -f $state.ToUpper(), $started.ToString('HH:mm:ss'), [math]::Round(($now - $started).TotalMinutes, 1))
Write-Output ("active step: {0}   (quiet for {1} min)" -f $(if ($active) { $active.BaseName } else { '(none yet)' }), $staleFor)
Write-Output ("heavy lock : {0}" -f $(if ($lockHeld) { $lockBy } else { 'not held' }))
Write-Output ("processes  : ship {0};  building: {1}" -f $(if ($ship.Count) { 'found' } else { 'not identified (normal when a runner starts it)' }), $(if ($busy.Count) { $busy -join ', ' } else { 'none seen' }))
if ($vctip.Count) { Write-Output 'WARNING    : vctip.exe is alive -- if this run is stuck it is holding the build pipe: Stop-Process -Name vctip -Force' }
if ($failLine)    { Write-Output "FAILURE    : $failLine" }
Write-Output ''
$steps | Format-Table -AutoSize | Out-String | Write-Output
if ($tailLines.Count) {
    Write-Output "--- last $Tail line(s) of $($active.BaseName).log ---"
    $tailLines | ForEach-Object { Write-Output "  $_" }
}

<#
.SYNOPSIS
  h9web backups on a schedule: a Windows Task Scheduler task that backs up this PC's local site.

.DESCRIPTION
  The task runs as you, only while you are signed in (no stored password, no admin):
    node bin\h9web-backup.js backup --config <the local site's config.json> --out <folder> --keep <N>
  and adds each run's output to <folder>\h9web-backup.log. The local site's config is
  %LOCALAPPDATA%\h9web-local\config.json (H9WEB_LOCAL\config.json when that is set); the backup
  is safe while the site runs. README.txt section 10 has the details.

    .\backup-task.ps1 -Install [-Time 04:00] [-Daily | -Hourly] [-Out <folder>] [-Keep N] [-PassphraseFile <file>]
    .\backup-task.ps1 -Remove
    .\backup-task.ps1 -RunNow [-Out <folder>] [-Keep N]     the same backup now, in this window
    .\backup-task.ps1 -Status                               the task, its last run and result, the log
  -WhatIf with -Install, -Remove or -RunNow shows what would be done and changes nothing.

  -Out is %USERPROFILE%\Documents\h9web-backups unless given; -Keep 30; -Time 04:00, every day
  (-Hourly: every hour from -Time). A run missed while the PC was off or asleep runs when it is
  next on. -PassphraseFile encrypts the backups with the passphrase in the file's first line
  (12 characters or more); keep that file where only you can read it.

  Where PowerShell refuses scripts:
    powershell -ExecutionPolicy Bypass -File backup-task.ps1 -Install
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$RunNow,
  [switch]$Status,
  [switch]$Run,
  [string]$Time = '04:00',
  [switch]$Daily,
  [switch]$Hourly,
  [string]$Out = (Join-Path $env:USERPROFILE 'Documents\h9web-backups'),
  [ValidateRange(1, 100000)][int]$Keep = 30,
  [string]$PassphraseFile = '',
  [string]$Config = '',
  [string]$Node = '',
  [string]$TaskName = 'h9web backup'
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Cli = Join-Path $Here 'bin\h9web-backup.js'
if (-not $Config) {
  $localDir = $env:H9WEB_LOCAL
  if (-not $localDir) { $localDir = Join-Path $env:LOCALAPPDATA 'h9web-local' }
  $Config = Join-Path $localDir 'config.json'
}
$Config = [System.IO.Path]::GetFullPath($Config)
$Out = [System.IO.Path]::GetFullPath($Out)
if ($PassphraseFile) { $PassphraseFile = [System.IO.Path]::GetFullPath($PassphraseFile) }
$Log = Join-Path $Out 'h9web-backup.log'

$modes = @()
if ($Install) { $modes += 'Install' }
if ($Remove) { $modes += 'Remove' }
if ($RunNow) { $modes += 'RunNow' }
if ($Status) { $modes += 'Status' }
if ($Run) { $modes += 'Run' }
if ($modes.Count -gt 1) { Write-Error 'use one of -Install, -Remove, -RunNow and -Status' -ErrorAction Continue; exit 2 }
if ($modes.Count -eq 0) { $mode = 'Status' } else { $mode = $modes[0] }
if ($Daily -and $Hourly) { Write-Error '-Daily or -Hourly, not both' -ErrorAction Continue; exit 2 }

function Quote([string]$s) { return '"' + $s + '"' }

function Stamp { return (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }

function Find-Node {
  if ($Node) { return $Node }
  $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { throw 'Node.js 24 or newer is not on PATH (https://nodejs.org)' }
  return $c.Path
}

function Get-BackupArgs {
  $a = @($Cli, 'backup', '--config', $Config, '--out', $Out, '--keep', [string]$Keep)
  if ($PassphraseFile) { $a += @('--encrypt', '--passphrase-file', $PassphraseFile) }
  return ,$a
}

# Appends to the log in the backup folder; past 1 MB it keeps the last 2000 lines.
function Write-Log([string[]]$Lines) {
  New-Item -ItemType Directory -Force -Path $Out -WhatIf:$false | Out-Null
  Add-Content -LiteralPath $Log -Value $Lines -Encoding UTF8 -WhatIf:$false
  if ((Get-Item -LiteralPath $Log).Length -gt 1MB) {
    $tail = Get-Content -LiteralPath $Log -Tail 2000
    Set-Content -LiteralPath $Log -Value $tail -Encoding UTF8 -WhatIf:$false
  }
}

# Runs the backup and logs it; returns node's exit code.
function Invoke-Backup([switch]$Echo) {
  $nodeExe = Find-Node
  $a = Get-BackupArgs
  $started = Stamp
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $nodeExe @a 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $lines = @('[' + $started + '] backup of ' + $Config + ' into ' + $Out + ' (keep ' + $Keep + '): exit ' + $code)
  foreach ($o in $output) {
    $text = [string]$o
    if ($Echo) { Write-Host $text }
    $lines += '  ' + $text
  }
  Write-Log $lines
  return $code
}

function Get-Task {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Format-Time($t) {
  if (-not $t -or $t.Year -lt 2000) { return 'never' }
  return $t.ToString('yyyy-MM-dd HH:mm:ss')
}

function Install-Task {
  $nodeExe = Find-Node
  $at = [datetime]::ParseExact($Time, 'HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote $PSCommandPath), '-Run',
    '-Out', (Quote $Out), '-Keep', $Keep, '-Config', (Quote $Config), '-Node', (Quote $nodeExe), '-TaskName', (Quote $TaskName))
  if ($PassphraseFile) { $argList += @('-PassphraseFile', (Quote $PassphraseFile)) }
  $argLine = $argList -join ' '
  if ($Hourly) {
    $trigger = New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Hours 1)
    $when = 'every hour from ' + $Time
  } else {
    $trigger = New-ScheduledTaskTrigger -Daily -At $at
    $when = 'every day at ' + $Time
  }
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $Here
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  Write-Host ('task      ' + $TaskName + ': ' + $when + ', as ' + $user + ', only while signed in (no stored password, no admin)')
  Write-Host ('backs up  ' + $Config)
  Write-Host ('into      ' + $Out + ' (keeps ' + $Keep + '; log ' + $Log + ')' + $(if ($PassphraseFile) { ', encrypted' } else { '' }))
  Write-Host ('runs      ' + $ps + ' ' + $argLine)
  if (-not (Test-Path -LiteralPath $Config)) { Write-Warning ('there is no local site config at ' + $Config + ' yet: start local-site.cmd once before the first run') }
  if ($PassphraseFile -and -not (Test-Path -LiteralPath $PassphraseFile)) { Write-Warning ('there is no passphrase file at ' + $PassphraseFile) }
  if ($PSCmdlet.ShouldProcess($TaskName, 'Register the scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'h9web: a backup of the local site (h9web\backup-task.ps1)' -Force | Out-Null
    Write-Host 'installed. .\backup-task.ps1 -Status shows it; .\backup-task.ps1 -RunNow tries the backup now.'
  }
}

function Remove-Task {
  $t = Get-Task
  if (-not $t) { Write-Host ('no task named ' + (Quote $TaskName)); return }
  if ($PSCmdlet.ShouldProcess($TaskName, 'Remove the scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ('removed the task ' + (Quote $TaskName) + '; the backups and their log stay where they are')
  }
}

function Show-Status {
  $t = Get-Task
  $logFile = $Log
  if ($t) {
    $info = $t | Get-ScheduledTaskInfo
    $arguments = [string]$t.Actions[0].Arguments
    $m = [regex]::Match($arguments, '-Out "([^"]+)"')
    if ($m.Success) { $logFile = Join-Path $m.Groups[1].Value 'h9web-backup.log' }
    switch ($info.LastTaskResult) {
      0 { $result = 'ok' }
      267011 { $result = 'has not run yet' }
      267009 { $result = 'running now' }
      default { $result = 'FAILED, exit ' + $info.LastTaskResult + ' (the log says why)' }
    }
    $tr = $t.Triggers[0]
    $every = 'every day'
    if ($tr.Repetition -and $tr.Repetition.Interval) { $every = 'every ' + $tr.Repetition.Interval }
    Write-Host ('task      ' + $TaskName + ' (' + $t.State + '), ' + $every + ' from ' + $tr.StartBoundary)
    Write-Host ('last run  ' + (Format-Time $info.LastRunTime) + ': ' + $result)
    Write-Host ('next run  ' + (Format-Time $info.NextRunTime))
    Write-Host ('runs      ' + $t.Actions[0].Execute + ' ' + $arguments)
  } else {
    Write-Host 'task      not installed (.\backup-task.ps1 -Install)'
  }
  if (Test-Path -LiteralPath $logFile) {
    Write-Host ('log       ' + $logFile + ', its last lines:')
    Get-Content -LiteralPath $logFile -Tail 12 | ForEach-Object { Write-Host ('  ' + $_) }
  } else {
    Write-Host ('log       none yet (' + $logFile + ')')
  }
}

try {
  switch ($mode) {
    'Install' { Install-Task }
    'Remove' { Remove-Task }
    'Status' { Show-Status }
    'RunNow' {
      Write-Host ('backs up  ' + $Config + ' into ' + $Out + ' (keeps ' + $Keep + '; log ' + $Log + ')')
      if ($PSCmdlet.ShouldProcess($Config, 'Back up into ' + $Out)) { exit (Invoke-Backup -Echo) }
    }
    'Run' { exit (Invoke-Backup) }
  }
} catch {
  $message = $_.Exception.Message
  if ($mode -eq 'Run' -or $mode -eq 'RunNow') {
    try { Write-Log @('[' + (Stamp) + '] backup of ' + $Config + ' failed: ' + $message) } catch { }
  }
  Write-Error $message -ErrorAction Continue
  exit 1
}

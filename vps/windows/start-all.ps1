<#
.SYNOPSIS
  Starts everything havoc9.org runs on this Windows host and shows whether it works.

.DESCRIPTION
  Run it after a restart, a crash or anything else that stopped the site:
    right-click "Start HAVOC9" on the desktop, Run as administrator, or in an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\havoc9\start-all.ps1

  It also runs by itself two minutes after every boot (the task "havoc9 start-all at boot", which
  -InstallBootTask makes), so anything that did not come up with Windows is started again.

  What it does, in order, each step safe to repeat:
    1. SSH (sshd), so this machine can be reached with the key
    2. the firewall rules: TCP 80 and 443, the game ports, SSH (switched on if someone switched them off)
    3. the services, in order: havoc9-h9web, havoc9-serverlist, havoc9-p2p (when installed), havoc9-caddy;
       each one set to start at boot, started, and waited for
    4. the scheduled tasks: the backups and the log cleanup (switched on if they were off)
    5. checks: h9web and the list on this machine, the site over HTTPS as visitors reach it, and every file of the
       code against its fingerprint from the last install or delivery (code-check.ps1)
  At the end it prints a table; for a service that would not start it prints the end of its log.

    -InstallBootTask   also (re)make the task that runs this script two minutes after every boot
    -Root D:\havoc9    another folder than C:\havoc9 (as setup.ps1 -Root)
#>
param(
    [string]$Root = 'C:\havoc9',
    [string]$Domain = 'havoc9.org',
    [switch]$InstallBootTask
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Logs = Join-Path $Root 'logs'
$Rows = New-Object System.Collections.Generic.List[object]
$Bad = 0

function Row([string]$What, [string]$State, [bool]$Ok)
{
    $Rows.Add([pscustomobject]@{ Part = $What; State = $State; OK = $(if ($Ok) { 'yes' } else { 'NO' }) })
    if (-not $Ok) { $script:Bad++ }
}

function Test-Http([string]$Url)
{
    try { return [string](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10).StatusCode } catch {
        if ($_.Exception.Response) { return [string][int]$_.Exception.Response.StatusCode }
        return 'no answer'
    }
}

function Show-LogTail([string]$Service)
{
    $f = Get-ChildItem -LiteralPath $Logs -Filter "$Service*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 2
    foreach ($x in $f) {
        Write-Host "  --- $($x.Name), last lines"
        Get-Content -LiteralPath $x.FullName -Tail 8 | ForEach-Object { Write-Host "  $_" }
    }
}

$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run it as administrator (right-click, Run as administrator).' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host "$Root is not here: install first (setup.ps1)." -ForegroundColor Red
    exit 1
}
Write-Host "== HAVOC9: starting everything ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"

# a stop with -KeepStopped (stop-all.ps1) switched the start after a boot off: this start turns it back on
if ((Get-ScheduledTask -TaskName 'havoc9 start-all at boot' -ErrorAction SilentlyContinue).State -eq 'Disabled') { Enable-ScheduledTask -TaskName 'havoc9 start-all at boot' | Out-Null }

# 1. SSH
$ssh = Get-Service sshd -ErrorAction SilentlyContinue
if ($ssh) {
    if ($ssh.StartType -ne 'Automatic') { Set-Service sshd -StartupType Automatic }
    if ($ssh.Status -ne 'Running') { Start-Service sshd -ErrorAction SilentlyContinue }
    $ssh.Refresh()
    Row 'SSH (sshd)' ([string]$ssh.Status) ($ssh.Status -eq 'Running')
} else {
    Row 'SSH (sshd)' 'not installed' $true
}

# 2. the firewall rules this host needs
$rules = @(Get-NetFirewallRule -DisplayName 'havoc9*' -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -DisplayName 'OpenSSH Server' -ErrorAction SilentlyContinue)
foreach ($r in $rules) {
    if ($r.Enabled -ne 'True') { Enable-NetFirewallRule -Name $r.Name }
}
$web = Get-NetFirewallRule -DisplayName 'havoc9 web*' -ErrorAction SilentlyContinue
if ($web) {
    $from = @(($web | Get-NetFirewallAddressFilter).RemoteAddress)
    $fromText = if ($from.Count -eq 1 -and $from[0] -eq 'Any') { 'from everywhere' } else { "from Cloudflare only ($($from.Count) ranges)" }
    Row 'firewall: web 80/443' "on, $fromText" $true
} else {
    Row 'firewall: web 80/443' 'missing: run setup.ps1 again' $false
}
Row 'firewall: other rules' "$(@($rules).Count) rule(s) on" $true

# 3. the services, in the order they depend on each other
$order = @('havoc9-h9web', 'havoc9-serverlist', 'havoc9-p2p', 'havoc9-caddy')
foreach ($name in $order) {
    $s = Get-Service $name -ErrorAction SilentlyContinue
    if (-not $s) {
        if ($name -ne 'havoc9-p2p') { Row $name 'not installed: run setup.ps1' $false }
        continue
    }
    if ($s.StartType -ne 'Automatic') { Set-Service $name -StartupType Automatic }
    if ($s.Status -ne 'Running') {
        Start-Service $name -ErrorAction SilentlyContinue
        try { $s.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) } catch { }
    }
    $s.Refresh()
    Row $name ([string]$s.Status) ($s.Status -eq 'Running')
}

# 4. the scheduled tasks
foreach ($t in @('havoc9 h9web backup', 'havoc9 h9web backup offsite', 'havoc9 log cleanup')) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $task) {
        if ($t -ne 'havoc9 h9web backup offsite') { Row "task: $t" 'missing: run setup.ps1 again' $false }
        continue
    }
    if ($task.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $t | Out-Null; $task = Get-ScheduledTask -TaskName $t }
    $info = $task | Get-ScheduledTaskInfo
    Row "task: $t" "$($task.State), next $($info.NextRunTime)" ($task.State -ne 'Disabled')
}

# 5. checks: give h9web a few seconds after a fresh start
$code = ''
for ($i = 0; $i -lt 15; $i++) { $code = Test-Http 'http://127.0.0.1:8090/api/me'; if ($code -eq '200') { break }; Start-Sleep -Seconds 2 }
Row 'h9web answers (this machine)' "HTTP $code" ($code -eq '200')
$code = Test-Http 'http://127.0.0.1:8081/v1/servers/ts'
Row 'server list answers (this machine)' "HTTP $code" ($code -eq '200')
$code = Test-Http 'http://127.0.0.1:8090/api/presence/servers/auth'
Row 'presence answers (this machine)' "HTTP $code" ($code -eq '200')
$code = Test-Http "https://$Domain/"
Row "site over HTTPS (https://$Domain/)" "HTTP $code" ($code -eq '200')
$code = Test-Http "https://$Domain/serverlist/v1/servers/ts"
Row 'server list over HTTPS' "HTTP $code" ($code -eq '200')

# the code against its fingerprint from the last install or delivery (code-check.ps1)
$cc = Join-Path $Root 'code-check.ps1'
if (Test-Path -LiteralPath $cc) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cc -Root $Root -Check | Out-Null
    $rc = $LASTEXITCODE
    $state = if ($rc -eq 0) { 'unchanged since the last install' } elseif ($rc -eq 2) { 'CHANGED: see logs\code-check.log' } else { 'no fingerprint yet' }
    Row 'code as installed' $state ($rc -eq 0)
}

# the task that runs this script after every boot
if ($InstallBootTask) {
    $self = $MyInvocation.MyCommand.Path
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -Root `"$Root`" -Domain $Domain"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT2M'
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'havoc9 start-all at boot' -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'havoc9.org: start everything two minutes after boot (start-all.ps1)' -Force | Out-Null
    Row 'task: havoc9 start-all at boot' 'made (2 minutes after every boot)' $true
}

Write-Host ''
$Rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
foreach ($name in $order) {
    $s = Get-Service $name -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Running') { Write-Host "== $name did not start"; Show-LogTail $name }
}
if ($Bad) {
    Write-Host "== $Bad part(s) NOT OK: see above. The logs are in $Logs." -ForegroundColor Yellow
    exit 2
}
Write-Host '== everything is up' -ForegroundColor Green
exit 0

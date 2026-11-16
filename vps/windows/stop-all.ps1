<#
.SYNOPSIS
  Stops everything havoc9.org runs on this Windows host: the site goes offline until start-all.ps1 runs.

.DESCRIPTION
  Right-click "Stop-HAVOC9" on the desktop, Run as administrator, or in an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\havoc9\stop-all.ps1                 stop now; the next boot starts it all again
    powershell -ExecutionPolicy Bypass -File C:\havoc9\stop-all.ps1 -KeepStopped    stop, and stay stopped through a reboot

  Stops, in order: havoc9-caddy (HTTPS: visitors then get Cloudflare's "host error" page), havoc9-p2p (when installed),
  havoc9-serverlist (the list and its Discord bot), havoc9-h9web (accounts, forum, presence, the web client's relay).
  Nothing is deleted and no data changes; the backups and the code check keep their schedule. -KeepStopped also sets
  the services to start by hand and switches off the task that starts everything after a boot; start-all.ps1 turns
  both back on. SSH is left running, so the machine stays reachable.
#>
param(
    [switch]$KeepStopped,
    [string]$Root = 'C:\havoc9'
)

$ErrorActionPreference = 'Continue'
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run it as administrator (right-click, Run as administrator).' -ForegroundColor Red; exit 1 }

Write-Host "== HAVOC9: stopping everything ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"
foreach ($name in 'havoc9-caddy', 'havoc9-p2p', 'havoc9-serverlist', 'havoc9-h9web') {
    $s = Get-Service $name -ErrorAction SilentlyContinue
    if (-not $s) { continue }
    if ($s.Status -ne 'Stopped') {
        Stop-Service $name -Force -ErrorAction SilentlyContinue
        try { $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
    }
    if ($KeepStopped) { Set-Service $name -StartupType Manual }
    $s.Refresh()
    Write-Host ('  {0,-20} {1}{2}' -f $name, $s.Status, $(if ($KeepStopped) { ', starts by hand' } else { '' }))
}
if ($KeepStopped) {
    if (Get-ScheduledTask -TaskName 'havoc9 start-all at boot' -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName 'havoc9 start-all at boot' | Out-Null }
    Write-Host '  the start after a boot is off; Start-HAVOC9 (start-all.ps1) turns it all back on'
} else {
    Write-Host '  the next boot starts it all again (or Start-HAVOC9 now)'
}
$bad = @(Get-Service 'havoc9-*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Stopped' })
if ($bad.Count) { Write-Host "== not stopped: $($bad.Name -join ', ')" -ForegroundColor Yellow; exit 2 }
Write-Host '== everything is stopped' -ForegroundColor Green
exit 0

<#
.SYNOPSIS
  Brings the game server's own folder (C:\havoc9\H9XASH) up to the build the site publishes, changing only what differs.

.DESCRIPTION
  The folder is a normal H9XASH install; H9XASH-Updater.exe (the same program players run) updates it from the manifest at
  https://havoc9.org/files/: it downloads the files that are new or changed, checks each SHA-256, swaps them in with a rollback
  copy, and leaves the server's own files alone (configs, keys, ids, logs, data). The exe is the one the site hands out
  (C:\havoc9\site\downloads\H9XASH-Updater.exe), so a release that deploys the site has already put the newest one there.

    powershell -ExecutionPolicy Bypass -File C:\havoc9\update-game.ps1            say what an update would change, change nothing
    powershell -ExecutionPolicy Bypass -File C:\havoc9\update-game.ps1 -Apply     update; the game server must be stopped first
    powershell -ExecutionPolicy Bypass -File C:\havoc9\update-game.ps1 -Rollback  put the files of the last update back

  -Apply refuses while a process runs from the folder (a running server holds its DLLs open, so files could not be replaced); stop
  the server first (or add -StopServer to end it), then start it again with h9xash_server.bat. Nothing here touches the site.
#>
param(
    [switch]$Apply,
    [switch]$Rollback,
    [switch]$StopServer,
    [string]$Root = 'C:\havoc9',
    [string]$Dir = ''
)

$ErrorActionPreference = 'Stop'
trap { Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
if (-not $Dir) { $Dir = Join-Path $Root 'H9XASH' }
$exe = Join-Path $Root 'site\downloads\H9XASH-Updater.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "no $exe (the site's updater download); deploy the site first" }
if (-not (Test-Path -LiteralPath $Dir)) { throw "no game folder $Dir" }

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) })
if (($Apply -or $Rollback) -and $running.Count) {
    if (-not $StopServer) {
        $names = ($running | ForEach-Object { "$($_.ProcessName) ($($_.Id))" }) -join ', '
        throw "the game server is running from $Dir ($names): stop it first, or add -StopServer"
    }
    Write-Host "== stopping $($running.Count) process(es) running from $Dir"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

$updaterArgs = @('--dir', $Dir, '--yes', '--skip-link', '--no-pause')
if ($Rollback) { $updaterArgs += '--rollback' }
elseif (-not $Apply) { $updaterArgs += '--check' }

Write-Host "== H9XASH-Updater $($updaterArgs -join ' ')"
& $exe @updaterArgs
if ($LASTEXITCODE) { throw "the updater said no (exit $LASTEXITCODE); nothing was left half-done: --rollback puts the last files back" }
if ($Apply) { Write-Host "== updated. Start the server with $Dir\h9xash_server.bat (it sets up the Visual C++ runtime on a PC that lacks it)." }
elseif (-not $Rollback) { Write-Host '== check only: nothing changed. Add -Apply to update.' }

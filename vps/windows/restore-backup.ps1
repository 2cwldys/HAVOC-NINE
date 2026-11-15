<#
.SYNOPSIS
  Puts one of havoc9.org's backups back: the accounts, the forum, presence, everything h9web keeps.

.DESCRIPTION
  Right-click "Restore-HAVOC9-Backup" on the desktop, Run as administrator, or in an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\havoc9\restore-backup.ps1            lists the backups and asks which
    ... restore-backup.ps1 -Newest                                                    the newest one
    ... restore-backup.ps1 -File D:\somewhere\h9web-havoc9.org-<time>.h9backup        one from elsewhere

  The backups are in C:\havoc9\data\h9web\backups (every day at 03:30, the newest 14 kept, and one before every update)
  and, once a backup passphrase is set, encrypted ones in C:\havoc9\data\h9web\offsite (03:45, 7 kept). The log of the
  daily ones is C:\havoc9\logs\backup.log.

  What it does, in order, and it stops at the first step that fails:
    1. checks the chosen backup through (h9web-backup.js verify): a damaged one is never restored;
    2. asks you to type RESTORE;
    3. makes a backup of the data as it is now, so this restore can be undone the same way;
    4. stops h9web (havoc9-h9web), restores the backup, and starts h9web again (started again whatever happened);
    5. runs start-all.ps1's checks.
  A backup made with other keys (secrets.json, data.key) is refused: every password and player id depends on them.
  An encrypted backup takes its passphrase from C:\havoc9\etc\backup-passphrase, or the file -PassphraseFile names.
  The log is C:\havoc9\logs\restore-<time>.log.
#>
param(
    [string]$File = '',
    [switch]$Newest,
    [string]$PassphraseFile = '',
    [string]$Root = 'C:\havoc9'
)

$ErrorActionPreference = 'Stop'
$Node = Join-Path $Root 'tools\node\node.exe'
$Tool = Join-Path $Root 'h9web\bin\h9web-backup.js'
$Config = Join-Path $Root 'etc\config.json'
$Folders = @((Join-Path $Root 'data\h9web\backups'), (Join-Path $Root 'data\h9web\offsite'))

$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run it as administrator (right-click, Run as administrator).' -ForegroundColor Red; exit 1 }
foreach ($need in $Node, $Tool, $Config) { if (-not (Test-Path -LiteralPath $need)) { Write-Host "missing: $need (is havoc9.org installed here?)" -ForegroundColor Red; exit 1 } }

# which backup
$all = @(foreach ($d in $Folders) { if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -File -Filter '*.h9backup' } }) | Sort-Object LastWriteTime -Descending
if ($File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Write-Host "no file $File" -ForegroundColor Red; exit 1 }
    $pick = Get-Item -LiteralPath $File
} elseif (-not $all.Count) {
    Write-Host "There are no backups in $($Folders -join ' or ') yet." -ForegroundColor Yellow; exit 1
} elseif ($Newest) {
    $pick = $all[0]
} else {
    Write-Host ''
    Write-Host 'The backups, newest first:'
    for ($i = 0; $i -lt $all.Count; $i++) {
        $f = $all[$i]
        $where = if ($f.DirectoryName -like '*offsite') { 'encrypted, offsite' } else { 'backups' }
        Write-Host ('  {0,2}. {1:yyyy-MM-dd HH:mm}  {2,8:N0} KB  {3}  ({4})' -f ($i + 1), $f.LastWriteTime, ($f.Length / 1KB), $f.Name, $where)
    }
    $n = Read-Host 'Number of the backup to restore (Enter to cancel)'
    if (-not $n) { Write-Host 'Nothing was changed.'; exit 0 }
    if ($n -notmatch '^\d+$' -or [int]$n -lt 1 -or [int]$n -gt $all.Count) { Write-Host 'Not one of the numbers above. Nothing was changed.'; exit 1 }
    $pick = $all[[int]$n - 1]
}
$pass = @()
if ($PassphraseFile) { $pass = @('--passphrase-file', $PassphraseFile) }
elseif (Test-Path -LiteralPath (Join-Path $Root 'etc\backup-passphrase')) { $pass = @('--passphrase-file', (Join-Path $Root 'etc\backup-passphrase')) }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Transcript -LiteralPath (Join-Path $Root "logs\restore-$stamp.log") | Out-Null
function Done([int]$Code) { Stop-Transcript | Out-Null; exit $Code }

Write-Host ''
Write-Host "== 1. checking $($pick.FullName)"
& $Node $Tool verify $pick.FullName @pass
if ($LASTEXITCODE -ne 0) { Write-Host 'That backup does not check out (above). Nothing was changed.' -ForegroundColor Red; Done 1 }

Write-Host ''
Write-Host "This replaces ALL of the site's data (accounts, forum, presence, links) with the backup of $($pick.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))."
Write-Host 'Everything that happened on the site after that time is lost, except in the backup this makes first.'
$ok = Read-Host 'Type RESTORE to go on'
if ($ok -cne 'RESTORE') { Write-Host 'Nothing was changed.'; Done 0 }

Write-Host ''
Write-Host '== 2. a backup of the data as it is now (to undo this restore with this same script)'
& $Node $Tool --config $Config backup --out $Folders[0] --keep 14
if ($LASTEXITCODE -ne 0) { Write-Host 'The backup of the data as it is now failed (above), so nothing was restored.' -ForegroundColor Red; Done 1 }

Write-Host ''
Write-Host '== 3. stop h9web, restore, start h9web'
$rc = 1
try {
    Stop-Service havoc9-h9web -Force
    (Get-Service havoc9-h9web).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    & $Node $Tool --config $Config restore $pick.FullName --yes @pass
    $rc = $LASTEXITCODE
} finally {
    Start-Service havoc9-h9web
}
if ($rc -ne 0) { Write-Host 'The restore failed (above) and h9web was started again. The backup step 2 made holds the data from just before: restore that one if the site is not right.' -ForegroundColor Red; Done 1 }
Write-Host "restored: $($pick.Name)"

Write-Host ''
Write-Host '== 4. checks'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'start-all.ps1') -Root $Root
Done 0

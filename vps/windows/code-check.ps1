<#
.SYNOPSIS
  The fingerprint of everything havoc9.org runs or hands out on this Windows host, and the check against it.

.DESCRIPTION
  -Write   records the SHA-256 of every file of the code (h9web, the site with the downloads and the web client, the
           list, the P2P relay, the tools, the service wrappers, the scripts in the root) in etc\code-fingerprint.txt.
           setup.ps1 and receive-deploy.ps1 run it at the end of an install, an update or a delivery: those are the
           only times code changes. etc\ is writable by SYSTEM and Administrators only, so a service that is broken
           into cannot write the fingerprint to match a file it changed.
  -Check   (the default) compares every file with it: a file changed, added or gone since the last install or delivery
           is listed, written to logs\code-check.log and to the Windows Application log (source havoc9, event 9001),
           and the exit code is 2. start-all.ps1 runs it, and the task "havoc9 code check" every day at 05:30.

  Left out, because they change by design: the list's Python packages' caches (__pycache__, *.pyc) and the downloads'
  SHA256SUMS.txt, which setup.ps1 rewrites.
#>
param(
    [string]$Root = 'C:\havoc9',
    [switch]$Write,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Print = Join-Path $Root 'etc\code-fingerprint.txt'
$Log = Join-Path $Root 'logs\code-check.log'
$Dirs = @('h9web', 'site', 'serverlist', 'p2p', 'tools', 'services', 'game')

function Get-Prints
{
    $out = New-Object 'System.Collections.Generic.SortedDictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    $items = @()
    foreach ($d in $Dirs) {
        $p = Join-Path $Root $d
        if (Test-Path -LiteralPath $p) { $items += @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue) }
    }
    $items += @(Get-ChildItem -LiteralPath $Root -File -Force -ErrorAction SilentlyContinue)
    foreach ($f in $items) {
        $rel = $f.FullName.Substring($Root.Length).TrimStart('\')
        if ($rel -match '\\__pycache__\\|\.pyc$' -or $rel -ieq 'site\downloads\files\SHA256SUMS.txt') { continue }
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { $out[$rel] = 'link:' + [string]@($f.Target)[0]; continue }
        $out[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $out
}

if ($Write) {
    $now = Get-Prints
    $lines = foreach ($k in $now.Keys) { "$($now[$k])  $k" }
    $tmp = "$Print.new"
    [IO.File]::WriteAllLines($tmp, [string[]]$lines)
    Move-Item -LiteralPath $tmp -Destination $Print -Force
    Write-Host "code fingerprint written: $($now.Count) files ($Print)"
    exit 0
}

if (-not (Test-Path -LiteralPath $Print)) { Write-Host "no fingerprint yet ($Print): run setup.ps1, or code-check.ps1 -Write after checking the files"; exit 1 }
$was = @{}
foreach ($line in [IO.File]::ReadAllLines($Print)) { if ($line -match '^(\S+)  (.+)$') { $was[$Matches[2]] = $Matches[1] } }
$now = Get-Prints
$changed = New-Object System.Collections.Generic.List[string]
foreach ($k in $now.Keys) {
    if (-not $was.ContainsKey($k)) { $changed.Add("added    $k") }
    elseif ($was[$k] -ne $now[$k]) { $changed.Add("changed  $k") }
}
foreach ($k in $was.Keys) { if (-not $now.ContainsKey($k)) { $changed.Add("gone     $k") } }
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
if ($changed.Count -eq 0) {
    Add-Content -LiteralPath $Log -Value "$stamp  ok: $($now.Count) files as installed"
    Write-Host "code check: ok, $($now.Count) files as installed"
    exit 0
}
$text = "CODE CHANGED SINCE THE LAST INSTALL OR DELIVERY ($($changed.Count) files):`r`n" + (($changed | Select-Object -First 200) -join "`r`n")
Add-Content -LiteralPath $Log -Value "$stamp  $text"
try {
    if (-not [Diagnostics.EventLog]::SourceExists('havoc9')) { New-EventLog -LogName Application -Source 'havoc9' }
    Write-EventLog -LogName Application -Source 'havoc9' -EventId 9001 -EntryType Warning -Message $text
} catch { }
Write-Host $text -ForegroundColor Yellow
Write-Host "If you did not change these files yourself, treat the server as broken into: look at them, then reinstall from a package you built."
exit 2

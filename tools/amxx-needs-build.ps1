# amxx-needs-build.ps1 -- does a plugin need compiling? (build.bat asks this before every compile)
#
# The AMX Mod X compiler does not write the same file twice: two compiles of one source differ, so every recompile of a plugin
# changes its SHA-256, and the official preset (an allowlist of those hashes, docs\H9_PRESENCE.txt 4d) has to be approved again.
# So a plugin whose source has not changed is not compiled again. This script fingerprints the source and every file it includes
# (#include and #tryinclude, followed through the includes' own includes), and compares it with the fingerprint stored beside the
# last build.
#
#   -Mode check      exit 0: compile it (no output, or its fingerprint changed). exit 1: up to date, keep the file.
#   -Mode stamp      store the fingerprint beside the output (build.bat does it after a compile that produced the file)
#   -Mode bootstrap  store it only when the output is newer than the source and every include (a tree built before this existed)
#
#   -Sma        the plugin's source        -Amxx   its compiled output (the fingerprint goes in <Amxx>.src)
#   -IncludeDirs  the folders #include <name> is searched in, separated by ;  (the source's own folder is searched first)
param(
    [Parameter(Mandatory = $true)][string]$Sma,
    [Parameter(Mandatory = $true)][string]$Amxx,
    [string]$IncludeDirs = "",
    [ValidateSet("check", "stamp", "bootstrap")][string]$Mode = "check"
)
$ErrorActionPreference = "Stop"

$dirs = @((Split-Path -Parent $Sma)) + @($IncludeDirs -split ";" | Where-Object { $_ })
$sha = [System.Security.Cryptography.SHA256]::Create()

function Find-Include([string]$name) {
    $candidates = @($name)
    if (-not $name.EndsWith(".inc")) { $candidates += ($name + ".inc") }
    foreach ($d in $dirs) {
        foreach ($c in $candidates) {
            $p = Join-Path $d $c
            if (Test-Path -LiteralPath $p -PathType Leaf) { return (Resolve-Path -LiteralPath $p).Path }
        }
    }
    return $null
}

# the source and everything it includes, in a fixed order
$seen = [ordered]@{}
$queue = New-Object System.Collections.Queue
$queue.Enqueue((Resolve-Path -LiteralPath $Sma).Path)
while ($queue.Count -gt 0) {
    $file = $queue.Dequeue()
    if ($seen.Contains($file)) { continue }
    $seen[$file] = $true
    $text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::GetEncoding(28591))
    foreach ($m in [regex]::Matches($text, '(?m)^\s*#(?:try)?include\s*[<"]([^>"]+)[>"]')) {
        $inc = Find-Include $m.Groups[1].Value
        if ($inc -and -not $seen.Contains($inc)) { $queue.Enqueue($inc) }
    }
}

$bytes = New-Object System.Collections.Generic.List[byte]
$newest = [datetime]::MinValue
foreach ($f in ($seen.Keys | Sort-Object)) {
    $name = [System.Text.Encoding]::UTF8.GetBytes((Split-Path -Leaf $f).ToLowerInvariant() + "`n")
    $bytes.AddRange($name)
    $bytes.AddRange([System.IO.File]::ReadAllBytes($f))
    $t = (Get-Item -LiteralPath $f).LastWriteTimeUtc
    if ($t -gt $newest) { $newest = $t }
}
$fingerprint = ([System.BitConverter]::ToString($sha.ComputeHash($bytes.ToArray()))).Replace("-", "").ToLowerInvariant()
$stampFile = $Amxx + ".src"

switch ($Mode) {
    "stamp" {
        [System.IO.File]::WriteAllText($stampFile, $fingerprint + "`r`n")
        exit 0
    }
    "bootstrap" {
        if ((Test-Path -LiteralPath $Amxx) -and -not (Test-Path -LiteralPath $stampFile) -and ((Get-Item -LiteralPath $Amxx).LastWriteTimeUtc -ge $newest)) {
            [System.IO.File]::WriteAllText($stampFile, $fingerprint + "`r`n")
            Write-Output ("stamped " + (Split-Path -Leaf $Amxx))
        }
        exit 0
    }
    default {
        if (-not (Test-Path -LiteralPath $Amxx) -or -not (Test-Path -LiteralPath $stampFile)) { exit 0 }
        $was = ([System.IO.File]::ReadAllText($stampFile)).Trim()
        if ($was -eq $fingerprint) { exit 1 }
        exit 0
    }
}

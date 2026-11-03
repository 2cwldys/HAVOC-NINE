<#
check-lfs.ps1 -- refuses game folders that hold Git LFS pointers or cut-short game files.

    & tools\check-lfs.ps1 -Path <folder> [<folder> ...]      exit 0: fine; exit 1: listed, with the fix

The repository keeps its maps, models and archives (.bsp, .mdl, .zip, .7z, .rar, .bsp.ztmp) in
Git LFS. A clone made without Git LFS has, in place of each of them, a text file of about 130
bytes that starts "version https://git-lfs.github.com/spec/v1". A package or a web client staged
from that would ship those text files as maps and models. This finds them, and also any .bsp, .mdl,
.wad, .pk3 or .zip whose own header says it is longer than the file is (a download cut short, or a
file copied while it was being written):

    .bsp   version 30, or BSP2: the end of its furthest lump
    .mdl   IDST or IDSQ: the length in its header
    .wad   WAD2 or WAD3: the end of its lump directory
    .pk3, .zip   the end-of-central-directory record in its last 64 KB

The build scripts run it on the folders they read before anything is written (docs\BUILDING.txt).
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string[]]$Path)

$ErrorActionPreference = 'Stop'
$Pointer = [Text.Encoding]::ASCII.GetBytes('version https://git-lfs.github.com/spec/v1')
$Problems = New-Object System.Collections.ArrayList
$Checked = 0

function Read-Head([string]$File, [int]$Count) {
    $fs = [IO.File]::OpenRead($File)
    try {
        $buf = New-Object byte[] $Count
        $n = $fs.Read($buf, 0, $Count)
        if ($n -lt $Count) { $b2 = New-Object byte[] $n; [Array]::Copy($buf, $b2, $n); return ,$b2 }
        return ,$buf
    } finally { $fs.Dispose() }
}

function Test-Prefix([byte[]]$Data, [byte[]]$Prefix) {
    if ($Data.Length -lt $Prefix.Length) { return $false }
    for ($i = 0; $i -lt $Prefix.Length; $i++) { if ($Data[$i] -ne $Prefix[$i]) { return $false } }
    return $true
}

function Get-Short([IO.FileInfo]$F) {
    $ext = $F.Extension.ToLowerInvariant()
    $len = $F.Length
    if ($ext -eq '.bsp') {
        if ($len -lt 124) { return "a .bsp of $len bytes" }
        $h = Read-Head $F.FullName 124
        $magic = [Text.Encoding]::ASCII.GetString($h, 0, 4)
        $version = [BitConverter]::ToInt32($h, 0)
        if ($version -ne 30 -and $magic -ne 'BSP2' -and $magic -ne '2PSB') { return 'not a GoldSrc or BSP2 map' }
        $need = 0
        for ($i = 0; $i -lt 15; $i++) {
            $end = [int64][BitConverter]::ToInt32($h, 4 + $i * 8) + [BitConverter]::ToInt32($h, 8 + $i * 8)
            if ($end -gt $need) { $need = $end }
        }
        if ($need -gt $len) { return "its lumps end at $need bytes, the file has $len" }
    } elseif ($ext -eq '.mdl') {
        if ($len -lt 76) { return "a .mdl of $len bytes" }
        $h = Read-Head $F.FullName 76
        $magic = [Text.Encoding]::ASCII.GetString($h, 0, 4)
        if ($magic -ne 'IDST' -and $magic -ne 'IDSQ') { return 'not a studio model' }
        $need = [BitConverter]::ToInt32($h, 72)
        if ($need -gt $len) { return "its header says $need bytes, the file has $len" }
    } elseif ($ext -eq '.wad') {
        if ($len -lt 12) { return "a .wad of $len bytes" }
        $h = Read-Head $F.FullName 12
        $magic = [Text.Encoding]::ASCII.GetString($h, 0, 4)
        if ($magic -ne 'WAD2' -and $magic -ne 'WAD3') { return 'not a WAD' }
        $need = [int64][BitConverter]::ToInt32($h, 8) + [int64][BitConverter]::ToInt32($h, 4) * 32
        if ($need -gt $len) { return "its directory ends at $need bytes, the file has $len" }
    } elseif ($ext -eq '.pk3' -or $ext -eq '.zip') {
        if ($len -lt 22) { return "an archive of $len bytes" }
        $tail = [int][Math]::Min($len, 65557)
        $fs = [IO.File]::OpenRead($F.FullName)
        try {
            [void]$fs.Seek(-$tail, [IO.SeekOrigin]::End)
            $buf = New-Object byte[] $tail
            [void]$fs.Read($buf, 0, $tail)
        } finally { $fs.Dispose() }
        $found = $false
        for ($i = $tail - 22; $i -ge 0; $i--) {
            if ($buf[$i] -eq 0x50 -and $buf[$i + 1] -eq 0x4B -and $buf[$i + 2] -eq 5 -and $buf[$i + 3] -eq 6) { $found = $true; break }
        }
        if (-not $found) { return 'no end-of-archive record: cut short' }
    }
    return $null
}

foreach ($p in $Path) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $root = (Resolve-Path -LiteralPath $p).Path
    $files = if (Test-Path -LiteralPath $root -PathType Leaf) { @(Get-Item -LiteralPath $root) }
             else { Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue }
    foreach ($f in $files) {
        $Checked++
        if ($f.Length -lt 1024 -and (Test-Prefix (Read-Head $f.FullName $Pointer.Length) $Pointer)) {
            [void]$Problems.Add(@{ File = $f.FullName; Why = 'a Git LFS pointer, not the file'; Lfs = $true })
            continue
        }
        $why = Get-Short $f
        if ($why) { [void]$Problems.Add(@{ File = $f.FullName; Why = $why; Lfs = $false }) }
    }
}

if ($Problems.Count -eq 0) {
    Write-Host ("  check-lfs: {0} files, no Git LFS pointer and no cut-short game file" -f $Checked)
    exit 0
}

$lfs = @($Problems | Where-Object { $_.Lfs }).Count
Write-Host ''
Write-Host ("STOP: {0} of the files this needs are not whole ({1} of them Git LFS pointers):" -f $Problems.Count, $lfs) -ForegroundColor Red
$Problems | Select-Object -First 25 | ForEach-Object { Write-Host ("  {0}  -- {1}" -f $_.File, $_.Why) }
if ($Problems.Count -gt 25) { Write-Host ("  ... and {0} more" -f ($Problems.Count - 25)) }
Write-Host ''
if ($lfs -gt 0) {
    Write-Host 'This clone was made without Git LFS, which holds the maps, models and archives. To fix it:'
    Write-Host '  1. install Git LFS (https://git-lfs.com; Git for Windows includes it)'
    Write-Host '  2. in this checkout:   git lfs install'
    Write-Host '                         git lfs pull'
    Write-Host 'then run this again. If git lfs pull fails with a quota or bandwidth error, the files are'
    Write-Host 'not downloadable from that host right now; get them from a release ZIP instead.'
} else {
    Write-Host 'Get these files again (git lfs pull, or git checkout -- <file>), then run this again.'
}
exit 1

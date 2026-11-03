<#
.SYNOPSIS
  Builds dist\H9XASH-Updater.exe from the sources beside this script.

.DESCRIPTION
  The same sources give the same exe:
    - Python 3.12 (the py launcher's, or -Python), in a venv of its own under -WorkDir holding
      exactly the packages pinned in requirements-build.txt;
    - PyInstaller, one-file console exe, no UPX, PYTHONHASHSEED=0 and a fixed build time
      (SOURCE_DATE_EPOCH), the version resource made from VERSION in h9xash_updater.py
      and the icon from game.ico at the repo root;
    - PyInstaller's spec, work files and caches, pip's cache and every temporary file stay in
      -WorkDir: only H9XASH-Updater.exe goes in dist\.
  The exe is then run once (--version), and its size and SHA-256 are printed.

.PARAMETER WorkDir
  Where the venv, the caches and PyInstaller's work files go. Default: .build beside this script
  (git ignores it).

.PARAMETER Python
  The python.exe to build the venv from. Default: py -3.12.

.PARAMETER UseInstalled
  Use -Python's own PyInstaller instead of a venv (it must be the pinned version). For machines
  without network access to PyPI.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -WorkDir D:\temp\updater-work
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [string]$Python,
    [switch]$UseInstalled
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path (Join-Path $Here '..\..')).Path
if (-not $WorkDir) { $WorkDir = Join-Path $Here '.build' }
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
$Dist = Join-Path $Repo 'dist'
$Exe = Join-Path $Dist 'H9XASH-Updater.exe'
$Main = Join-Path $Here 'h9xash_updater.py'
$Icon = Join-Path $Repo 'game.ico'

function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '').ToLowerInvariant() }
    finally { $fs.Dispose(); $sha.Dispose() }
}

# Everything this build writes, temporary files included, goes under the work folder.
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$tmp = Join-Path $WorkDir 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TMP = $tmp
$env:TEMP = $tmp
$env:PIP_CACHE_DIR = Join-Path $WorkDir 'pip-cache'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $WorkDir 'pyinstaller-cache'
$env:PYTHONHASHSEED = '0'
# The PE header's build time is fixed at 1980-01-01, so the same sources always give the same exe.
$env:SOURCE_DATE_EPOCH = '315532800'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'

$m = Select-String -LiteralPath $Main -Pattern "^VERSION = '(\d+)\.(\d+)\.(\d+)'" | Select-Object -First 1
if (-not $m) { throw "No VERSION = 'x.y.z' line in $Main" }
$v = $m.Matches[0].Groups
$version = "$($v[1].Value).$($v[2].Value).$($v[3].Value)"
Write-Host "H9XASH-Updater $version"

if ($Python) {
    $basePy = $Python
} else {
    $basePy = (& py -3.12 -c "import sys; print(sys.executable)" 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $basePy) { throw 'No Python 3.12 through the py launcher; pass -Python <python.exe>.' }
}
if ($UseInstalled) {
    $py = $basePy
} else {
    $venv = Join-Path $WorkDir 'venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $py)) {
        Write-Host "venv: $venv"
        & $basePy -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw 'venv failed' }
    }
    & $py -m pip install --no-input -q -r (Join-Path $Here 'requirements-build.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
}
$pyver = (& $py -c "import sys; print('%d.%d.%d' % sys.version_info[:3])")
$piver = (& $py -m PyInstaller --version)
$want = (Select-String -LiteralPath (Join-Path $Here 'requirements-build.txt') -Pattern '^pyinstaller==(\S+)').Matches[0].Groups[1].Value
if ($piver -ne $want) { throw "PyInstaller $piver found, requirements-build.txt pins $want" }
Write-Host "Python $pyver, PyInstaller $piver"

# The version resource Windows shows under Properties, Details.
$verFile = Join-Path $WorkDir 'version_info.txt'
$tuple = "$($v[1].Value), $($v[2].Value), $($v[3].Value), 0"
$verText = @"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($tuple), prodvers=($tuple), mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'HAVOC 9'),
      StringStruct('FileDescription', 'H9XASH Updater'),
      StringStruct('FileVersion', '$version'),
      StringStruct('InternalName', 'H9XASH-Updater'),
      StringStruct('OriginalFilename', 'H9XASH-Updater.exe'),
      StringStruct('ProductName', 'H9XASH'),
      StringStruct('ProductVersion', '$version')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@
[IO.File]::WriteAllText($verFile, $verText, [Text.Encoding]::ASCII)

$piArgs = @('-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--console', '--noupx',
    '--name', 'H9XASH-Updater', '--version-file', $verFile,
    '--distpath', $Dist, '--workpath', (Join-Path $WorkDir 'work'), '--specpath', $WorkDir,
    '--paths', $Here, '--log-level', 'WARN')
if (Test-Path -LiteralPath $Icon) { $piArgs += @('--icon', $Icon) }
$piArgs += $Main
Push-Location $WorkDir
try {
    & $py @piArgs
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$out = (& $Exe --version) 2>&1
if ("$out" -notmatch [regex]::Escape("H9XASH-Updater $version")) { throw "the new exe answered '$out' to --version" }
$len = (Get-Item -LiteralPath $Exe).Length
Write-Host ("{0}: {1:N0} bytes, SHA-256 {2}" -f $Exe, $len, (Get-Sha256 $Exe))
Write-Host 'Built. Test it with: py -3 tools\updater\test_updater.py --work <scratch folder> --exe dist\H9XASH-Updater.exe'

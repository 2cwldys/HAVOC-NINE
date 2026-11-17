# Build Stripper2 as a 32-bit Windows Metamod plugin (.dll) with MSBuild, the Windows counterpart of
# build-linux.sh and the same idea as EntMod4/src/build-windows.ps1. Compiles the five plugin sources
# via Stripper2/src/dlls/msvc/Stripper2.vcxproj (modeled on EntMod4/src/EntMod4/msvc/EntMod.vcxproj).
# Requires Visual Studio with the "C++ Win32" toolset. Run in PowerShell:
#     powershell -ExecutionPolicy Bypass -File Stripper2\build-windows.ps1
# Output: Stripper2\dist\stripper2_mm.dll
# Platform toolset: v143 by default; pass -Toolset v142/v141/... if v143 is not installed.
param([string]$Toolset = "v143")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Join-Path $here "src\dlls\msvc\Stripper2.vcxproj"

# Locate MSBuild via vswhere (covers VS2019..VS2026, incl. Insiders), else PATH.
$msb = $null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
	$msb = & $vswhere -latest -prerelease -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" |
		Select-Object -First 1
}
if (-not $msb) { $msb = (Get-Command MSBuild.exe -ErrorAction SilentlyContinue).Source }
if (-not $msb) { throw "MSBuild.exe not found. Install Visual Studio with the Desktop C++ workload (Win32 toolset)." }

Write-Host "=== building Stripper2 (Windows .dll, $Toolset) ==="
& $msb $proj /p:Configuration=Release /p:Platform=Win32 /p:PlatformToolset=$Toolset /m /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw "Stripper2 Windows build failed (exit $LASTEXITCODE)." }

$dist = Join-Path $here "dist"
Write-Host "=== done -> $dist\stripper2_mm.dll ==="
Get-ChildItem (Join-Path $dist "stripper2_mm.dll") | Format-Table Name, Length, LastWriteTime -AutoSize

# Build EntMod + HookMod as 32-bit Windows Metamod plugins (.dll) with MSBuild.
# Requires Visual Studio with the "C++ Win32" toolset (v143 or v145). Run in PowerShell:
#     powershell -ExecutionPolicy Bypass -File EntMod4\src\build-windows.ps1
# Output: EntMod4\dist\{EntMod_MM.dll, HookMod_MM.dll}
# Platform toolset: v143 (VS2022) by default; pass -Toolset v145 (VS2026) or another installed
# toolset if v143 is not present.
param([string]$Toolset = "v143")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Locate MSBuild via vswhere (covers VS2019..VS2026, incl. Insiders), else PATH.
$msb = $null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
	$msb = & $vswhere -latest -prerelease -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" |
		Select-Object -First 1
}
if (-not $msb) { $msb = (Get-Command MSBuild.exe -ErrorAction SilentlyContinue).Source }
if (-not $msb) { throw "MSBuild.exe not found. Install Visual Studio with the Desktop C++ workload (Win32 toolset)." }

foreach ($proj in @("EntMod4\msvc\EntMod.vcxproj", "HookMod\msvc\HookMod.vcxproj")) {
	Write-Host "=== building $proj (Windows .dll, $Toolset) ==="
	& $msb (Join-Path $here $proj) /p:Configuration=Release /p:Platform=Win32 /p:PlatformToolset=$Toolset /m /v:minimal /nologo
	if ($LASTEXITCODE -ne 0) { throw "MSBuild failed for $proj (exit $LASTEXITCODE)." }
}

$dist = Join-Path $here "..\dist"
Write-Host "=== done -> $dist\{EntMod_MM.dll, HookMod_MM.dll} ==="
Get-ChildItem (Join-Path $dist "*.dll") | Format-Table Name, Length, LastWriteTime -AutoSize

# Build Stripper2 as a 32-bit Windows Metamod plugin (.dll), the Windows counterpart of build-linux.sh
# and the same idea as EntMod4/src/build-windows.ps1. Stripper2 ships only a VC6 project
# (src/dlls/stripper2_mm.dsp) that MSBuild cannot read, so this compiles the five plugin sources with
# cl.exe directly. Run in PowerShell with the VS "C++ x86" toolset:
#     powershell -ExecutionPolicy Bypass -File Stripper2\build-windows.ps1
# Output: Stripper2\dist\stripper2_mm.dll
#
# NOTE: Stripper2's source was written for the classic Metamod SDK. H9XASH runs Metamod-R, whose
# headers differ, and the classic SDK is not in this tree, so h_export.cpp / dllapi.cpp need a small
# port before this links cleanly (same metamod entry points EntMod4/src/EntMod4 was reconstructed to).
# The for-loop scope fix in config.cpp is already applied. The last shipped binary is in
# Stripper2\plugin\stripper2_mm.dll.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here "src\dlls"
$meta = Join-Path $here "..\EntMod4\src\EntMod4\include\metamod"   # Stripper2 ships no metamod headers
$out  = Join-Path $here "dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Locate cl.exe (x86) via vswhere, then the x86 developer environment.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere not found; install Visual Studio with the Desktop C++ workload." }
$vsRoot = & $vswhere -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (-not $vsRoot) { throw "No VS C++ toolset found." }

$sources = @("config.cpp","dllapi.cpp","h_export.cpp","sdk_util.cpp","stripper2_api.cpp")
$incs = @("/I`"$src`"","/I`"$(Join-Path $here 'src\engine')`"","/I`"$(Join-Path $here 'src\common')`"","/I`"$meta`"")
$defs = @("/Dstricmp=_stricmp","/Dstrcmpi=_stricmp","/DWIN32","/D_WINDOWS")

# Run cl.exe inside the x86 dev shell (vcvars32) so the 32-bit toolset and libs are on PATH.
$clArgs = ($defs + $incs + @("/nologo","/O2","/MT","/EHsc","/c") + ($sources | ForEach-Object { "`"$(Join-Path $src $_)`"" })) -join ' '
$link = "/nologo /DLL /MACHINE:X86 /OUT:`"$(Join-Path $out 'stripper2_mm.dll')`" " + (($sources | ForEach-Object { "`"$($_ -replace '\.cpp$','.obj')`"" }) -join ' ')
$cmd = "call `"$vsRoot\VC\Auxiliary\Build\vcvars32.bat`" >NUL && cd /d `"$out`" && cl $clArgs && link $link"
Write-Host "=== building Stripper2 (Windows .dll) ==="
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "Stripper2 Windows build failed (exit $LASTEXITCODE)." }
Write-Host "=== done -> $out\stripper2_mm.dll ==="
Get-ChildItem (Join-Path $out "stripper2_mm.dll") | Format-Table Name, Length, LastWriteTime -AutoSize

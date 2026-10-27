# Drops mp.dll/client.dll into reTS\binaries\ts\, the staging folder xash.bat's assemble step
# copies from.
#
# Default: copy the pristine release_binaries build. reTS was extracted from a zip, not cloned,
# so it carries no git history to pin a source commit to -- building from its HEAD instead
# produces a RETS_INTERFACE_VERSION handshake that does not match the paired reTSX AMXX module.
# That mismatch breaks every ReTS_GetInterface-dependent native silently (ts_setusercash,
# weaponrestriction, ...: the interface call just returns null, no error) -- confirmed the hard
# way once already. Set RETS_REBUILD=1 to build from source instead (picks up the two
# ts_matchmode-facing source patches in ts_powerup.cpp/ts_gun.cpp) once that mismatch is solved;
# until then this stays off by default.
$ErrorActionPreference = "Stop"
$reTS = Split-Path -Parent $PSScriptRoot
$dlls = Join-Path $reTS "binaries\ts\dlls"
$cldlls = Join-Path $reTS "binaries\ts\cl_dlls"
New-Item -ItemType Directory -Force -Path $dlls, $cldlls | Out-Null

if ($env:RETS_REBUILD -ne "1") {
    $release = Join-Path $reTS "release_binaries\ts"
    Copy-Item (Join-Path $release "dlls\mp.dll") (Join-Path $dlls "mp.dll") -Force
    Copy-Item (Join-Path $release "cl_dlls\client.dll") (Join-Path $cldlls "client.dll") -Force
    Write-Host "  reTS: pristine release_binaries -> binaries\ts\ (RETS_REBUILD=1 builds from source instead)"
    exit 0
}

$buildDir = Join-Path $reTS "build-win32"

if (-not (Test-Path (Join-Path $buildDir "CMakeCache.txt"))) {
    cmake -B $buildDir -A Win32 -S $reTS
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
}

cmake --build $buildDir --config Release --target hl client --parallel 2
if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

Copy-Item (Join-Path $buildDir "dlls\Release\hl.dll") (Join-Path $dlls "mp.dll") -Force
Copy-Item (Join-Path $buildDir "cl_dll\Release\client.dll") (Join-Path $cldlls "client.dll") -Force

Write-Host "  reTS built from source -> binaries\ts\dlls\mp.dll, binaries\ts\cl_dlls\client.dll (verify ReTS_GetInterface-dependent natives before shipping this)"

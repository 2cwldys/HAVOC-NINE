# Writes The Specialists' liblist.gam. -HalfLife is the Half-Life folder, the one that holds ts\; without
# it the folder is found from Steam's own record of where it keeps its libraries.
param([string]$HalfLife)

function Find-HalfLife {
    $steam = $null
    foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
        $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if (-not $item) { continue }
        $path = if ($item.SteamPath) { $item.SteamPath } else { $item.InstallPath }
        if ($path -and (Test-Path -LiteralPath $path)) { $steam = $path; break }
    }
    if (-not $steam) { return $null }
    $libraries = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdf) {
        foreach ($m in [regex]::Matches((Get-Content -LiteralPath $vdf -Raw), '"path"\s+"([^"]+)"')) {
            $libraries += ($m.Groups[1].Value -replace '\\\\', '\')
        }
    }
    foreach ($library in $libraries) {
        $candidate = Join-Path $library 'steamapps\common\Half-Life'
        if (Test-Path -LiteralPath (Join-Path $candidate 'ts')) { return $candidate }
    }
    return $null
}

if (-not $HalfLife) { $HalfLife = Find-HalfLife }
if (-not $HalfLife -or -not (Test-Path -LiteralPath (Join-Path $HalfLife 'ts'))) {
    Write-Error 'Half-Life with The Specialists was not found. Pass the folder that holds ts\ as -HalfLife <folder>.'
    exit 1
}

$lines = @(
    'game "The Specialists"',
    'url_info "http://www.specialistsmod.net"',
    'url_dl "http://www.specialistsmod.net"',
    'version "3.0"',
    'size ""',
    'svonly "0"',
    'cldll "cl_dlls\client.dll"',
    'hlversion "1110"',
    'type "multiplayer_only"',
    'nomodels "0"',
    'mpentity "info_player_deathmatch"',
    'icon "TS_big"',
    '//edicts "2048"',
    '',
    'gamedll "addons\metamod\dlls\metamod.dll"',
    '',
    '// I have never known this to actually let you specify a file other then dlls/ts_i386.so',
    '// If you want a port to a different architecture, get on the forums and send a PM to Vino.',
    '// Note that the file ts_i386.so is just a symlink to ts_i686.so, 3.0 was not released with a 386 binary.',
    'gamedll_linux "dlls/ts_i386.so"'
)
[System.IO.File]::WriteAllLines((Join-Path $HalfLife 'ts\liblist.gam'), $lines)
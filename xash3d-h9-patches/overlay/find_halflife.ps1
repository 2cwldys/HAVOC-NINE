# Prints the valve folder of a Steam Half-Life install, or nothing if none is found.
# Used by h9xash.bat: H9XASH ships without Valve's files, so it borrows yours.
$roots = @()
foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($item.SteamPath)   { $roots += $item.SteamPath }
    if ($item.InstallPath) { $roots += $item.InstallPath }
}
$libs = @()
foreach ($root in ($roots | Select-Object -Unique)) {
    $libs += $root
    $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        # "path" "D:\SteamLibrary" in current Steam, "1" "D:\SteamLibrary" in older ones.
        foreach ($m in (Select-String -Path $vdf -Pattern '"(?:path|\d+)"\s+"([^"]+)"' -AllMatches)) {
            foreach ($g in $m.Matches) { $libs += ($g.Groups[1].Value.Replace(([string][char]92) * 2, [string][char]92)) }
        }
    }
}
foreach ($lib in ($libs | Select-Object -Unique)) {
    $valve = Join-Path $lib 'steamapps\common\Half-Life\valve'
    if (Test-Path (Join-Path $valve 'gfx.wad')) { Write-Output $valve; exit 0 }
}
exit 1

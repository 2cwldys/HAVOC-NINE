# h9_vcruntime.ps1 -- first-time setup: the Visual C++ runtime the bot plugin needs.
#
# rcbot_mm.dll (the bots) is a 32-bit Visual C++ program: it needs msvcp140.dll and vcruntime140.dll. A PC that has played other games
# or installed Office has them; a fresh Windows (a new VPS, a clean Windows Server) does not, and Windows then refuses to load the plugin
# without a word: the server answers "Unknown command rcbot". h9xash.bat and h9xash_server.bat run this first. It does nothing when this PC
# already has the two files (in Windows' own 32-bit folder, or beside the game from an earlier run). When it lacks one, it copies the pair
# the package carries (redist\vc14-x86, Microsoft's Visual C++ Redistributable files, which Microsoft allows an application to ship beside
# itself) next to HAVOC 9.exe, where Windows looks first. No installer, no download, no administrator rights.
#
# It never stops the game: any problem prints one line and the launcher goes on.
$ErrorActionPreference = 'Stop'
try {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $sys = Join-Path $env:SystemRoot 'SysWOW64'
    if (-not (Test-Path -LiteralPath $sys)) { $sys = Join-Path $env:SystemRoot 'System32' }   # a 32-bit Windows
    $missing = @()
    foreach ($n in @('msvcp140.dll', 'vcruntime140.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sys $n)) -and -not (Test-Path -LiteralPath (Join-Path $here $n))) { $missing += $n }
    }
    if ($missing.Count -eq 0) { exit 0 }
    $pack = Join-Path $here 'redist\vc14-x86'
    foreach ($n in $missing) {
        $from = Join-Path $pack $n
        if (-not (Test-Path -LiteralPath $from)) {
            Write-Host "[H9] The Visual C++ runtime file $n is missing on this PC and not in ${pack}: the bots (rcbot) will not load. Install 'Microsoft Visual C++ Redistributable 2015-2022 (x86)' from microsoft.com."
            continue
        }
        Copy-Item -LiteralPath $from -Destination (Join-Path $here $n) -Force
        Write-Host "[H9] First-time setup: $n (the Visual C++ runtime the bots need) copied next to the game."
    }
} catch {
    Write-Host "[H9] The Visual C++ runtime check could not finish: $($_.Exception.Message). The game starts anyway; the bots may not load."
}
exit 0

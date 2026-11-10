# mirror-check.ps1 -- after a build and export: is the git working copy in step with the TSM masters?
# Compares the compiled plugins and their sources in TSM with the copies in the git working copy, and prints one line per difference.
# It changes nothing. Exit code: the number of differences (build.bat only reports it).
param(
    [string]$Tsm = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$Repo = 'D:\GIT Storage\ts_h9_team_elimination'
)
if (-not (Test-Path $Repo)) { Write-Host "  mirror check: $Repo is not there, skipped"; exit 0 }

$plugins = 'ts_matchmode', 'ts_probe', 'ts_advertise', 'ts_floatchat', 'ts_uplink', 'ts_survival', 'ts_mechwarrior', 'ts_assault', 'ts_ctf',
           'h9_presence', 'h9_community', 'h9_motd', 'tsrp_roambots', 'ts_rtv', 'h9_compete', 'h9_link', 'h9_rank', 'h9_msgstats', 'h9_staticprops'
$pairs = @()
foreach ($p in $plugins) {
    $pairs += , @("$Tsm\H9XASH\ts\addons\amxmodx\plugins\$p.amxx", "$Repo\H9XASH\ts\addons\amxmodx\plugins\$p.amxx")
    $pairs += , @("$Tsm\$p.sma", "$Repo\H9XASH\ts\addons\amxmodx\scripting\$p.sma")
    if (Test-Path "$Repo\src\$p.sma") { $pairs += , @("$Tsm\$p.sma", "$Repo\src\$p.sma") }
}
$pairs += , @("$Tsm\ts_matchmode.cfg", "$Repo\ts\addons\amxmodx\configs\ts_matchmode.cfg")
$pairs += , @("$Tsm\COMMANDS.txt", "$Repo\docs\COMMANDS.txt")
foreach ($f in Get-ChildItem "$Tsm\H9XASH\presets\official-preset*.json") { $pairs += , @($f.FullName, "$Repo\H9XASH\presets\$($f.Name)") }
$pairs += , @("$Tsm\havoc9.org\downloads\index.html", "$Repo\havoc9.org\downloads\index.html")
foreach ($t in 'preset-check.mjs', 'release-check.mjs') { $pairs += , @("$Tsm\tools\$t", "$Repo\tools\$t") }

$diff = 0; $checked = 0
foreach ($pair in $pairs) {
    $a = $pair[0]; $b = $pair[1]
    if (-not (Test-Path $a)) { continue }          # a plugin that is not part of this build
    $checked++
    if (-not (Test-Path $b)) { Write-Host "  [MIRROR] missing in the git copy: $b"; $diff++; continue }
    if ((Get-FileHash $a -Algorithm SHA256).Hash -ne (Get-FileHash $b -Algorithm SHA256).Hash) {
        $na = (Get-Item $a).LastWriteTime.ToString('MM-dd HH:mm'); $nb = (Get-Item $b).LastWriteTime.ToString('MM-dd HH:mm')
        Write-Host "  [MIRROR] differs: $b  (master $na, git copy $nb)"
        $diff++
    }
}
if ($diff -eq 0) { Write-Host "  mirror check: $checked files, the git copy is in step with the masters" }
else { Write-Host "  mirror check: $diff of $checked differ -- run the build again, or look at the lines above before committing" }
exit $diff

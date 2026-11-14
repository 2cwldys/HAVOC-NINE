<#
.SYNOPSIS
  Builds H9's Linux i386 server in WSL2 with one command and lays it out as H9XASH-linux\.

.DESCRIPTION
  Runs linux\build-linux.sh in the WSL2 distro h9build (Ubuntu 22.04 with the 32-bit toolchain;
  -Setup installs it) against this folder's sources: reTS's game library, Metamod-R, the
  dedicated engine built from the patched Xash3D FWGS tree, AMX Mod X with reTSX, RCBot with
  H9's patches. The result is H9XASH-linux\ beside this script, the native build folder
  stage-h9xash.ps1 packs: dist\H9XASH-linux-server.zip (a build with the xash3d client in it
  gives dist\H9XASH-linux.zip). Every step and the layout are described in
  linux\build-linux.sh; docs\LINUX_SUPPORT.txt has the whole plan.

  One heavy job at a time: with the lock file D:\temp\HEAVY-JOB.lock present (another build is
  running on this PC) nothing starts. The build runs at nice 10 with 4 jobs.

  After a successful build it records what each step was built from in H9XASH-linux\INPUTS.json
  (node tools\linux-sync.mjs --record), so that node tools\linux-sync.mjs can say later which step
  has fallen behind its sources and whether H9XASH-linux is still in step with H9XASH
  (docs\LINUX_BUILD_LAYOUT.txt).

.PARAMETER Steps
  The steps to run: rets metamod engine amxx rcbot assemble. Default: all of them, less -Skip.

.PARAMETER Skip
  Steps left out of the default run, e.g. -Skip amxx (until AMBuild is installed).

.PARAMETER Setup
  Install the build tools in the distro first (linux\h9build-setup.sh, as root).

.PARAMETER WithAmbuild
  With -Setup: also install AMBuild from github.com/alliedmodders/ambuild, which builds AMX Mod X.

.PARAMETER Stage
  After the build, pack the ZIPs with stage-h9xash.ps1, while the lock is still held. That script
  lives in the repository (the git mirror export.bat fills, named by the set "REPO=" line of
  export.bat) when it is not beside this one: the H9XASH-linux just built is copied there the way
  export.bat copies it, and the mirror's own H9XASH is packed as it stands, so run export.bat first
  (a build, then export, is the usual order). The ZIPs are written to the mirror's dist\.

.PARAMETER Distro
  The WSL2 distro to build in. Default: h9build.

.EXAMPLE
  .\build-linux.ps1 -Setup -WithAmbuild
  .\build-linux.ps1
  .\build-linux.ps1 -Steps rcbot,assemble
  .\build-linux.ps1 -Skip amxx -Stage
#>
[CmdletBinding()]
param(
    [string[]]$Steps = @(),
    [string[]]$Skip = @(),
    [switch]$Setup,
    [switch]$WithAmbuild,
    [switch]$Stage,
    [string]$Distro = 'h9build',
    [int]$Jobs = 4
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Wsl([string[]]$WslArgs) {
    & wsl.exe @WslArgs | Out-Host
    return $LASTEXITCODE
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'wsl.exe is not installed: this needs WSL2.' }
$distros = @((& wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($distros -notcontains $Distro) {
    throw "No WSL distro named $Distro (wsl -l -q lists: $($distros -join ', ')). Make it with: wsl --install Ubuntu-22.04 --web-download --no-launch, then wsl --export / --import it as $Distro on the drive that has room, then run this with -Setup."
}

$lock = if ($env:H9_HEAVY_LOCK) { $env:H9_HEAVY_LOCK } else { 'D:\temp\HEAVY-JOB.lock' }
if (Test-Path -LiteralPath $lock) {
    throw "$lock exists: another heavy job is running on this PC (one at a time). Wait for it, or remove the file when it is stale."
}

$linuxDir = Join-Path $Here 'linux'
foreach ($f in 'build-linux.sh', 'h9build-setup.sh', 'h9xash_server.sh') {
    if (-not (Test-Path -LiteralPath (Join-Path $linuxDir $f))) { throw "No $linuxDir\$f." }
}
$src = (& wsl.exe -d $Distro -- wslpath -a ($Here.TrimEnd('\').Replace('\', '/'))) -replace "`0", ''
$src = ([string]($src | Select-Object -First 1)).Trim()
if (-not $src.StartsWith('/')) { throw "wslpath gave no path for $Here ($src)." }

# The scripts run with LF line ends whatever a checkout did to them.
foreach ($f in 'build-linux.sh', 'h9build-setup.sh', 'h9xash_server.sh') {
    $p = Join-Path $linuxDir $f
    $t = [IO.File]::ReadAllText($p)
    if ($t.Contains("`r`n")) { [IO.File]::WriteAllText($p, $t.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false))) }
}

# this run is the heavy job until it ends
New-Item -ItemType Directory -Path (Split-Path -Parent $lock) -Force | Out-Null
[IO.File]::WriteAllText($lock, "build-linux.ps1 in $Distro, started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n")
try {
    if ($Setup) {
        Write-Host "== setup: build tools in $Distro"
        $setupArgs = @('-d', $Distro, '-u', 'root', '--', 'bash', "$src/linux/h9build-setup.sh")
        if ($WithAmbuild) { $setupArgs += '--with-ambuild' }
        if ((Invoke-Wsl $setupArgs) -ne 0) { throw 'h9build-setup.sh failed.' }
    }

    $env:H9_SRC = $src
    $env:H9_JOBS = "$Jobs"
    if ($Skip.Count) { $env:H9_SKIP = ($Skip -join ' ') }
    $env:WSLENV = 'H9_SRC/u:H9_JOBS/u:H9_SKIP/u'
    Write-Host "== build: linux/build-linux.sh $($Steps -join ' ') in $Distro"
    $buildArgs = @('-d', $Distro, '-u', 'root', '--', 'bash', "$src/linux/build-linux.sh") + $Steps
    $rc = Invoke-Wsl $buildArgs
    if ($rc -ne 0) { throw "build-linux.sh failed (exit $rc); the step is named in its last lines." }

    # what each step was built from, for tools\linux-sync.mjs (a missing node only means no record)
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $recorded = if ($Steps.Count) { @($Steps) } else { @('rets', 'metamod', 'engine', 'amxx', 'rcbot', 'assemble') | Where-Object { $Skip -notcontains $_ }
        }
        & node (Join-Path $Here 'tools\linux-sync.mjs') --record @recorded
    } else {
        Write-Host '(no node on this PC: node tools\linux-sync.mjs --baseline records the inputs later)'
    }

    # -Stage packs while the lock is held: the ZIPs are a heavy job too.
    $packRc = 0
    if ($Stage) {
        $packer = Join-Path $Here 'stage-h9xash.ps1'
        if (-not (Test-Path -LiteralPath $packer)) {
            $repoLine = $null
            $exportBat = Join-Path $Here 'export.bat'
            if (Test-Path -LiteralPath $exportBat) {
                $repoLine = Select-String -LiteralPath $exportBat -Pattern '^set "REPO=(.+)"\s*$' | Select-Object -First 1
            }
            if (-not $repoLine) { throw "No stage-h9xash.ps1 beside $Here, and no set ""REPO="" line in export.bat to find the repository with." }
            $packRoot = $repoLine.Matches[0].Groups[1].Value
            $packer = Join-Path $packRoot 'stage-h9xash.ps1'
            if (-not (Test-Path -LiteralPath $packer)) { throw "No $packer to pack with." }
            $built = Join-Path $Here 'H9XASH-linux'
            if (Test-Path -LiteralPath (Join-Path $built 'BUILDINFO.txt')) {
                & robocopy.exe $built (Join-Path $packRoot 'H9XASH-linux') /MIR /NJH /NJS /NDL /NFL /NP | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy of H9XASH-linux into $packRoot failed (exit $LASTEXITCODE)." }
            }
        }
        Write-Host "== stage: $packer"
        $global:LASTEXITCODE = 0
        & $packer
        $packRc = $LASTEXITCODE
    }
} finally {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}

$out = Join-Path $Here 'H9XASH-linux'
Write-Host "== H9XASH-linux: $out"
if (Test-Path -LiteralPath (Join-Path $out 'BUILDINFO.txt')) { Get-Content -LiteralPath (Join-Path $out 'BUILDINFO.txt') }

if ($Stage) { exit $packRc }

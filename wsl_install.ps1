<#
.SYNOPSIS
  Sets up the WSL2 distro h9build that build-linux.cmd builds the Linux server in.

.DESCRIPTION
  Makes a separate WSL2 distro named h9build (Ubuntu 22.04) on the drive you choose, then installs the
  build tools in it (linux\h9build-setup.sh: the 32-bit toolchain, cmake, clang, nasm; -WithAmbuild adds
  AMBuild, which builds AMX Mod X). Your own distros are never touched: h9build is imported from a copy
  of Ubuntu 22.04, and a copy of Ubuntu 22.04 that this script itself installed for the purpose is
  removed again afterwards; one you already had is left as it is. An existing h9build is not replaced
  (remove it yourself with: wsl --unregister h9build).

  Needs WSL2 (Windows 10 2004 or later). If WSL itself is not installed, the script says so: run
  wsl --install --no-distribution in an elevated terminal, restart, and run this again.

  Space: about 10 GB on the drive of -Dir (the distro's disk file grows with the builds). C: is not
  chosen on its own when D: exists.

.PARAMETER Dir
  Where the distro's disk goes. Default: D:\wsl\h9build when there is a D: drive, else
  %LOCALAPPDATA%\h9build.

.PARAMETER Distro
  The distro's name. Default h9build (build-linux.ps1 builds in that name).

.PARAMETER Base
  The Microsoft Store distro it is copied from. Default Ubuntu-22.04.

.PARAMETER WithAmbuild
  Also install AMBuild from github.com/alliedmodders/ambuild (BSD 3-Clause; linux\LICENSE-AMBUILD.txt).

.PARAMETER SkipSetup
  Make the distro but do not install the tools.

.EXAMPLE
  .\wsl_install.ps1 -WithAmbuild
  .\wsl_install.ps1 -Dir E:\wsl\h9build
#>
[CmdletBinding()]
param(
    [string]$Dir,
    [string]$Distro = 'h9build',
    [string]$Base = 'Ubuntu-22.04',
    [switch]$WithAmbuild,
    [switch]$SkipSetup
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Get-Distros { return @((& wsl.exe -l -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

Step 'WSL'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'wsl.exe is not installed. In an elevated terminal run: wsl --install --no-distribution, restart the PC, and run this script again.'
}
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'WSL is present but not ready (wsl --status failed). In an elevated terminal run: wsl --install --no-distribution, restart the PC, and run this script again.'
}
& wsl.exe --set-default-version 2 *> $null
$have = Get-Distros
Write-Host ("distros now: " + ($have -join ', '))

if (-not $Dir) {
    $Dir = if (Test-Path 'D:\') { 'D:\wsl\h9build' } else { Join-Path $env:LOCALAPPDATA 'h9build' }
}
$Dir = [IO.Path]::GetFullPath($Dir)

if ($have -contains $Distro) {
    Write-Host "$Distro exists already; not replacing it."
} else {
    $drive = Get-PSDrive -Name $Dir.Substring(0, 1) -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free -lt 12GB) {
        throw ("{0}: has {1:N1} GB free; the distro needs about 12 GB. Give a folder on another drive with -Dir." -f $drive.Name, ($drive.Free / 1GB))
    }
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    if (@(Get-ChildItem -LiteralPath $Dir -Force).Count -gt 0) { throw "$Dir is not empty; give another folder with -Dir." }

    Step "Base distro $Base"
    $createdBase = $false
    if ($have -notcontains $Base) {
        Write-Host "installing $Base (a download of a few hundred MB), only to copy it"
        & wsl.exe --install $Base --web-download --no-launch
        if ($LASTEXITCODE -ne 0) { throw "wsl --install $Base failed (exit $LASTEXITCODE)." }
        $createdBase = $true
        for ($i = 0; $i -lt 60 -and (Get-Distros) -notcontains $Base; $i++) { Start-Sleep -Seconds 2 }
        if ((Get-Distros) -notcontains $Base) { throw "$Base did not appear in wsl -l after the install." }
    } else {
        Write-Host "$Base is there already; it is only read (exported), not changed."
    }

    Step "Making $Distro in $Dir"
    $tar = Join-Path $Dir '..\h9build-base.tar'
    $tar = [IO.Path]::GetFullPath($tar)
    try {
        & wsl.exe --export $Base $tar
        if ($LASTEXITCODE -ne 0) { throw "wsl --export $Base failed (exit $LASTEXITCODE)." }
        & wsl.exe --import $Distro $Dir $tar --version 2
        if ($LASTEXITCODE -ne 0) { throw "wsl --import $Distro failed (exit $LASTEXITCODE)." }
    } finally {
        Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue
        if ($createdBase) {
            & wsl.exe --unregister $Base *> $null
            Write-Host "removed the temporary $Base that this script installed"
        }
    }
    if ((Get-Distros) -notcontains $Distro) { throw "$Distro was not made." }
}

if ($SkipSetup) {
    Write-Host ''
    Write-Host "$Distro is ready, without the tools. Run linux\h9build-setup.sh in it as root."
    return
}

Step "Build tools in $Distro"
$setup = Join-Path $Here 'linux\h9build-setup.sh'
if (-not (Test-Path -LiteralPath $setup)) { throw "No $setup beside this script." }
$t = [IO.File]::ReadAllText($setup)
if ($t.Contains("`r`n")) { [IO.File]::WriteAllText($setup, $t.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false))) }
$wslSetup = ((& wsl.exe -d $Distro -- wslpath -a ($setup.Replace('\', '/'))) -replace "`0", '' | Select-Object -First 1).Trim()
if (-not $wslSetup.StartsWith('/')) { throw "wslpath gave no path for $setup ($wslSetup)." }
$args2 = @('-d', $Distro, '-u', 'root', '--', 'bash', $wslSetup)
if ($WithAmbuild) { $args2 += '--with-ambuild' }
& wsl.exe @args2
if ($LASTEXITCODE -ne 0) { throw "h9build-setup.sh failed (exit $LASTEXITCODE)." }

Write-Host ''
Write-Host "$Distro is ready. Build with: build-linux.cmd   (add -Stage to pack dist\ as well)" -ForegroundColor Green

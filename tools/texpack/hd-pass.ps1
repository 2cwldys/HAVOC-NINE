# hd-pass.ps1 -- bring the HD textures up to date, and nothing else.
#
# This is the whole HD workflow in one command, and it is deliberately NOT part of a release.
# Scanning the mod and upscaling ten gigabytes has no place in an ordinary build; it belongs to
# the day somebody adds a map or a model. Run it then.
#
# It is a delta from end to end. Every texture is keyed by the sha256 of its PIXELS, so a map
# recompiled without touching its art produces the same keys and is skipped, and one wall texture
# used by fifty maps is one upscale. An entry also carries the RECIPE that made it -- the model's
# own hash plus the scale and the format -- so changing the model makes every entry stale at once
# rather than leaving a pack half in each style. A pass that finds nothing new does nothing and
# says so.
#
#   tools\texpack\hd-pass.ps1                 scan, upscale what is new, place it
#   tools\texpack\hd-pass.ps1 -WhatIfOnly     say what it would do and stop, change nothing
#   tools\texpack\hd-pass.ps1 -Publish        also publish into dist\files\hd, ready for a deploy
#   tools\texpack\hd-pass.ps1 -Tile 256       smaller tiles, if video memory is tight
#
# The batch model is a 4x one and this pass is always 4x. Choosing 2x or 3x is a thing you do to
# ONE folder of textures by hand, which is what tools\upscaler_gui is for; a pack mixed between
# scales would be a pack with two recipes in it.
#
# Needs node for the three .mjs, and the Python that has torch and CUDA for the upscaler -- that
# venv lives outside the repository because torch is 2.5 GB (-Venv points at another one).
# upscale.py takes the project's heavy-job lock itself, so this never runs beside a map compile.
#
# Exit codes: 0 done (or nothing to do), 1 a step failed, 2 something it needs is missing.
#
# docs\HD_TEXTURES.txt is the long version.

[CmdletBinding()]
param(
	[string]$Work = 'D:\temp\texpack',
	[string]$Venv = 'D:\temp\texpack-venv\Scripts\python.exe',
	[string]$Dest = '',
	[int]$Tile = 0,
	[switch]$Publish,
	[switch]$WhatIfOnly,
	[switch]$Link
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Here = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # the repository root
if (-not $Dest) { $Dest = Join-Path $Here 'H9XASH\ts\materials' }

function Say([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Note([string]$m) { Write-Host "   $m" }
function Fail([string]$m, [int]$code = 1) { Write-Host ''; Write-Host "STOPPED: $m" -ForegroundColor Red; exit $code }

# ---- the things it needs -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node is not on PATH; the readers are written in it' 2 }
if (-not (Test-Path -LiteralPath $Venv)) {
	Fail "no Python with torch at $Venv. docs\HD_TEXTURES.txt section 5 says how to make it, or pass -Venv." 2
}
$model = Join-Path $Work 'model\4xLSDIRplus.onnx'
if (-not (Test-Path -LiteralPath (Join-Path $Work 'model'))) { Note "no model folder in $Work yet; upscale.py will say what it wants" }

function Run([string]$what, [string]$exe, [string[]]$exeArgs) {
	Note "$exe $($exeArgs -join ' ')"
	& $exe @exeArgs | ForEach-Object { Write-Host "   $_" }
	if ($LASTEXITCODE) { Fail "$what failed (exit $LASTEXITCODE)" }
}

$t0 = Get-Date

# ---- 1. what the mod has now ----------------------------------------------------------------
Say 'reading every map, wad, model and sprite'
Run 'the scan' 'node' @((Join-Path $PSScriptRoot 'extract.mjs'), '--work', $Work)

# ---- 2. what of that is already done ----------------------------------------------------------
Say 'comparing with what has been upscaled before'
$report = & node (Join-Path $PSScriptRoot 'manifest.mjs') --work $Work 2>&1
$report | ForEach-Object { Write-Host "   $_" }
# manifest.mjs prints "to do N" for sources with no output and "stale N" for outputs this recipe
# cannot vouch for. Both are work: a stale entry was made by an older model and has to be redone,
# or the pack ends up half in one style and half in another.
$todo = 0
$stale = 0
foreach ($line in $report) {
	if ("$line" -match '(?i)^\s*to\s*do\s+([0-9]+)') { $todo = [int]$Matches[1] }
	if ("$line" -match '(?i)^\s*stale\s+([0-9]+)') { $stale = [int]$Matches[1] }
}
$work = $todo + $stale
if ($work -eq 0) {
	Note 'nothing new to upscale.'
	if (-not $Publish) {
		Say ("done in {0:N0} s -- the pack is already current" -f ((Get-Date) - $t0).TotalSeconds)
		exit 0
	}
	Note 'going on to the publish, in case the store is behind the textures.'
}
if ($WhatIfOnly) {
	Say "would upscale $work texture(s) ($todo new, $stale stale), then place them into $Dest"
	exit 0
}

# ---- 3. upscale only those -------------------------------------------------------------------
# upscale.py reads the extracted PNGs and writes the TGAs beside them; it skips an output that is
# already there, which is what makes this the delta step rather than a rerun of everything.
if ($work -gt 0) {
	Say "upscaling $work texture(s)  ($todo new, $stale stale)"
	Note 'upscale.py holds the heavy-job lock while it runs; it is resumable, so stopping it is safe'
	$upArgs = @((Join-Path $PSScriptRoot 'upscale.py'),
		'--in', (Join-Path $Work 'source'),
		'--out', (Join-Path $Work 'out'),
		'--model', (Join-Path $Work 'model\4xLSDIRplus.pth'))
	if ($Tile -gt 0) { $upArgs += @('--tile', "$Tile") }
	Run 'the upscale' $Venv $upArgs
}

# ---- 4. put them where the engine looks --------------------------------------------------------
Say "placing them into $Dest"
$placeArgs = @((Join-Path $PSScriptRoot 'place.mjs'), '--work', $Work, '--dest', $Dest)
if ($Link) { $placeArgs += '--link' }
Run 'the placement' 'node' $placeArgs

# ---- 5. record what this pass made --------------------------------------------------------------
Say 'recording the recipe, so the next pass skips all of this'
Run 'the manifest' 'node' @((Join-Path $PSScriptRoot 'manifest.mjs'), '--work', $Work, '--write')

# ---- 6. publish, when asked ----------------------------------------------------------------------
# The same publisher the client's own files go through, pointed at the materials folder alone. It
# writes dist\files\hd: manifest.json and one file per DISTINCT texture named by its SHA-256. A
# deploy with [deploy] hd = 1 then sends only the blobs the host does not already hold.
if ($Publish) {
	Say 'publishing into dist\files\hd'
	$publisher = Join-Path $Here 'tools\updater\publish_files.py'
	$hdDir = Join-Path $Here 'dist\files\hd'
	$stage = Join-Path $Here 'dist\.stage-hd'
	if (-not (Test-Path -LiteralPath $publisher)) { Fail "no publisher at $publisher" 2 }
	if (Test-Path -LiteralPath (Join-Path $stage 'ts\materials')) { & cmd /c rmdir "$stage\ts\materials" | Out-Null }
	if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
	New-Item -ItemType Directory -Force -Path (Join-Path $stage 'ts') | Out-Null
	# publish_files walks a staged tree, so it is given one holding nothing but ts\materials
	& cmd /c mklink /J "$stage\ts\materials" "$Dest" | Out-Null
	if ($LASTEXITCODE) { Fail 'could not make the staging junction' }
	try {
		Run 'the publish' 'py' @('-3', '-I', $publisher, $stage, $hdDir, '--name', 'H9XASH-HD', '--subtree', 'ts/materials')
	} finally {
		& cmd /c rmdir "$stage\ts\materials" | Out-Null
		Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
	}
	Note "dist\files\hd is ready. A deploy with [deploy] hd = 1 sends only what the host lacks."
}

Say ("done in {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds)
Note "the textures are in $Dest, which no package ever holds (docs\HD_TEXTURES.txt)."
exit 0

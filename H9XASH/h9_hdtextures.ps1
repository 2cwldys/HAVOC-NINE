# h9_hdtextures.ps1 -- fetches the HD texture pack for HAVOC 9 and keeps it up to date.
#
# The game ships with its original textures. This downloads the AI-upscaled ones, which the
# engine then uses INSTEAD, without changing a single original file: they are loose TGA files
# under ts\materials\, and turning them off falls straight back to what was always there.
#
# It is a delta download. Every texture is named by the sha256 of its own bytes, so a file that
# did not change is never fetched again, and one texture used by twenty maps is fetched once.
# An interrupted run picks up where it stopped. After the first install, an update only moves
# what actually changed.
#
# It links to your havoc9.org account the same way the site's 'link your account' button does:
# it opens your browser at the account page, shows you a short code to approve, and waits. No
# password comes near this script and nothing about the account is written to disk.
#
#   h9_hdtextures.ps1                 install or update the pack
#   h9_hdtextures.ps1 -Code ABCD-1234 use a code you already have, for an unattended run
#   h9_hdtextures.ps1 -DryRun         say what would change, change nothing
#   h9_hdtextures.ps1 -Verify         re-check every installed file against the manifest
#   h9_hdtextures.ps1 -Remove         delete the pack again (the game keeps working)
#
# Where it gets the files from is configuration, not something written into this script. It takes
# the first of: -Base, the H9_HD_BASE environment variable, or hd_source.txt beside this file.
#
# Exit codes: 0 done, 1 an error, 2 no source configured, 3 the code was refused,
#             4 a file arrived corrupt and could not be replaced.
# Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot,
	[string]$Base = '',
	[string]$Code = '',
	[int]$Retries = 3,
	[switch]$DryRun,
	[switch]$Verify,
	[switch]$Remove
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Materials = Join-Path $Root 'ts\materials'
$BlobDir   = Join-Path $Materials '.blobs'
$Local     = Join-Path $Materials 'hd-pack.json'

function Say($text)  { Write-Host $text }
function Warn($text) { Write-Host $text -ForegroundColor Yellow }
function Die($text, $exit) { Write-Host $text -ForegroundColor Red; exit $exit }

# h9web/lib/link.js issues the code: 8 letters of BCDFGHJKLMNPQRSTVWXZ, shown as XXXX-XXXX.
# No vowels and no confusable letters, so a person can read one off a screen without error.
$H9CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

function Normalize-H9Code($text) {
	if (-not $text) { return '' }
	$up = ($text -replace '[^A-Za-z]', '').ToUpperInvariant()
	foreach ($ch in $up.ToCharArray()) { if ($H9CODE_ALPHABET.IndexOf($ch) -lt 0) { return '' } }
	if ($up.Length -ne 8) { return '' }
	return $up
}

function Sha256OfFile($path) {
	return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
}

# ---- where the files come from -------------------------------------------------------------
function Resolve-Base {
	if ($Base) { return $Base.TrimEnd('/') }
	if ($env:H9_HD_BASE) { return $env:H9_HD_BASE.TrimEnd('/') }
	$file = Join-Path $Root 'hd_source.txt'
	if (Test-Path -LiteralPath $file) {
		foreach ($line in Get-Content -LiteralPath $file) {
			$t = $line.Trim()
			if ($t -and -not $t.StartsWith('#')) { return $t.TrimEnd('/') }
		}
	}
	return ''
}

# ---- remove ---------------------------------------------------------------------------------
if ($Remove) {
	if (-not (Test-Path -LiteralPath $Materials)) { Say 'The HD pack is not installed.'; exit 0 }
	if ($DryRun) { Say "Would delete $Materials"; exit 0 }
	Remove-Item -LiteralPath $Materials -Recurse -Force
	Say 'The HD pack is gone. The game uses its original textures again.'
	Say 'Nothing else changed: no map, model or wad was ever touched.'
	exit 0
}

# ---- verify ---------------------------------------------------------------------------------
if ($Verify) {
	if (-not (Test-Path -LiteralPath $Local)) { Die 'Nothing installed yet: there is no hd-pack.json.' 1 }
	$m = Get-Content -LiteralPath $Local -Raw | ConvertFrom-Json
	$bad = 0; $missing = 0; $n = 0
	foreach ($p in $m.files.PSObject.Properties) {
		$n++
		$at = Join-Path $Materials $p.Name
		if (-not (Test-Path -LiteralPath $at)) { $missing++; continue }
		if ((Sha256OfFile $at) -ne $p.Value) { $bad++; Warn "  wrong contents: $($p.Name)" }
	}
	Say ''
	Say "checked $n file(s): $missing missing, $bad with the wrong contents"
	if ($missing -or $bad) { Say 'Run it again without -Verify to put those right.'; exit 1 }
	Say 'Every file matches the manifest.'
	exit 0
}

# ---- the source and the code -----------------------------------------------------------------
$src = Resolve-Base
if (-not $src) {
	Say 'No download source is configured.'
	Say ''
	Say 'Set one of these and run it again:'
	Say '  h9_hdtextures.ps1 -Base <the address your account page shows>'
	Say '  $env:H9_HD_BASE = <the address>'
	Say '  put the address on the first line of hd_source.txt beside this script'
	exit 2
}

# ---- the handshake -----------------------------------------------------------------------
# The same one the website's 'link your account' button uses (h9web/lib/link.js): the site
# hands out a short code, this opens the page in the browser, and the account approves it.
# Nothing is typed in by hand and no password comes near this script.
$agent = @{ 'User-Agent' = 'h9-hdtextures' }
$token = ''

if ($Code) {
	# a code given on the command line, for an unattended run
	$Code = Normalize-H9Code $Code
	if (-not $Code) { Die 'That is not a valid code. Eight letters, shown as XXXX-XXXX.' 3 }
}

try {
	$begin = Invoke-RestMethod -Uri "$src/api/link/start" -Headers $agent -TimeoutSec 60
} catch {
	$status = ''
	if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
	if ($status -eq 429) { Die 'The site is asking us to wait. Try again in a few minutes.' 3 }
	Die "Could not reach the account service: $($_.Exception.Message)" 1
}
if ($begin.status -eq 'busy') { Die 'The account service is busy. Try again shortly.' 3 }
if (-not $begin.deviceCode) { Die 'The account service did not start a link.' 3 }

$shown = $begin.userCode
$where = $begin.linkUrl
Say ''
Say '  ------------------------------------------------------------'
Say "   Approve this on your account page. Your code is:  $shown"
Say '  ------------------------------------------------------------'
Say ''
Say "  Opening $where"
try { Start-Process $where | Out-Null } catch {
	Warn '  Could not open a browser. Open that address yourself.'
}
Say '  Waiting for you to approve it... (Ctrl+C to stop)'

$wait = [int]$begin.interval
if ($wait -lt 2) { $wait = 5 }
$deadline = (Get-Date).AddSeconds([int]$begin.expiresIn)
while (-not $token) {
	if ((Get-Date) -gt $deadline) { Die 'The code expired before it was approved. Run it again.' 3 }
	Start-Sleep -Seconds $wait
	try {
		$poll = Invoke-RestMethod -Uri "$src/api/link/poll?code=$($begin.deviceCode)" -Headers $agent -TimeoutSec 30
	} catch { continue }
	switch ($poll.status) {
		'slow_down' { if ($poll.interval) { $wait = [int]$poll.interval }; continue }
		'pending'   { continue }
		'expired'   { Die 'The code expired before it was approved. Run it again.' 3 }
		'refused'   { Die 'The account refused it.' 3 }
	}
	if ($poll.token) { $token = $poll.token }
	elseif ($poll.status -eq 'ok' -and $poll.deviceToken) { $token = $poll.deviceToken }
}
Say '  Approved.'
Say ''
$headers = @{ 'Authorization' = "Bearer $token"; 'User-Agent' = 'h9-hdtextures' }

# ---- the manifest -----------------------------------------------------------------------------
Say "Asking $src for the current pack..."
try {
	$remote = Invoke-RestMethod -Uri "$src/hd-pack.json" -Headers $headers -TimeoutSec 60
} catch {
	$status = ''
	if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
	if ($status -eq 401 -or $status -eq 403) { Die 'That code was refused. Check it on your account page.' 3 }
	Die "Could not reach the pack: $($_.Exception.Message)" 1
}
if (-not $remote.files) { Die 'The server did not send a usable manifest.' 1 }

$have = $null
if (Test-Path -LiteralPath $Local) {
	try { $have = Get-Content -LiteralPath $Local -Raw | ConvertFrom-Json } catch { $have = $null }
}

# ---- the three lists --------------------------------------------------------------------------
$wantFiles = @{}
foreach ($p in $remote.files.PSObject.Properties) { $wantFiles[$p.Name] = $p.Value }
$haveFiles = @{}
if ($have -and $have.files) { foreach ($p in $have.files.PSObject.Properties) { $haveFiles[$p.Name] = $p.Value } }

$toWrite = New-Object System.Collections.ArrayList
foreach ($k in $wantFiles.Keys) {
	$at = Join-Path $Materials $k
	if (-not $haveFiles.ContainsKey($k) -or $haveFiles[$k] -ne $wantFiles[$k] -or -not (Test-Path -LiteralPath $at)) {
		[void]$toWrite.Add($k)
	}
}
$toRemove = New-Object System.Collections.ArrayList
foreach ($k in $haveFiles.Keys) { if (-not $wantFiles.ContainsKey($k)) { [void]$toRemove.Add($k) } }

# one blob can fill many paths, so fetch each only once
$needBlobs = @{}
foreach ($k in $toWrite) {
	$sha = $wantFiles[$k]
	$blob = Join-Path $BlobDir "$sha.tga"
	if (-not (Test-Path -LiteralPath $blob)) { $needBlobs[$sha] = $true }
}

$bytes = 0
foreach ($sha in $needBlobs.Keys) {
	if ($remote.blobs -and $remote.blobs.PSObject.Properties[$sha]) { $bytes += [int64]$remote.blobs.$sha }
}

Say ''
Say "  files the pack holds   $($wantFiles.Count)"
Say "  to write               $($toWrite.Count)"
Say "  to remove              $($toRemove.Count)"
Say "  to download            $($needBlobs.Count) file(s), about $([math]::Round($bytes / 1GB, 2)) GB"
if ($have) { Say '  (this is an update: anything unchanged is left alone)' } else { Say '  (first install)' }
Say ''

if ($toWrite.Count -eq 0 -and $toRemove.Count -eq 0) { Say 'Already up to date.'; exit 0 }
if ($DryRun) { Say 'Dry run: nothing was changed.'; exit 0 }

# ---- download ----------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $BlobDir | Out-Null
$done = 0; $failed = 0
foreach ($sha in $needBlobs.Keys) {
	$blob = Join-Path $BlobDir "$sha.tga"
	$ok = $false
	for ($try = 1; $try -le $Retries -and -not $ok; $try++) {
		try {
			Invoke-WebRequest -Uri "$src/hd/$($sha.Substring(0,2))/$sha.tga" -Headers $headers -OutFile $blob -TimeoutSec 120 -UseBasicParsing
			# a blob is named by the hash of its own bytes, so this catches a bad or partial file
			if ((Sha256OfFile $blob) -eq $sha) { $ok = $true }
			else { Warn "  arrived corrupt, retrying: $sha"; Remove-Item -LiteralPath $blob -Force -ErrorAction SilentlyContinue }
		} catch {
			if ($try -eq $Retries) { Warn "  could not fetch $sha : $($_.Exception.Message)" }
			Start-Sleep -Seconds ($try * 2)
		}
	}
	if ($ok) { $done++ } else { $failed++ }
	if ((($done + $failed) % 50) -eq 0) { Say "  $($done + $failed) of $($needBlobs.Count)..." }
}
if ($failed) { Die "$failed file(s) could not be downloaded. Run it again to carry on." 4 }

# ---- put them where they belong ------------------------------------------------------------------
$written = 0
foreach ($k in $toWrite) {
	$sha = $wantFiles[$k]
	$blob = Join-Path $BlobDir "$sha.tga"
	if (-not (Test-Path -LiteralPath $blob)) { continue }
	$at = Join-Path $Materials $k
	$dir = Split-Path -Parent $at
	if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
	Copy-Item -LiteralPath $blob -Destination $at -Force
	$written++
}
foreach ($k in $toRemove) {
	$at = Join-Path $Materials $k
	if (Test-Path -LiteralPath $at) { Remove-Item -LiteralPath $at -Force }
}

# blobs nothing refers to any more
$stillWanted = @{}
foreach ($k in $wantFiles.Keys) { $stillWanted[$wantFiles[$k]] = $true }
$pruned = 0
foreach ($f in Get-ChildItem -LiteralPath $BlobDir -File -Filter '*.tga' -ErrorAction SilentlyContinue) {
	if (-not $stillWanted.ContainsKey($f.BaseName)) { Remove-Item -LiteralPath $f.FullName -Force; $pruned++ }
}

$remote | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $Local -Encoding ASCII

Say ''
Say "Done. $written file(s) written, $($toRemove.Count) removed, $pruned old download(s) cleared."
Say ''
Say 'To see them in game, in the console:'
Say '    host_allow_materials 1'
Say '    restart'
Say ''
Say 'That setting only takes effect on a map load, which is what restart does. Set it to 0 and'
Say 'reload to go back to the original textures: they were never changed.'
exit 0

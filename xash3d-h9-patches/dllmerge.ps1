# dllmerge.ps1 -- folds a freshly written <dll>.patch (or ENGINE.txt) into the one already beside it.
#
# A file only grows, and nothing already in it is removed:
#   - the lines before the patch history are kept; a line of the new header is added only when the
#     existing header does not have it;
#   - the patch history gains a block for a build when that build differs from the last block. A block
#     is the "Generated" line, the working tree status and the h9 commits for the patch's paths, and the
#     sha256 of the diff below, so the newest block describes that diff exactly;
#   - the body is the new diff, from the working tree. A body line the existing patch has and the new
#     diff no longer has is not dropped: it goes into the new history block, under a marker line, so
#     the history keeps every line that was ever in the diff. An empty new diff over a non-empty one is
#     an error, and the existing file is left as it was.
# The existing file's line endings are kept, and the file always ends with one.

param(
	[Parameter(Mandatory = $true)] [string]$Final,
	[Parameter(Mandatory = $true)] [string]$New
)

$ErrorActionPreference = 'Stop'
$name = Split-Path -Leaf $Final
$utf8 = New-Object System.Text.UTF8Encoding $false
$marker = '== Patch history =='
$replacedMarker = 'Lines of the previous diff that this build replaced, kept here:'

function Get-Slice([string[]]$a, [int]$from, [int]$to) {
	$r = New-Object System.Collections.Generic.List[string]
	for ($i = $from; $i -le $to; $i++) { $r.Add($a[$i]) }
	return ,$r.ToArray()
}

function Read-Patch([string]$path) {
	$raw = [System.IO.File]::ReadAllText($path)
	$lines = $raw.Replace("`r`n", "`n").Split("`n")
	$cut = 0
	while ($cut -lt $lines.Count -and -not $lines[$cut].StartsWith('diff --git')) { $cut++ }
	$head = Get-Slice $lines 0 ($cut - 1)
	$body = Get-Slice $lines $cut ($lines.Count - 1)
	$m = [Array]::IndexOf($head, $marker)
	if ($m -ge 0) {
		$static = Get-Slice $head 0 ($m - 1)
		$hist = Get-Slice $head ($m + 1) ($head.Count - 1)
	} else {
		$static = $head
		if ($static.Count -gt 0 -and $static[$static.Count - 1] -eq '') { $static = Get-Slice $static 0 ($static.Count - 2) }
		$hist = [string[]]@()
	}
	return @{ Static = $static; Hist = $hist; Body = $body; HasMarker = ($m -ge 0); Crlf = $raw.Contains("`r`n") }
}

function Get-Blocks([string[]]$hist) {
	$blocks = New-Object System.Collections.Generic.List[object]
	$cur = $null
	foreach ($l in $hist) {
		if ($l.StartsWith('Generated ')) {
			if ($null -ne $cur) { $blocks.Add($cur) }
			$cur = New-Object System.Collections.Generic.List[string]
		}
		if ($null -ne $cur) { $cur.Add($l) }
	}
	if ($null -ne $cur) { $blocks.Add($cur) }
	return $blocks.ToArray()
}

function Get-BlockKey($block) {
	# The replaced lines are left out of the key: they say what the build took away, not what it is.
	$keep = New-Object System.Collections.Generic.List[string]
	$inReplaced = $false
	foreach ($l in @($block | Select-Object -Skip 1)) {
		if ($l -eq $replacedMarker) { $inReplaced = $true; continue }
		if ($l.StartsWith('Diff sha256 ')) { $inReplaced = $false }
		if (-not $inReplaced) { $keep.Add($l) }
	}
	return ($keep -join "`n")
}

function Get-Sha256([string[]]$lines) {
	$bytes = $utf8.GetBytes(($lines -join "`n"))
	$hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
	return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLower()
}

function New-Block([string[]]$blockLines, [string]$sha, [string[]]$replaced) {
	$blk = New-Object System.Collections.Generic.List[string]
	foreach ($l in $blockLines) { $blk.Add($l) }
	while ($blk.Count -gt 1 -and $blk[$blk.Count - 1] -eq '') { $blk.RemoveAt($blk.Count - 1) }
	if ($replaced.Count -gt 0) {
		$blk.Add($replacedMarker)
		foreach ($l in $replaced) { $blk.Add($l) }
	}
	$blk.Add("Diff sha256 $sha, the diff below.")
	$blk.Add('')
	return ,$blk.ToArray()
}

function Write-Lines([string]$path, $lines, [string]$eol) {
	$text = $lines -join $eol
	if (-not $text.EndsWith($eol)) { $text += $eol }
	[System.IO.File]::WriteAllText($path, $text, $utf8)
}

$fresh = Read-Patch $New
$sha = Get-Sha256 $fresh.Body

if (-not (Test-Path -LiteralPath $Final)) {
	$all = New-Object System.Collections.Generic.List[string]
	$all.AddRange([string[]]$fresh.Static)
	if ($fresh.HasMarker) { $all.Add($marker) }
	if ($fresh.Hist.Count -gt 0) { $all.AddRange([string[]](New-Block $fresh.Hist $sha @())) }
	$all.AddRange([string[]]$fresh.Body)
	Write-Lines $Final $all "`n"
	Remove-Item -LiteralPath $New
	Write-Host "  ${name} written"
	exit 0
}

$old = Read-Patch $Final

$inFresh = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($l in $fresh.Body) { [void]$inFresh.Add($l) }
$gone = @($old.Body | Where-Object { $_ -ne '' -and $_ -notmatch '^(@@|index |diff --git )' -and -not $inFresh.Contains($_) })
if ($fresh.Body.Count -eq 0 -and $old.Body.Count -gt 0) {
	Write-Host "  [ERROR] ${name}: the new diff is empty but the existing one is not. Left as it was."
	Remove-Item -LiteralPath $New
	exit 1
}
if ($gone.Count -gt 0) {
	Write-Host "  ${name}: $($gone.Count) line(s) of the existing diff are not in the new one, kept in the history."
}

$static = New-Object System.Collections.Generic.List[string]
foreach ($l in $old.Static) { $static.Add($l) }
$added = 0
foreach ($l in $fresh.Static) {
	if ($old.Static -cnotcontains $l) { $static.Add($l); $added++ }
}

$hist = New-Object System.Collections.Generic.List[string]
foreach ($l in $old.Hist) { $hist.Add($l) }
$blockAdded = $false
if ($fresh.Hist.Count -gt 0 -or $gone.Count -gt 0) {
	$candidate = New-Block $fresh.Hist $sha @($gone)
	$oldBlocks = @(Get-Blocks $old.Hist)
	$differs = $true
	if ($oldBlocks.Count -gt 0) {
		$lastKey = Get-BlockKey $oldBlocks[$oldBlocks.Count - 1]
		$newKey = Get-BlockKey $candidate
		$differs = ($lastKey -cne $newKey)
	}
	if ($differs) {
		$hist.AddRange([string[]]$candidate)
		$blockAdded = $true
	}
}

$all = New-Object System.Collections.Generic.List[string]
$all.AddRange([string[]]$static)
if ($old.HasMarker -or $fresh.HasMarker) {
	$all.Add($marker)
	$all.AddRange([string[]]$hist)
}
$all.AddRange([string[]]$fresh.Body)

$eol = if ($old.Crlf) { "`r`n" } else { "`n" }
Write-Lines $Final $all $eol
Remove-Item -LiteralPath $New
$what = if ($blockAdded) { 'history block added' } else { 'history unchanged' }
Write-Host "  ${name} merged: $added header line(s) added, $what"
exit 0

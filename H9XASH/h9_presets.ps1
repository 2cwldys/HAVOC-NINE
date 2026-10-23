# h9_presets.ps1 -- swap AMX Mod X config files for presets, or toggle plugins directly.
#
# Run via h9_presets.bat. Reads presets\ beside this script -- see presets\README.txt
# for the naming convention (<target-base>.<tag>.<ext>, subfolders mirror configs\).
# Applies chosen presets over the matching file in ts\addons\amxmodx\configs\, always
# backing up whatever it's about to overwrite first, into presets\backup\<run time>\.
#
# presets\backup\ and presets\example\ are never scanned as live presets.
#
# Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$PresetsDir = Join-Path $Root 'presets'
$ConfigsDir = Join-Path $Root 'ts\addons\amxmodx\configs'
$BackupRoot = Join-Path $PresetsDir 'backup'
$RunStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Utf8 = New-Object System.Text.UTF8Encoding $false
$ReservedDirs = @('backup', 'example')
$script:BackedUp = @{}

function Write-Note([string]$Text)
{
	Write-Host "[h9-presets] $Text"
}

function Write-Warn([string]$Text)
{
	Write-Host "[h9-presets] WARNING: $Text" -ForegroundColor Yellow
}

function Write-Lines([string]$Path, [string[]]$Lines)
{
	[System.IO.File]::WriteAllText($Path, (($Lines -join "`r`n") + "`r`n"), $Utf8)
}

function Read-LinesRaw([string]$Path)
{
	$text = [System.IO.File]::ReadAllText($Path)
	$lines = [regex]::Split($text, "`r`n|`n")
	if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '')
	{
		$lines = $lines[0..($lines.Count - 2)]
	}
	return $lines
}

# Every preset file found, as {SourcePath, Variant, TargetRel, TargetFull}. Skips
# presets\backup\ and presets\example\ at any depth, and any file whose name doesn't
# split into exactly <base>.<tag>.<ext>.
function Get-PresetFiles
{
	if (-not (Test-Path -LiteralPath $PresetsDir))
	{
		return @()
	}

	$all = Get-ChildItem -LiteralPath $PresetsDir -Recurse -File -ErrorAction SilentlyContinue
	$results = New-Object System.Collections.ArrayList
	foreach ($f in $all)
	{
		$relDir = ''
		if ($f.DirectoryName.Length -gt $PresetsDir.Length)
		{
			$relDir = $f.DirectoryName.Substring($PresetsDir.Length).TrimStart('\')
		}

		$parts = @()
		if ($relDir) { $parts = $relDir -split '\\' }
		$reserved = $false
		foreach ($p in $parts)
		{
			if ($ReservedDirs -icontains $p) { $reserved = $true; break }
		}
		if ($reserved) { continue }

		$nameParts = $f.Name -split '\.'
		if ($nameParts.Count -ne 3)
		{
			Write-Warn "skipped '$($f.Name)' -- expected exactly <target-base>.<tag>.<ext> (two dots)"
			continue
		}

		$base = $nameParts[0]
		$variant = $nameParts[1]
		$ext = $nameParts[2]
		$targetName = "$base.$ext"
		$targetRel = if ($relDir) { "$relDir\$targetName" } else { $targetName }

		[void]$results.Add([pscustomobject]@{
			SourcePath = $f.FullName
			Variant    = $variant
			TargetRel  = $targetRel
			TargetFull = Join-Path $ConfigsDir $targetRel
		})
	}
	return $results
}

# Backs up $TargetFull (if it exists) to presets\backup\$RunStamp\$TargetRel, but only
# the first time a given target is touched in this run -- a second swap of the same
# file in one visit would otherwise back up the FIRST swap's result, not the original.
function Backup-Target([string]$TargetFull, [string]$TargetRel)
{
	if ($script:BackedUp.ContainsKey($TargetFull)) { return }
	$script:BackedUp[$TargetFull] = $true
	if (-not (Test-Path -LiteralPath $TargetFull)) { return }

	$dest = Join-Path (Join-Path $BackupRoot $RunStamp) $TargetRel
	New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
	Copy-Item -LiteralPath $TargetFull -Destination $dest -Force
	Write-Note "backed up $TargetRel -> presets\backup\$RunStamp\$TargetRel"
}

function Apply-PresetEntry($Entry)
{
	New-Item -ItemType Directory -Force -Path (Split-Path $Entry.TargetFull -Parent) | Out-Null
	Backup-Target $Entry.TargetFull $Entry.TargetRel
	Copy-Item -LiteralPath $Entry.SourcePath -Destination $Entry.TargetFull -Force
	Write-Note "applied $($Entry.TargetRel) (tag '$($Entry.Variant)')"
}

function Read-Choice([string]$Prompt, [int]$Max)
{
	$pick = Read-Host $Prompt
	if (-not $pick -or $pick -eq '0') { return -1 }
	$idx = 0
	if (-not [int]::TryParse($pick, [ref]$idx) -or $idx -lt 1 -or $idx -gt $Max)
	{
		Write-Warn 'Not a valid choice.'
		return -1
	}
	return $idx
}

function Invoke-SwapOne
{
	$entries = Get-PresetFiles
	if (-not $entries -or $entries.Count -eq 0)
	{
		Write-Note 'No presets found in presets\. See presets\README.txt.'
		return
	}

	$byTarget = $entries | Group-Object TargetRel
	Write-Host ''
	Write-Host 'Targets with presets available:'
	for ($i = 0; $i -lt $byTarget.Count; $i++)
	{
		$n = $byTarget[$i].Count
		Write-Host ("  {0}) {1} ({2} variant{3})" -f ($i + 1), $byTarget[$i].Name, $n, $(if ($n -ne 1) { 's' } else { '' }))
	}
	Write-Host '  0) back'

	$tIdx = Read-Choice 'Pick a target' $byTarget.Count
	if ($tIdx -lt 0) { return }
	$group = $byTarget[$tIdx - 1]

	Write-Host ''
	Write-Host "Variants for $($group.Name):"
	for ($j = 0; $j -lt $group.Group.Count; $j++)
	{
		Write-Host ("  {0}) {1}" -f ($j + 1), $group.Group[$j].Variant)
	}
	Write-Host '  0) back'

	$vIdx = Read-Choice 'Pick a variant' $group.Group.Count
	if ($vIdx -lt 0) { return }
	$entry = $group.Group[$vIdx - 1]

	$confirm = Read-Host "Apply '$($entry.Variant)' to $($group.Name)? (y/n)"
	if ($confirm -ieq 'y')
	{
		Apply-PresetEntry $entry
	}
	else
	{
		Write-Note 'Cancelled.'
	}
}

function Invoke-ApplyProfile
{
	$entries = Get-PresetFiles
	if (-not $entries -or $entries.Count -eq 0)
	{
		Write-Note 'No presets found in presets\. See presets\README.txt.'
		return
	}

	$tags = $entries | Select-Object -ExpandProperty Variant -Unique | Sort-Object
	Write-Host ''
	Write-Host 'Profile tags available:'
	for ($i = 0; $i -lt $tags.Count; $i++)
	{
		Write-Host ("  {0}) {1}" -f ($i + 1), $tags[$i])
	}
	Write-Host '  0) back'

	$idx = Read-Choice 'Pick a profile tag' $tags.Count
	if ($idx -lt 0) { return }
	$tag = $tags[$idx - 1]

	$matching = @($entries | Where-Object { $_.Variant -eq $tag })
	$matchingTargets = @($matching | Select-Object -ExpandProperty TargetRel)
	$allTargets = @($entries | Select-Object -ExpandProperty TargetRel -Unique)
	$untouched = @($allTargets | Where-Object { $matchingTargets -notcontains $_ })

	Write-Host ''
	Write-Host "Profile '$tag' will change:"
	foreach ($m in $matching) { Write-Host "  $($m.TargetRel)" }
	if ($untouched.Count -gt 0)
	{
		Write-Host "No '$tag' variant for (left unchanged):"
		foreach ($u in $untouched) { Write-Host "  $u" }
	}

	$confirm = Read-Host "Apply profile '$tag' to the $($matching.Count) target(s) above? (y/n)"
	if ($confirm -ine 'y')
	{
		Write-Note 'Cancelled.'
		return
	}

	foreach ($m in $matching) { Apply-PresetEntry $m }

	Write-Host ''
	Write-Host 'Summary:'
	foreach ($m in $matching) { Write-Host "  [applied]                         $($m.TargetRel)" }
	foreach ($u in $untouched) { Write-Host "  [no '$tag' variant, left unchanged] $u" }
}

function Invoke-TogglePlugins
{
	$pluginsPath = Join-Path $ConfigsDir 'plugins.ini'
	if (-not (Test-Path -LiteralPath $pluginsPath))
	{
		Write-Warn "plugins.ini not found at $pluginsPath"
		return
	}

	while ($true)
	{
		$lines = Read-LinesRaw $pluginsPath
		$rows = New-Object System.Collections.ArrayList
		for ($i = 0; $i -lt $lines.Count; $i++)
		{
			# A toggleable plugin line is an optional single leading ";" (disabled)
			# with no space before the filename, directly followed by name.amxx.
			# A commented-out SECTION HEADER is "; " (semicolon, space, prose) and
			# never matches this, so the two are never confused.
			if ($lines[$i].TrimStart() -match '^(;)?([A-Za-z0-9_\-]+\.amxx)\b')
			{
				[void]$rows.Add([pscustomobject]@{
					Index    = $i
					Name     = $Matches[2]
					Disabled = [bool]$Matches[1]
				})
			}
		}

		if ($rows.Count -eq 0)
		{
			Write-Warn 'No plugin lines recognized in plugins.ini.'
			return
		}

		Write-Host ''
		Write-Host 'Plugins in plugins.ini:'
		for ($k = 0; $k -lt $rows.Count; $k++)
		{
			$state = if ($rows[$k].Disabled) { 'off' } else { 'ON ' }
			Write-Host ("  {0,2}) [{1}] {2}" -f ($k + 1), $state, $rows[$k].Name)
		}
		Write-Host '   0) back'

		$idx = Read-Choice 'Toggle which number' $rows.Count
		if ($idx -lt 0) { return }
		$row = $rows[$idx - 1]

		Backup-Target $pluginsPath 'plugins.ini'
		if ($row.Disabled)
		{
			$lines[$row.Index] = $lines[$row.Index] -replace '^(\s*);', '$1'
			$newState = 'ON'
		}
		else
		{
			$lines[$row.Index] = $lines[$row.Index] -replace '^(\s*)', '$1;'
			$newState = 'off'
		}
		Write-Lines $pluginsPath $lines
		Write-Note "$($row.Name) is now $newState"
	}
}

# ---- main --------------------------------------------------------------------------
Write-Note "H9 Preset Switcher -- $ConfigsDir"
while ($true)
{
	Write-Host ''
	Write-Host '1) Swap one config file from a preset'
	Write-Host '2) Apply a full profile (every target that has a given tag)'
	Write-Host '3) Toggle individual plugins (plugins.ini)'
	Write-Host '4) Exit'
	$choice = Read-Host 'Choose'

	try
	{
		switch ($choice)
		{
			'1' { Invoke-SwapOne }
			'2' { Invoke-ApplyProfile }
			'3' { Invoke-TogglePlugins }
			'4' { Write-Note 'Bye.'; exit 0 }
			default { Write-Warn 'Not a valid choice.' }
		}
	}
	catch
	{
		Write-Warn "Something went wrong: $($_.Exception.Message)"
	}
}

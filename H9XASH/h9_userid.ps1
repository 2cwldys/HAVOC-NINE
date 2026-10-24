# h9_userid.ps1 -- makes this install's client id once, and turns it into what the engine reads.
#
# h9xash.bat runs this before HAVOC 9.exe starts. It writes:
#   user_id.ini              this install's id, made once and kept after that (unless
#                             h9_regenerate_userid.bat is run, or -Force is passed here)
#   ts\userid_resolved.cfg   cl_h9_userid, set from user_id.ini, run by ts\userconfig.cfg
#
# The raw id in user_id.ini is never sent to a server as-is -- the engine salts it
# per destination server before it goes out. See docs\CUSTOM_XASH_USERID.txt.
#
# A failure never stops the game. Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot,
	[switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$TsDir = Join-Path $Root 'ts'
$IniPath = Join-Path $Root 'user_id.ini'
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Banner = '// Written by h9_userid.ps1 from user_id.ini on every launch. Do not edit here.'

function Write-Note([string]$Text)
{
	Write-Host "[h9-uid] $Text"
}

function Write-Warn([string]$Text)
{
	Write-Host "[h9-uid] WARNING: $Text" -ForegroundColor Yellow
}

function Read-StoredId([string]$Path)
{
	if (-not (Test-Path -LiteralPath $Path)) { return $null }
	$section = ''
	foreach ($raw in [System.IO.File]::ReadAllLines($Path))
	{
		$line = $raw.Trim()
		if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
		if ($line -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
		if ($section -ne 'client') { continue }
		$eq = $line.IndexOf('=')
		if ($eq -ge 1 -and $line.Substring(0, $eq).Trim().ToLowerInvariant() -eq 'id')
		{
			return $line.Substring($eq + 1).Trim()
		}
	}
	return $null
}

function Write-StoredId([string]$Path, [string]$Id)
{
	$lines = @(
		"; user_id.ini -- this install's regenerable client id. Made once, on first run.",
		'; NOT a hardware fingerprint: a plain random value you can throw away and replace',
		'; any time with h9_regenerate_userid.bat. The engine never sends this value as-is',
		'; to a server -- see docs\CUSTOM_XASH_USERID.txt.',
		'',
		'[client]',
		"id=$Id"
	)
	[System.IO.File]::WriteAllText($Path, (($lines -join "`r`n") + "`r`n"), $Utf8)
}

# ---- main ------------------------------------------------------------------------
$id = $null
try { $id = Read-StoredId $IniPath } catch { $id = $null }
$valid = $id -and ($id -match '^[0-9a-f]{32}$')

if ($Force -or -not $valid)
{
	if ($Force) { Write-Note 'making a new id (-Force).' }
	elseif ($id) { Write-Warn "user_id.ini's id looked wrong -- making a new one." }
	else { Write-Note 'no user_id.ini yet -- making this install''s id.' }

	$id = [guid]::NewGuid().ToString('N')
	try
	{
		Write-StoredId $IniPath $id
		Write-Note 'id saved to user_id.ini.'
	}
	catch
	{
		Write-Warn "could not write user_id.ini: $($_.Exception.Message). Using this id for this launch only."
	}
}
else
{
	Write-Note 'using the id already in user_id.ini.'
}

try
{
	New-Item -ItemType Directory -Force -Path $TsDir | Out-Null
	[System.IO.File]::WriteAllText((Join-Path $TsDir 'userid_resolved.cfg'),
		(($Banner, "cl_h9_userid `"$id`"") -join "`r`n") + "`r`n", $Utf8)
}
catch
{
	Write-Warn "could not write ts\userid_resolved.cfg: $($_.Exception.Message). The engine will have no id this launch."
}
exit 0

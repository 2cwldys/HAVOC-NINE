# h9_userid.ps1 -- makes this install's client id once, and turns it into what the engine reads.
#
# h9xash.bat runs this before HAVOC 9.exe starts. It writes:
#   user_id.ini              this install's id, made once and kept after that (unless
#                             h9_regenerate_userid.bat is run, or -Force is passed here)
#   ts\userid_resolved.cfg   cl_h9_userid, set from user_id.ini, run by ts\userconfig.cfg
#
# -SetId <id> (enter_userid.cmd) puts the player id of the player's havoc9.org account in
# user_id.ini instead, so servers see this install and the web client as the same player.
# The id it replaces is kept in user_id.ini.bak.
#
# The raw id in user_id.ini is never sent to a server as-is -- the engine salts it
# per destination server before it goes out. See docs\CUSTOM_XASH_USERID.txt.
#
# A failure never stops the game. Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot,
	[switch]$Force,
	[string]$SetId
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
		'; to a server -- see docs\CUSTOM_XASH_USERID.txt. It may instead be the player id',
		'; of your havoc9.org account, put here by enter_userid.cmd or by hand.',
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

if ($PSBoundParameters.ContainsKey('SetId'))
{
	# a pasted id may carry spaces, quotes or capitals; the engine salts the lowercase text
	$new = ($SetId -replace '[\s"'']', '').ToLowerInvariant()
	if ($new -notmatch '^[0-9a-f]{32}$')
	{
		Write-Warn 'that is not a player id: it is 32 characters, 0-9 and a-f (havoc9.org, ACCOUNT). Nothing was changed.'
		exit 1
	}
	if ($valid -and $id -eq $new)
	{
		Write-Note 'this install already uses that id.'
	}
	else
	{
		if (Test-Path -LiteralPath $IniPath)
		{
			Copy-Item -LiteralPath $IniPath -Destination "$IniPath.bak" -Force
			Write-Note 'the id it replaces is kept in user_id.ini.bak.'
		}
		Write-StoredId $IniPath $new
		Write-Note 'id saved to user_id.ini: servers now see this install as the same player as your havoc9.org account.'
	}
	$id = $new
}
elseif ($Force -or -not $valid)
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

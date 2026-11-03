# h9_userid.ps1 -- this install's client id: what the launcher still does for it, and the old ways
# of changing it by hand.
#
# The engine owns the id now (engine-h9-link.patch, docs\CUSTOM_XASH_USERID.txt): it keeps it in
# user_id.ini protected for this Windows user, reads it itself, makes it when there is none, and
# links it to a havoc9.org account from the main menu (Link your Account). So on every launch
# (h9xash.bat runs this before HAVOC 9.exe starts) this script only clears the id out of the plain
# text files older builds left it in:
#   ts\userid_resolved.cfg   written again with no id in it (ts\userconfig.cfg still runs it: the
#                            web client writes its own copy there)
#   ts\config.cfg            any cl_h9_userid line taken out, everything else left as it is
#
# -SetId <id> (enter_userid.cmd) puts a player id in user_id.ini as a plain id= line, beside the
# protected records already there; the game takes it and protects it at its next start.
# -Force (h9_regenerate_userid.bat) deletes user_id.ini: the game makes a new id at its next start.
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
$Resolved = @(
	'// Written by h9_userid.ps1 on every launch. Do not edit here.',
	'// The engine reads this install''s id from user_id.ini itself, protected: nothing to set here.'
)

function Write-Note([string]$Text)
{
	Write-Host "[h9-uid] $Text"
}

function Write-Warn([string]$Text)
{
	Write-Host "[h9-uid] WARNING: $Text" -ForegroundColor Yellow
}

# the protected= lines under [client], as they are
function Read-Protected([string]$Path)
{
	$kept = @()
	if (-not (Test-Path -LiteralPath $Path)) { return $kept }
	$section = ''
	foreach ($raw in [System.IO.File]::ReadAllLines($Path))
	{
		$line = $raw.Trim()
		if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
		if ($line -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
		if ($section -ne 'client') { continue }
		$eq = $line.IndexOf('=')
		if ($eq -ge 1 -and $line.Substring(0, $eq).Trim().ToLowerInvariant() -eq 'protected')
		{
			$kept += $line.Substring($eq + 1).Trim()
		}
	}
	return $kept
}

# ---- -SetId: enter_userid.cmd ---------------------------------------------------------
if ($PSBoundParameters.ContainsKey('SetId'))
{
	# a pasted id may carry spaces, quotes or capitals; the engine salts the lowercase text
	$new = ($SetId -replace '[\s"'']', '').ToLowerInvariant()
	if ($new -notmatch '^[0-9a-f]{32}$')
	{
		Write-Warn 'that is not a player id: it is 32 characters, 0-9 and a-f (havoc9.org, ACCOUNT). Nothing was changed.'
		exit 1
	}
	try
	{
		$lines = @(
			'; user_id.ini -- this install''s client id. The engine reads and writes this file.',
			'; The id= line below was put here by enter_userid.cmd: the game takes it and protects',
			'; it at its next start. See docs\CUSTOM_XASH_USERID.txt.',
			'',
			'[client]',
			"id=$new"
		)
		foreach ($p in (Read-Protected $IniPath)) { $lines += "protected=$p" }
		[System.IO.File]::WriteAllText($IniPath, (($lines -join "`r`n") + "`r`n"), $Utf8)
		Write-Note 'id saved to user_id.ini. The game protects it at its next start, and servers then see this install as that player.'
		Write-Note 'Easier next time: Link your Account in the game''s main menu, with no id to paste.'
	}
	catch
	{
		Write-Warn "could not write user_id.ini: $($_.Exception.Message). Nothing was changed."
		exit 1
	}
	exit 0
}

# ---- -Force: h9_regenerate_userid.bat --------------------------------------------------
if ($Force)
{
	try
	{
		if (Test-Path -LiteralPath $IniPath) { Remove-Item -LiteralPath $IniPath -Force }
		Write-Note 'user_id.ini deleted: the game makes a new id at its next start, not linked to any account.'
	}
	catch
	{
		Write-Warn "could not delete user_id.ini: $($_.Exception.Message). Nothing was changed."
		exit 1
	}
	exit 0
}

# ---- every launch: no id left in plain text where older builds put it ------------------
try
{
	New-Item -ItemType Directory -Force -Path $TsDir | Out-Null
	[System.IO.File]::WriteAllText((Join-Path $TsDir 'userid_resolved.cfg'), (($Resolved -join "`r`n") + "`r`n"), $Utf8)
}
catch
{
	Write-Warn "could not write ts\userid_resolved.cfg: $($_.Exception.Message)."
}

$Config = Join-Path $TsDir 'config.cfg'
try
{
	if (Test-Path -LiteralPath $Config)
	{
		# byte for byte: Latin-1 maps every byte to one character and back, whatever the file holds
		$latin = [System.Text.Encoding]::GetEncoding(28591)
		$text = $latin.GetString([System.IO.File]::ReadAllBytes($Config))
		$clean = [regex]::Replace($text, '(?im)^[ \t]*cl_h9_userid\b[^\r\n]*(\r?\n)?', '')
		if ($clean -ne $text)
		{
			[System.IO.File]::WriteAllBytes($Config, $latin.GetBytes($clean))
			Write-Note 'took the id out of ts\config.cfg: the engine keeps it protected in user_id.ini.'
		}
	}
}
catch
{
	Write-Warn "could not read or write ts\config.cfg: $($_.Exception.Message)."
}
exit 0

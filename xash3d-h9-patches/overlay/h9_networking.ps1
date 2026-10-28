# h9_networking.ps1 -- turns networking.ini into the files the engine reads at startup.
#
# h9xash.bat runs this before HAVOC 9.exe starts. It writes:
#   ts\xashcomm.lst               the server lists the Internet tab asks. masterstatic and
#                                 mastergs lines, read by engine\common\masterlist.c
#   ts\networking_resolved.cfg    cl_ticket_generator, then clearmasters and the same lists
#                                 again, run by ts\userconfig.cfg. The engine adds its own
#                                 FWGS list (xash.su) before it reads xashcomm.lst; that list
#                                 has no ts list and answers every Internet refresh with an
#                                 error, so only H9's lists are left to ask
#   steam\steam_appid.txt         only when the Steam broker starts, with the AppID it
#   steam\steam_browse_appid.txt  should use
#   steam\steam_broker.pid        only while a broker this launch started is running
#
# A failure never stops the game. Each problem prints one warning, the HTTP lists keep
# working, and the script exits 0. Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$TsDir = Join-Path $Root 'ts'
$SteamDir = Join-Path $Root 'steam'
$PidFile = Join-Path $SteamDir 'steam_broker.pid'
$BrokerExe = Join-Path $SteamDir 'steam_broker.exe'
$BrokerDll = Join-Path $SteamDir 'steam_api.dll'
$BrokerAddress = '127.0.0.1:27420'
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Banner = '// Written by h9_networking.ps1 from networking.ini on every launch. Do not edit here.'

function Write-Note([string]$Text)
{
	Write-Host "[h9-net] $Text"
}

function Write-Warn([string]$Text)
{
	Write-Host "[h9-net] WARNING: $Text" -ForegroundColor Yellow
}

function Write-Lines([string]$Path, [string[]]$Lines)
{
	[System.IO.File]::WriteAllText($Path, (($Lines -join "`r`n") + "`r`n"), $Utf8)
}

function Read-Ini([string]$Path)
{
	# Each [section] becomes a hashtable of lower-cased keys. Keys above any section go in ''.
	$sections = @{ '' = @{} }
	if (-not (Test-Path -LiteralPath $Path)) { return $sections }
	$section = ''
	foreach ($raw in [System.IO.File]::ReadAllLines($Path))
	{
		$line = $raw.Trim()
		if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
		if ($line -match '^\[(.+)\]$')
		{
			$section = $Matches[1].Trim().ToLowerInvariant()
			if (-not $sections.ContainsKey($section)) { $sections[$section] = @{} }
			continue
		}
		$eq = $line.IndexOf('=')
		if ($eq -lt 1) { continue }
		$sections[$section][$line.Substring(0, $eq).Trim().ToLowerInvariant()] = $line.Substring($eq + 1).Trim()
	}
	return $sections
}

function Get-Setting($Ini, [string]$Section, [string]$Key, [string]$Default)
{
	if ($Ini.ContainsKey($Section) -and $Ini[$Section].ContainsKey($Key)) { return [string]$Ini[$Section][$Key] }
	return $Default
}

function Stop-OldBroker
{
	# A broker left running by a launch that did not exit cleanly is ours by its pid file.
	if (-not (Test-Path -LiteralPath $PidFile)) { return }
	$pidText = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
	$oldId = 0
	if ([int]::TryParse([string]$pidText, [ref]$oldId))
	{
		$old = Get-Process -Id $oldId -ErrorAction SilentlyContinue
		if ($old -and $old.ProcessName -eq 'steam_broker')
		{
			Stop-Process -Id $oldId -Force -ErrorAction SilentlyContinue
			Write-Note "stopped a broker left over from an earlier launch (pid $oldId)."
		}
	}
	Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-Broker([string]$AppId, [string]$BrowseId)
{
	# Returns the process when it is still running a few seconds later, otherwise $null.
	if (-not ((Test-Path -LiteralPath $BrokerExe) -and (Test-Path -LiteralPath $BrokerDll)))
	{
		Write-Warn 'steam_broker=1, but steam\steam_broker.exe or steam\steam_api.dll is missing. Using the server lists only.'
		return $null
	}
	[System.IO.File]::WriteAllText((Join-Path $SteamDir 'steam_appid.txt'), $AppId, [System.Text.Encoding]::ASCII)
	[System.IO.File]::WriteAllText((Join-Path $SteamDir 'steam_browse_appid.txt'), $BrowseId, [System.Text.Encoding]::ASCII)
	$proc = Start-Process -FilePath $BrokerExe -WorkingDirectory $SteamDir -WindowStyle Hidden -PassThru
	Start-Sleep -Seconds 3
	$proc.Refresh()
	if ($proc.HasExited)
	{
		Write-Warn 'the Steam broker exited at once. Is Steam running and logged in? Using the server lists only.'
		return $null
	}
	return $proc
}

# ---- main ------------------------------------------------------------------------
$brokerProc = $null
$lists = New-Object System.Collections.ArrayList
try
{
	New-Item -ItemType Directory -Force -Path $TsDir | Out-Null
	$ini = Read-Ini (Join-Path $Root 'networking.ini')

	foreach ($key in @('list_static', 'list_bot'))
	{
		foreach ($item in ((Get-Setting $ini 'client' $key '') -split ','))
		{
			$url = $item.Trim().TrimEnd('/')
			if ($url -eq '') { continue }
			if ($url -notmatch '^https?://[^\s"]+$')
			{
				Write-Warn "$key entry '$url' is not an http:// or https:// address. Skipped."
				continue
			}
			if (-not $lists.Contains($url)) { [void]$lists.Add($url) }
		}
	}

	$appId = Get-Setting $ini 'broker' 'steam_appid' '480'
	$browseId = Get-Setting $ini 'broker' 'steam_browse_appid' '480'
	if ($appId -notmatch '^\d+$') { Write-Warn "steam_appid '$appId' is not a number. Using 480."; $appId = '480' }
	if ($browseId -notmatch '^\d+$') { Write-Warn "steam_browse_appid '$browseId' is not a number. Using 480."; $browseId = '480' }

	Stop-OldBroker
	if ((Get-Setting $ini 'client' 'steam_broker' '0').Trim() -eq '1')
	{
		$brokerProc = Start-Broker $appId $browseId
		if ($brokerProc)
		{
			Write-Lines $PidFile @([string]$brokerProc.Id)
			Write-Note "Steam broker started (pid $($brokerProc.Id), AppID $appId)."
		}
	}
}
catch
{
	Write-Warn "networking setup stopped early: $($_.Exception.Message). Using the defaults."
	$brokerProc = $null
	$lists = New-Object System.Collections.ArrayList
}

$ticket = 'revemu2013'
if ($brokerProc) { $ticket = 'steam' }

try
{
	$masters = @($Banner)
	foreach ($url in $lists) { $masters += "masterstatic `"$url`"" }
	if ($brokerProc) { $masters += "mastergs $BrokerAddress" }
	Write-Lines (Join-Path $TsDir 'xashcomm.lst') $masters
	$resolved = @($Banner, "cl_ticket_generator $ticket", 'clearmasters')
	foreach ($url in $lists) { $resolved += "addmasterstatic `"$url`"" }
	if ($brokerProc) { $resolved += "addmaster $BrokerAddress gs" }
	Write-Lines (Join-Path $TsDir 'networking_resolved.cfg') $resolved
	Write-Note ("server lists: {0} set. Ticket generator: {1}." -f $lists.Count, $ticket)
}
catch
{
	Write-Warn "could not write ts\xashcomm.lst or ts\networking_resolved.cfg: $($_.Exception.Message)"
}
exit 0

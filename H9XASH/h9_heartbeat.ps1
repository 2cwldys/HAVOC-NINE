# h9_heartbeat.ps1 -- tells the H9 server list that a dedicated server is up.
#
# h9xash_server.bat starts it beside HAVOC 9.exe -dedicated. Every two minutes, while that
# server runs with this port, it sends {"port": <port>} to <heartbeat_url>/v1/heartbeat, the
# list bot (serverlist-bot\README.md, docs\NETWORKING.txt section 7). The list takes the address
# the heartbeat comes from, asks that server for its info, and lists it while it answers, so
# players see it in the Internet tab. networking.ini, [server]:
#   heartbeat=1                                   0 turns it off (a LAN or private server)
#   heartbeat_url=https://havoc9.org/serverlist   where the list is
# It never stops or slows the server: a failure prints one line and it tries again in 15 seconds. It
# ends by itself once the server has stopped. Written for Windows PowerShell 5.1.

param(
	[int]$Port = 27015,
	[string]$Root = $PSScriptRoot,
	[int]$Seconds = 120
)

$ErrorActionPreference = 'Stop'

function Say([string]$Text)
{
	Write-Host "[h9-heartbeat] $Text"
}

# heartbeat and heartbeat_url under [server] in networking.ini, or their defaults
$on = '1'
$url = 'https://havoc9.org/serverlist'
$ini = Join-Path $Root 'networking.ini'
if (Test-Path -LiteralPath $ini)
{
	$section = ''
	foreach ($raw in [System.IO.File]::ReadAllLines($ini))
	{
		$line = $raw.Trim()
		if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
		if ($line -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLower(); continue }
		if ($section -ne 'server' -or $line -notmatch '^([^=]+)=(.*)$') { continue }
		$key = $Matches[1].Trim().ToLower()
		$value = $Matches[2].Trim()
		if ($key -eq 'heartbeat') { $on = $value } elseif ($key -eq 'heartbeat_url') { $url = $value }
	}
}
if ($on -ne '1') { Say 'heartbeat=0 in networking.ini: this server does not announce itself.'; exit 0 }
if ($url -notmatch '^https?://[^\s"]+$') { Say "heartbeat_url '$url' is not an http(s) address: no heartbeats."; exit 0 }
$target = $url.TrimEnd('/') + '/v1/heartbeat'
$body = '{"port":' + $Port + '}'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# True while HAVOC 9.exe -dedicated runs with this port
function Test-Server
{
	foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'HAVOC 9.exe'" -ErrorAction SilentlyContinue))
	{
		$cl = [string]$p.CommandLine
		if ($cl -notmatch '(^|\s)-dedicated(\s|$)') { continue }
		if ($cl -match ('-port\s+' + $Port + '(\s|$)')) { return $true }
		if ($Port -eq 27015 -and $cl -notmatch '-port\s') { return $true }
	}
	return $false
}

# havoc9.org's address, from h9_presence.cfg's h9_presence_url (without its /report), or ''
function Get-SiteUrl
{
	$cfg = Join-Path $Root 'ts\addons\amxmodx\configs\h9_presence.cfg'
	if (-not (Test-Path -LiteralPath $cfg)) { return '' }
	foreach ($raw in [System.IO.File]::ReadAllLines($cfg))
	{
		if ($raw -match '^\s*h9_presence_url\s+"([^"]+)"')
		{
			$u = $Matches[1].TrimEnd('/')
			if ($u -match '/report$') { $u = $u.Substring(0, $u.Length - 7) }
			if ($u -match '^https?://[^\s"]+$') { return $u }
		}
	}
	return ''
}

# What havoc9.org says of the server at this address: the chain the server browsers draw. It is not the list's word:
# the list says whether the server can be found, havoc9.org whether it runs the official preset.
function Get-Auth([string]$Site, [string]$Address)
{
	try { $text = (Invoke-WebRequest -Uri ($Site + '/servers/auth') -UseBasicParsing -TimeoutSec 10).Content }
	catch { return 'unknown: havoc9.org did not answer' }
	foreach ($line in ($text -split "`n"))
	{
		$p = $line.Trim() -split ' '
		if ($p.Length -ne 2 -or $p[0] -ne $Address) { continue }
		switch ($p[1])
		{
			'ok' { return 'authenticated (green chain)' }
			'rp' { return 'authenticated; a roleplay map, nothing is ranked (green chain)' }
			'mod' { return 'NOT authenticated: it runs something besides the official plugin list (red chain)' }
			'opt' { return 'NOT authenticated: h9_authenticated is 0 on this server (red chain)' }
		}
	}
	return 'not authenticated yet: havoc9.org has no report from this server (it sends one a few seconds after its plugins load)'
}

$waited = 0
while (-not (Test-Server))
{
	if ($waited -ge 90) { exit 0 }
	Start-Sleep -Seconds 5
	$waited += 5
}

$last = ''
$lastAuth = ''
$site = Get-SiteUrl
$failures = 0
while (Test-Server)
{
	$wait = $Seconds
	$address = ''
	try
	{
		$answer = Invoke-RestMethod -Method Post -Uri $target -ContentType 'application/json' -Body $body -TimeoutSec 20
		$address = [string]$answer.address
		$state = 'listed as ' + $address
		$failures = 0
	}
	catch
	{
		$code = 0
		try { $code = [int]$_.Exception.Response.StatusCode } catch { }
		switch ($code)
		{
			422 { $state = "not listed yet: the list got no answer from this server (a map loading does that; else open UDP port $Port to the internet). A server it listed stays listed for minutes; trying again soon" }
			401 { $state = 'not listed: this list takes heartbeats with its key only (open_heartbeats = 0)' }
			0 { $state = 'not listed: ' + $_.Exception.Message }
			default { $state = "not listed: the list answered $code" }
		}
		# a failure is tried again in 15 seconds (twelve times), not after the whole interval
		$failures++
		if ($failures -le 12) { $wait = 15 }
	}
	if ($state -ne $last) { Say "$target -- $state"; $last = $state }
	if ($site -ne '' -and $address -ne '')
	{
		$auth = Get-Auth $site $address
		if ($auth -ne $lastAuth) { Say "$site -- $auth"; $lastAuth = $auth }
	}
	for ($i = 0; $i -lt $wait -and (Test-Server); $i += 5) { Start-Sleep -Seconds 5 }
}
exit 0

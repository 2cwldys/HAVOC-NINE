# h9_heartbeat.ps1 -- tells the H9 server list that a dedicated server is up.
#
# h9xash_server.bat starts it beside HAVOC 9.exe -dedicated. Every two minutes, while that
# server runs with this port, it sends {"port": <port>} to <heartbeat_url>/v1/heartbeat, the
# list bot (serverlist-bot\README.md, docs\NETWORKING.txt section 7). The list takes the address
# the heartbeat comes from, asks that server for its info, and lists it while it answers, so
# players see it in the Internet tab. networking.ini, [server]:
#   heartbeat=1                                   0 turns it off (a LAN or private server)
#   heartbeat_url=https://havoc9.org/serverlist   where the list is
# It never stops or slows the server: a failure prints one line and it tries again later. It
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

$waited = 0
while (-not (Test-Server))
{
	if ($waited -ge 90) { exit 0 }
	Start-Sleep -Seconds 5
	$waited += 5
}

$last = ''
while (Test-Server)
{
	try
	{
		$answer = Invoke-RestMethod -Method Post -Uri $target -ContentType 'application/json' -Body $body -TimeoutSec 20
		$state = 'listed as ' + $answer.address
	}
	catch
	{
		$code = 0
		try { $code = [int]$_.Exception.Response.StatusCode } catch { }
		switch ($code)
		{
			422 { $state = "not listed: the list got no answer from this server; open UDP port $Port to the internet" }
			401 { $state = 'not listed: this list takes heartbeats with its key only (open_heartbeats = 0)' }
			0 { $state = 'not listed: ' + $_.Exception.Message }
			default { $state = "not listed: the list answered $code" }
		}
	}
	if ($state -ne $last) { Say "$target -- $state"; $last = $state }
	for ($i = 0; $i -lt $Seconds -and (Test-Server); $i += 10) { Start-Sleep -Seconds 10 }
}
exit 0

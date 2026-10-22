# h9_add_to_steam.ps1 -- adds, updates or removes a HAVOC 9 entry in Steam's list of
# Non-Steam games, so the library shows the game and starts h9xash.bat.
#
# Run it from the H9XASH folder with Steam closed. For each account on this machine it
# changes <Steam>\userdata\<account>\config\shortcuts.vdf, and keeps a backup of that
# file beside it. Nothing is written until every check has passed.
#
#   h9_add_to_steam.ps1               add the HAVOC 9 entry, or update it
#   h9_add_to_steam.ps1 -DryRun       show what would change, change nothing
#   h9_add_to_steam.ps1 -Remove       take the entry out again
#   h9_add_to_steam.ps1 -Account 123  only the account with that number
#
# Exit codes: 0 done, 1 an error (nothing was written), 2 Steam is running (nothing written).
# Written for Windows PowerShell 5.1.

param(
	[string]$Root = $PSScriptRoot,
	[string]$SteamPath = '',
	[string]$Name = 'HAVOC 9',
	[string]$Account = '',
	[switch]$DryRun,
	[switch]$Remove,
	[switch]$SkipRunningCheck
)

$ErrorActionPreference = 'Stop'

# shortcuts.vdf is Steam's binary KeyValues format. Field types: 0 = nested object,
# 1 = string, 2 = 32-bit number, 8 = end of the current object. A parsed object is a list
# of hashtables with T (type), K (key) and V (value, or the child list for type 0).
$script:Buf = [byte[]]@()
$script:Pos = 0
# Bytes after the top-level object. Steam writes one 0x08 there, and it is kept as read.
$script:Trailer = [byte[]]@(8)

function Read-VdfString
{
	$start = $script:Pos
	while ($script:Pos -lt $script:Buf.Length -and $script:Buf[$script:Pos] -ne 0) { $script:Pos++ }
	if ($script:Pos -ge $script:Buf.Length) { throw 'a name or value runs past the end of the file' }
	$text = [System.Text.Encoding]::UTF8.GetString($script:Buf, $start, $script:Pos - $start)
	$script:Pos++
	return $text
}

function Read-VdfChildren
{
	$list = New-Object System.Collections.ArrayList
	while ($true)
	{
		if ($script:Pos -ge $script:Buf.Length) { throw 'the file ends before its last object closes' }
		$type = $script:Buf[$script:Pos]
		$script:Pos++
		if ($type -eq 8) { break }
		$key = Read-VdfString
		switch ($type)
		{
			0 { [void]$list.Add(@{ T = 0; K = $key; V = (Read-VdfChildren) }) }
			1 { [void]$list.Add(@{ T = 1; K = $key; V = (Read-VdfString) }) }
			2
			{
				if ($script:Pos + 4 -gt $script:Buf.Length) { throw 'a number runs past the end of the file' }
				[void]$list.Add(@{ T = 2; K = $key; V = [BitConverter]::ToUInt32($script:Buf, $script:Pos) })
				$script:Pos += 4
			}
			default { throw "unknown field type $type at byte $($script:Pos)" }
		}
	}
	return ,$list
}

function Read-Shortcuts([byte[]]$Bytes)
{
	if ($Bytes.Length -eq 0) { $script:Trailer = [byte[]]@(8); return ,(New-Object System.Collections.ArrayList) }
	$script:Buf = $Bytes
	$script:Pos = 0
	if ($script:Buf[0] -ne 0) { throw 'the file does not start like a binary KeyValues file' }
	$script:Pos = 1
	if ((Read-VdfString) -cne 'shortcuts') { throw "the file's top-level name is not 'shortcuts'" }
	$root = Read-VdfChildren
	$rest = $script:Buf.Length - $script:Pos
	if ($rest -eq 0) { $script:Trailer = [byte[]]@() }
	elseif ($rest -eq 1 -and $script:Buf[$script:Pos] -eq 8) { $script:Trailer = [byte[]]@(8) }
	else { throw 'the file has data after its last object' }
	return ,$root
}

function Write-VdfString($Stream, [string]$Text)
{
	$bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
	$Stream.Write($bytes, 0, $bytes.Length)
	$Stream.WriteByte(0)
}

function Write-VdfChildren($Stream, $Children)
{
	foreach ($c in $Children)
	{
		switch ($c.T)
		{
			0 { $Stream.WriteByte(0); Write-VdfString $Stream $c.K; Write-VdfChildren $Stream $c.V; $Stream.WriteByte(8) }
			1 { $Stream.WriteByte(1); Write-VdfString $Stream $c.K; Write-VdfString $Stream $c.V }
			2 { $Stream.WriteByte(2); Write-VdfString $Stream $c.K; $n = [BitConverter]::GetBytes([uint32]$c.V); $Stream.Write($n, 0, 4) }
		}
	}
}

function Get-ShortcutBytes($List)
{
	$ms = New-Object System.IO.MemoryStream
	$ms.WriteByte(0)
	Write-VdfString $ms 'shortcuts'
	Write-VdfChildren $ms $List
	$ms.WriteByte(8)
	if ($script:Trailer.Length -gt 0) { $ms.Write($script:Trailer, 0, $script:Trailer.Length) }
	return $ms.ToArray()
}

function Test-SameBytes([byte[]]$A, [byte[]]$B)
{
	if ($A.Length -ne $B.Length) { return $false }
	for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
	return $true
}

# CRC-32 as zlib uses it. Steam names a non-Steam game by a CRC32 of its quoted exe path
# plus its name, with the top bit set. Windows PowerShell has no CRC function of its own.
$script:CrcTable = $null

function Get-Crc32([byte[]]$Data)
{
	# 64-bit arithmetic with explicit masks: -bxor on two uint32 values yields a signed result.
	if (-not $script:CrcTable)
	{
		$table = New-Object 'uint32[]' 256
		for ($i = 0; $i -lt 256; $i++)
		{
			[long]$c = $i
			for ($k = 0; $k -lt 8; $k++)
			{
				if (($c -band 1) -ne 0) { $c = ([long]3988292384 -bxor ($c -shr 1)) -band [long]4294967295 } else { $c = $c -shr 1 }
			}
			$table[$i] = [uint32]$c
		}
		$script:CrcTable = $table
	}
	[long]$crc = [long]4294967295
	foreach ($b in $Data)
	{
		$index = ($crc -bxor [long]$b) -band 0xFF
		$crc = ([long]$script:CrcTable[[int]$index] -bxor ($crc -shr 8)) -band [long]4294967295
	}
	return [uint32](($crc -bxor [long]4294967295) -band [long]4294967295)
}

function Get-ShortcutAppId([string]$QuotedExe, [string]$AppName)
{
	$data = [System.Text.Encoding]::UTF8.GetBytes($QuotedExe + $AppName)
	return [uint32](([long](Get-Crc32 $data)) -bor 2147483648)
}

function Get-Field($Children, [string]$Key)
{
	foreach ($c in $Children) { if ($c.K -ieq $Key) { return $c } }
	return $null
}

function Set-Field($Children, [int]$Type, [string]$Key, $Value)
{
	$f = Get-Field $Children $Key
	if ($f) { $f.T = $Type; $f.V = $Value }
	else { [void]$Children.Add(@{ T = $Type; K = $Key; V = $Value }) }
}

function Add-IfMissing($Children, [int]$Type, [string]$Key, $Value)
{
	if (-not (Get-Field $Children $Key)) { [void]$Children.Add(@{ T = $Type; K = $Key; V = $Value }) }
}

function Set-ShortcutFields($Children, [string]$Launcher, [string]$StartDir, [string]$Icon, [string]$AppName)
{
	$quotedExe = '"' + $Launcher + '"'
	Set-Field $Children 2 'appid' (Get-ShortcutAppId $quotedExe $AppName)
	Set-Field $Children 1 'AppName' $AppName
	Set-Field $Children 1 'Exe' $quotedExe
	Set-Field $Children 1 'StartDir' ('"' + $StartDir + '"')
	Set-Field $Children 1 'icon' $Icon
	Add-IfMissing $Children 1 'ShortcutPath' ''
	Add-IfMissing $Children 1 'LaunchOptions' ''
	Add-IfMissing $Children 2 'IsHidden' 0
	Add-IfMissing $Children 2 'AllowDesktopConfig' 1
	Add-IfMissing $Children 2 'AllowOverlay' 1
	Add-IfMissing $Children 2 'OpenVR' 0
	Add-IfMissing $Children 2 'Devkit' 0
	Add-IfMissing $Children 1 'DevkitGameID' ''
	Add-IfMissing $Children 2 'DevkitOverrideAppID' 0
	Add-IfMissing $Children 2 'LastPlayTime' 0
	Add-IfMissing $Children 0 'tags' (New-Object System.Collections.ArrayList)
}

# ---- main ----------------------------------------------------------------------------
function Get-SteamRoot
{
	if ($SteamPath -ne '') { return $SteamPath }
	$reg = Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue
	if ($reg -and $reg.SteamPath) { return ([string]$reg.SteamPath).Replace('/', '\') }
	return (Join-Path ${env:ProgramFiles(x86)} 'Steam')
}

$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$Launcher = Join-Path $Root 'h9xash.bat'
if (-not (Test-Path -LiteralPath $Launcher)) { Write-Host "[h9-steam] h9xash.bat is not in $Root. Run this from the H9XASH folder."; exit 1 }
$Icon = Join-Path $Root 'ts\game.ico'
if (-not (Test-Path -LiteralPath $Icon)) { $Icon = '' }

$steamRoot = Get-SteamRoot
if (-not (Test-Path -LiteralPath (Join-Path $steamRoot 'steam.exe'))) { Write-Host "[h9-steam] Steam is not at $steamRoot. Use -SteamPath."; exit 1 }
if ((Get-Process -Name steam -ErrorAction SilentlyContinue) -and -not $DryRun -and -not $SkipRunningCheck)
{
	Write-Host '[h9-steam] Steam is running. Close it first: Steam keeps its own copy of this list and would write it back over the change.'
	exit 2
}

$userdata = Join-Path $steamRoot 'userdata'
$accounts = @()
if (Test-Path -LiteralPath $userdata)
{
	$accounts = @(Get-ChildItem -LiteralPath $userdata -Directory | Where-Object { $_.Name -match '^\d+$' -and ($Account -eq '' -or $_.Name -eq $Account) })
}
if ($accounts.Count -eq 0) { Write-Host "[h9-steam] no Steam account folder to change under $userdata."; exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$status = 0
foreach ($a in $accounts)
{
	$cfgDir = Join-Path $a.FullName 'config'
	if (-not (Test-Path -LiteralPath $cfgDir)) { continue }
	$file = Join-Path $cfgDir 'shortcuts.vdf'
	$backup = $null
	try
	{
		$bytes = [byte[]]@()
		if (Test-Path -LiteralPath $file) { $bytes = [System.IO.File]::ReadAllBytes($file) }
		$list = Read-Shortcuts $bytes
		if ($bytes.Length -gt 0 -and -not (Test-SameBytes $bytes (Get-ShortcutBytes $list)))
		{
			throw 'reading it and writing it back does not give the same bytes, so it is left alone'
		}

		$existing = $null
		foreach ($e in $list)
		{
			if ($e.T -ne 0) { continue }
			$nm = Get-Field $e.V 'AppName'
			if ($nm -and ([string]$nm.V) -ieq $Name) { $existing = $e; break }
		}

		if ($Remove)
		{
			if (-not $existing) { Write-Host "[h9-steam] $($a.Name): no '$Name' entry, nothing to remove."; continue }
			[void]$list.Remove($existing)
			$action = 'remove'
		}
		elseif ($existing)
		{
			Set-ShortcutFields $existing.V $Launcher $Root $Icon $Name
			$action = 'update'
		}
		else
		{
			$max = -1
			foreach ($e in $list)
			{
				$n = 0
				if ($e.T -eq 0 -and [int]::TryParse([string]$e.K, [ref]$n) -and $n -gt $max) { $max = $n }
			}
			$fields = New-Object System.Collections.ArrayList
			Set-ShortcutFields $fields $Launcher $Root $Icon $Name
			[void]$list.Add(@{ T = 0; K = [string]($max + 1); V = $fields })
			$action = 'add'
		}

		$newBytes = Get-ShortcutBytes $list
		if ($bytes.Length -gt 0 -and (Test-SameBytes $bytes $newBytes))
		{
			Write-Host "[h9-steam] $($a.Name): already up to date."
			continue
		}
		if ($DryRun)
		{
			Write-Host "[h9-steam] $($a.Name): would $action '$Name' in $file (dry run, nothing written)."
			continue
		}

		if (Test-Path -LiteralPath $file)
		{
			$backup = "$file.h9-backup-$stamp"
			Copy-Item -LiteralPath $file -Destination $backup
		}
		$tmp = "$file.h9-new"
		[System.IO.File]::WriteAllBytes($tmp, $newBytes)
		$written = [System.IO.File]::ReadAllBytes($tmp)
		if (-not (Test-SameBytes $written (Get-ShortcutBytes (Read-Shortcuts $written))))
		{
			Remove-Item -LiteralPath $tmp -Force
			throw 'the new file did not read back the same, so nothing was replaced'
		}
		Move-Item -LiteralPath $tmp -Destination $file -Force

		$past = @{ add = 'added'; update = 'updated'; remove = 'removed' }[$action]
		$msg = "[h9-steam] $($a.Name): $past '$Name'."
		if ($backup) { $msg += " Backup: $backup" }
		Write-Host $msg
	}
	catch
	{
		Write-Host "[h9-steam] $($a.Name): $($_.Exception.Message)"
		$status = 1
	}
}
exit $status

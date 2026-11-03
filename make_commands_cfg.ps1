# make_commands_cfg.ps1 -- writes ts\commands.cfg, the game's copy of COMMANDS.txt.
#
# Typing "exec commands" in the game console prints the command reference. The file holds
# one echo per line of COMMANDS.txt, so the console shows the reference as the document
# reads. The console cannot escape a double quote, so those become single quotes, and tabs
# become spaces. Trailing blank lines are left out.
#
# xash.bat runs this before it copies the overlay, so the copy follows every edit to
# COMMANDS.txt. To write somewhere else, run it by hand with -Out <file>.

param(
	[string]$Source = (Join-Path $PSScriptRoot 'COMMANDS.txt'),
	[string]$Out = (Join-Path $PSScriptRoot 'xash3d-h9-patches\overlay\ts\commands.cfg')
)

$ErrorActionPreference = 'Stop'

$lines = [System.IO.File]::ReadAllLines($Source, [System.Text.Encoding]::ASCII)
$last = $lines.Length - 1
while ($last -ge 0 -and $lines[$last].Trim().Length -eq 0)
{
	$last--
}

$cfg = New-Object System.Collections.Generic.List[string]
$cfg.Add('// commands.cfg -- generated from COMMANDS.txt by make_commands_cfg.ps1. Edit that file instead.')
$cfg.Add('// Type exec commands in the game console to print the command reference.')

$count = 0
for ($i = 0; $i -le $last; $i++)
{
	$text = $lines[$i].Replace("`t", '    ').Replace('"', "'")

	if ($text -match '[^\x20-\x7E]')
	{
		throw "COMMANDS.txt line $($i + 1) is not plain ASCII"
	}

	if ($text.Trim().Length -eq 0)
	{
		$cfg.Add('echo')
		continue
	}

	# A backslash just before the closing quote would escape it, so a space goes after it.
	if ($text.EndsWith('\'))
	{
		$text += ' '
	}

	$cfg.Add('echo "' + $text + '"')
	$count++
}

[System.IO.File]::WriteAllText($Out, ($cfg -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
Write-Host "  ts\commands.cfg: $count lines from COMMANDS.txt"

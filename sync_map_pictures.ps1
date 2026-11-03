# sync_map_pictures.ps1 -- fills havoc9.org\assets\maps\ from presence\maps\: the map pictures
# the SERVERS page's live table shows, and the presence cards (h9web's mapPicturesUrl is
# /assets/maps/).
#
# presence\maps\<map>.png are H9's own map pictures, 512 x 512, the ones Discord Rich Presence
# shows. The site gets 256 x 256 copies under the same names, in lowercase: the table draws a
# picture at 64 x 36 and a presence card at less than 256, so the full size would only make
# each page about four times heavier. A square picture is scaled whole; any other is centred and
# cropped to a square first, as the page's object-fit: cover would crop it.
#
# A picture new or changed in presence\maps is made again, and one taken out of presence\maps is
# removed here too. Only names of letters, digits and _ . + - ending in .png are taken, so a
# backup such as h9_x.png.bak stays out. export.bat runs this on every export (site-maps-block);
# it can be run by hand as well.

param(
	[string]$Source = (Join-Path $PSScriptRoot 'presence\maps'),
	[string]$Out = (Join-Path $PSScriptRoot 'havoc9.org\assets\maps'),
	[int]$Size = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) {
	Write-Output "  [WARN] no map pictures at $Source"
	exit 1
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$made = 0
$kept = 0
$gone = 0
$want = @{}

foreach ($f in Get-ChildItem -LiteralPath $Source -File -Filter '*.png') {
	$name = $f.Name.ToLowerInvariant()
	if ($name -notmatch '^[a-z0-9_][a-z0-9_.+-]*\.png$') {
		continue
	}
	$want[$name] = $true
	$dest = Join-Path $Out $name
	# made from this very file before: its time is copied onto the copy
	if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).LastWriteTimeUtc -eq $f.LastWriteTimeUtc) {
		$kept++
		continue
	}
	$img = [System.Drawing.Image]::FromFile($f.FullName)
	try {
		$bmp = New-Object System.Drawing.Bitmap $Size, $Size
		try {
			$g = [System.Drawing.Graphics]::FromImage($bmp)
			try {
				$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
				$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
				$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
				$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
				$side = [Math]::Min($img.Width, $img.Height)
				$from = New-Object System.Drawing.Rectangle ([int](($img.Width - $side) / 2)), ([int](($img.Height - $side) / 2)), $side, $side
				$to = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
				$g.DrawImage($img, $to, $from, [System.Drawing.GraphicsUnit]::Pixel)
			} finally {
				$g.Dispose()
			}
			$tmp = $dest + '.part'
			$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
			Move-Item -LiteralPath $tmp -Destination $dest -Force
			(Get-Item -LiteralPath $dest).LastWriteTimeUtc = $f.LastWriteTimeUtc
		} finally {
			$bmp.Dispose()
		}
	} finally {
		$img.Dispose()
	}
	$made++
}

foreach ($d in Get-ChildItem -LiteralPath $Out -File) {
	if (-not $want.ContainsKey($d.Name)) {
		[System.IO.File]::Delete($d.FullName)
		$gone++
	}
}

Write-Output ("  havoc9.org\assets\maps\ ({0} made, {1} up to date, {2} removed; {3} x {3})" -f $made, $kept, $gone, $Size)

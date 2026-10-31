wad2png - GoldSrc WAD to PNG converter
======================================

Files
-----
wad2png.py   The converter (uses Python 3 and only the standard library)
wad2png.cmd  Windows launcher; keeps the console open so errors are visible
exported\   Created automatically when the tool runs

Quick start
-----------
1. Put wad2png.py and wad2png.cmd in the same folder.
2. Drag one or more .wad files onto wad2png.cmd, or open Command Prompt in
   this folder and run:

       wad2png.cmd "D:\path\to\halflife.wad"

3. PNG files are written to the "exported" folder beside the scripts.

Examples
--------
    wad2png.cmd textures.wad
    wad2png.cmd textures.wad -o exported_png
    wad2png.cmd *.wad
    wad2png.cmd "D:\WADs" --recursive
    wad2png.cmd textures.wad --overwrite
    wad2png.cmd gfx.wad --palette palette.lmp

Notes
-----
- Each lump is decoded by its WAD directory type:
    0x43 mip textures (the base mip level), 0x42 pictures (gfx.wad's LAMBDA,
    PAUSED, BACKTILE, ...), 0x46 fonts (CONCHARS, CREDITSFONT) and 0x40
    palettes (as a 16x16 swatch). Other lump types are reported as skipped.
- Everything is exported as an indexed PNG with its original palette.
- Palette index 255 is written as transparent where the engine draws it so:
  fonts, pictures that use it, and textures whose names start with "{".
- WAD3 lumps carry their own palette. WAD2 (Quake) pictures and textures do
  not: they use --palette (a 768-byte .lmp/.pal, or a WAD with a PALETTE
  lump), or else the WAD's own PALETTE lump. With neither, they are reported
  as skipped rather than producing incorrect colors.
- Compressed lumps are reported as skipped.
- File names keep GoldSrc's characters ({ + ~ #); only characters Windows
  cannot use in a file name are replaced.
- No third-party Python packages are required.
- Texture files are prefixed with the WAD filename to avoid name collisions.

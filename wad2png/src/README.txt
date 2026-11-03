wad2png - Native Windows GoldSrc WAD to PNG tool
=================================================

This package contains native C++ source and a Windows build script.

Build once on Windows
---------------------
1. Install Visual Studio Build Tools with "Desktop development with C++",
   or install MinGW-w64.
2. Run build.cmd.
3. The resulting wad2png.exe is standalone and does not need Python or
   third-party DLLs.

Usage
-----
    wad2png.exe textures.wad
    wad2png.exe one.wad two.wad -o exported
    wad2png.exe *.wad --overwrite
    wad2png.exe "D:\WADs" --recursive
    wad2png.exe gfx.wad --palette palette.lmp
    wad2png.exe --help

Output
------
By default, output is written to an "exported" folder beside wad2png.exe.
Textures are named <wadname>_<texture>.png. Existing names receive a numeric
suffix unless --overwrite is used.

Compatibility
-------------
Supports WAD2/WAD3 archive directories. Each lump is decoded by its directory
type: 0x43 mip textures, 0x42 pictures (gfx.wad's LAMBDA, PAUSED, BACKTILE,
...), 0x46 fonts (CONCHARS, CREDITSFONT) and 0x40 palettes (as a 16x16
swatch), each as an indexed PNG with its original palette. Palette index 255
is transparent where the engine draws it so: fonts, pictures that use it, and
textures whose names start with "{". WAD2 (Quake) lumps carry no palette and
use --palette, or else the WAD's own PALETTE lump. Compressed lumps and other
lump types are skipped with a message.

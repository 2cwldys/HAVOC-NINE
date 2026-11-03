# H9 purple `gfx.wad`

A purple replacement for Half-Life's `gfx.wad`, built for H9XASH's minimal
`valve/` folder. It keeps the original WAD3 structure exactly: the same seven
lumps, names, types, offsets and sizes. Only colour data, the `LAMBDA32` logo
pixels and `BACKTILE`'s grid differ.

## What changed

| Lump | Size | Original | Purple replacement |
|---|---|---|---|
| `LAMBDA` | 128x128 | "LOADING..." orange on black | `#b06cff` fill, `#140a20` outline (text kept) |
| `LAMBDA64` | 64x64 | "LOADING..." orange on black | `#b06cff` fill, `#140a20` outline (text kept) |
| `LAMBDA32` | 32x32 | orange lambda-in-circle logo | purple H9 helmet, 27x32 |
| `PAUSED` | 64x64 | orange "PAUSED" | `#c9a0ff` fill, `#140a20` outline |
| `CONCHARS` | 256x128 font | orange/brown console font | purple console ramp |
| `CREDITSFONT` | 256x64 font | white on black credits font | lavender on deep purple |
| `BACKTILE` | 64x64 | flat dark grey tile | `#140b1e` with a `#221434` 16 px grid |

`LAMBDA32` is the only actual Half-Life lambda logo in the WAD. `LAMBDA` and
`LAMBDA64` are the "LOADING..." plaques and their text is not replaced.

Index 255 (the transparent key) is untouched in every lump. The font headers,
the 256-entry character tables, every pixel index (except `LAMBDA32` and
`BACKTILE`) and the WAD directory are byte-identical to the original.

### Helmet

`LAMBDA32` is painted from `D:\Downloads\TSM\havoc9.org\h9helmet.png` (the
1254x1254 original; `presence\h9helmet.png` is the same art at 512x512 and
gives an almost identical 32x32 result). The build crops to the visible
895x1078 pixels, fits them to 32x32 without stretching (27x32, centred),
box-filters the alpha, and maps luminance through a purple ramp: the
near-black shell becomes deep purple, the orange trim becomes vivid
purple/lavender. The palette is rebuilt as `ramp(i/254)`; index 255 stays the
transparent key.

### Font size / Xash compatibility

The `CONCHARS` lump is the original variable-width Half-Life qfont (256x128,
12 px rows). In a minimal `valve/` without `fonts.wad`, Xash's default console
font path falls back to the fixed-width loader, which misreads the atlas. The
H9XASH `ts\userconfig.cfg` therefore sets:

```
con_oldfont "1"
con_fontscale "1.25"
```

`con_oldfont 1` loads `gfx/conchars.fnt` (the `CONCHARS` lump) through the
variable-width loader, and `con_fontscale 1.25` turns the 12 px rows into 15 px.
The same block is in `xash3d-h9-patches\overlay\ts\userconfig.cfg`.

## Files

```
gfxwad-replace/
  README.md
  build.bat              build + validate
  dist/
    gfx.wad              the replacement (86,608 bytes)
    REPORT.txt           what was built
    VALIDATION.txt       structural diff against the original
  art/
    original/            previews extracted from the original
    purple/              previews of the replacement
  tools/
    build.mjs            patches the palettes and paints LAMBDA32
    validate.mjs         checks the result against the original
    install.mjs          copies dist/gfx.wad into H9XASH\valve, with a backup
    inspect.mjs          original-lump inspector / preview extractor
    font-info.mjs        dumps the variable-width character tables
    font-masks.mjs       renders per-index font masks
    font-palette-dump.mjs
    helmet-inspect.mjs   PNG alpha/RGBA survey
    helmet-lum.mjs       helmet bbox and luminance histogram
    zoom.mjs             4x nearest-neighbour plaque previews
```

## Build

```bat
build.bat
```

or directly:

```bat
node tools\build.mjs
node tools\validate.mjs "D:\Downloads\TSM\backups\valve_TSM_20261030-230114\gfx.wad" "dist\gfx.wad" "dist\VALIDATION.txt"
```

The build reads the original from
`D:\Downloads\TSM\backups\valve_TSM_20261030-230114\gfx.wad`.

Current output SHA256:
`7F10AB360897DBCB054DF296645663A2F7CC4344CF38C4EAF4113C23E6FB47A2`.

## Install

```bat
node tools\install.mjs
```

This copies `dist\gfx.wad` to `D:\Downloads\TSM\H9XASH\valve\gfx.wad`. If a
file is already there, it is first copied to
`D:\Downloads\TSM\backups\valve_gfx_<timestamp>\gfx.wad`, and the report names
the overwritten file with its old size and SHA256. The copy is verified against
the source byte for byte.

## Notes

- The source is the original 86,608-byte Half-Life `gfx.wad`; the replacement
  is the same size, so nothing in the WAD directory moved.
- `BACKTILE` is the console background tile: dark purple with a 16 px grid that
  repeats seamlessly.
- If the console font ever looks wrong, check that `con_oldfont "1"` is still
  in effect; `con_fontscale` can be raised further (1.5 is the next step) if
  15 px rows are still too small.

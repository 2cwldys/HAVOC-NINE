# Turning a reference image into a model

The first thing to be clear about, because it decides how you prepare the art:

> **A reference image gives you a texture, not geometry.**

SMAK reads PNG and BMP and will put either on a model as a skin. It has no mesh
generation from images -- no photogrammetry, no depth inference, no silhouette
extrusion. Geometry comes from `workshop`'s primitives, built by hand, *guided by* the
reference. `ts-trial/scripts/05_gear.mjs` is the worked example: a riot shield and a
baton built from a quad grid and a lathe, with the reference informing the proportions
and the paint, not generating either.

So there are two separate jobs, and the reference serves them differently.

## Job one: the reference as a skin

This is where a reference image pays off immediately, and it is by far the cheaper of
the two.

```js
import { K, load, save, checked } from "./lib.mjs";
import { readFileSync } from "node:fs";

const mdl = load("XCCPsgts");
const art = K.textureFrom(readFileSync("refs/vest.png"), "02.bmp");
const out = K.replaceTexture(mdl, "02.bmp", art);
save("vest/XCCPsgts.mdl", checked("new vest", out));
```

`replaceTexture` takes the texture by name or index. Two behaviours worth knowing:

- **Same size replaces in place** and the file does not grow at all -- the one SMAK edit
  that is not an append.
- **A different size is rescaled for you**, corners mapped across, and appended.

### Preparing the art

| | |
|---|---|
| Format | PNG (8-bit greyscale/RGB/palette/alpha) or BMP (8-, 24-, 32-bit uncompressed). **No TGA** -- SMAK strips `.tga` from names but reads none. |
| Palette | The format is 8-bit paletted: 256 colours and a 768-byte table. An RGB source is quantised for you. |
| 8-bit BMP | **Keeps its palette index-for-index.** If you have control of the palette, this is the way to get exactly the colours you drew. |
| Name | Must end `.bmp` and be unique within the file -- `AGENTS.md` rule 5. |
| Transparency | Flag `64` is the masked flag; on a masked texture the last palette entry is the transparent one, so a painter must stop at index 254. |

### Sizes: match the original rather than fixing it

The TS originals are already strange: `552x474`, `536x506`, `496x518`. Neither a power
of two nor under 512. GoldSrc stretches to a power of two and shrinks anything over 512,
which is why `check` reports this as a *warning* and the originals raise it too:

```
6 textures larger than 512: GoldSrc draws nothing finer than gl_max_size
(512 by default, 256 in builds before 2023) and shrinks them
```

Keep each texture's original size. Supplying a tidy 512x512 where the original was
552x474 changes the UV mapping of every triangle that uses it, and SMAK will rescale
your art to fit anyway. If you want more effective resolution you are fighting
`gl_max_size`, not the file.

Note how much this varies by model: `XCCPsgts` has 7 textures, all large. `repuheavy`
has 27, most of them 64x64 or smaller. Run `node modelling/inspect.mjs <name>` first.

### Find out which texture is which part

Do not guess from names like `04.bmp`. The trial's `00_seen.mjs` renders a model once
per texture with every other mesh emptied, which produces a labelled map of which part
wears which sheet -- `ts-trial/00_originals_seen/parts_XCCPsgts.png`. The CLI route:

```
node smak/bin/smak.mjs textures <mdl> -o out/tex
node smak/bin/smak.mjs uv       <mdl> -o out/uv
```

`uv` draws the triangle layout over each sheet, which is what you need to paint onto one
by hand.

## The sharing trap: left and right are often the same pixels

This one catches everybody, and the trial measured it:

> **Left and right share texture.** Between a third and two thirds of the pixels of the
> arm, gear and helmet textures are worn by two places of the body at once, so a mark
> painted on one side shows on the other. The trousers and vest are not shared.

So "a scar on his left cheek" or "unit insignia on the right shoulder only" may be
impossible on a given model. `paint()` reports it: its `shared` output tells you which
pixels are doubled, and `AGENTS.md` makes saying so an obligation --

> **Read `shared`.** Tell the person when a one-sided mark they asked for cannot be
> one-sided.

If you need it one-sided, you need a *second* texture and the mesh retargeted to it
(`retexture(src, where, texture, uvOf?)`), which is a geometry change, not a paint.

## Job two: the reference as a guide for geometry

Build with `workshop`. The primitives:

```js
const S = W.sheet(256, 256, [0.06, 0.065, 0.07]);   // the picture, with a ground colour
const M = W.shape(256, 256);                        // the triangles

S.zone({ x, y, w, h }, (u, v) => [r, g, b]);        // paint a rectangle of it by rule
M.V(point, [px, py]);                               // a corner: model space + pixel UV
M.quad(a, b, c, d, insidePoint);                    // winding worked out from `inside`
M.lathe(profile, zone, { sides, px, caps, at });    // turned shapes: batons, canisters
M.plate(stations, zoneA, zoneB, opts);              // swept plates
```

Two things make this bearable:

1. **`quad`/`tri` take a point *inside* the solid** and derive the winding from it, so
   you never reason about triangle order.
2. **`zone`'s `bleed` defaults to 4 pixels outside the rectangle**, so texture filtering
   at a seam does not pull in the neighbouring zone.

### Measure the model; do not eyeball coordinates

The reference tells you proportions. The *model* tells you where things are. Probe the
posed surface:

```js
const surf = surface(mdl);                           // [{ p: [x,y,z], tex, ... }]

const backAt = Math.min(...surf                      // how far back the vest reaches
  .filter((s) => Math.abs(s.p[1]) < 5 && s.p[2] > 6 && s.p[2] < 24)
  .map((s) => s.p[0]));
```

Axes on these models: **+x behind, +y to his left, +z up.** Units are the engine's.

### Lettering

`K.label(img, text, x, y, scale, colour)` draws the kit's own letters into an RGBA
buffer. The trial's trick for stamping them onto a painted sheet is to draw into a
scratch buffer in pure red and copy only the red pixels, which avoids the label's own
background:

```js
const ink = { width: 64, height: 16, rgba: new Uint8Array(64 * 16 * 4) };
K.label(ink, "XCCP", 0, 0, 2, [255, 0, 0]);
// then copy only pixels where red > 200 and green < 60
```

## The loop, which is not optional

`AGENTS.md` mandates it and it exists because a model that parses can still be inside
out, tiny, or facing backwards:

1. `info` and `sheet` the original. Look at it.
2. Write a script in `modelling/`, reading the original, writing to `modelling/out/`.
3. `check(mdl, "goldsrc")` in the script. Fail loudly -- use `checked()` from `lib.mjs`.
4. `render` / `sheet` / `strip` to PNG **and look at the PNG.** Compare with step 1.
5. `node smak/bin/smak.mjs view <originals> <out>` to show it side by side.
6. Put it in the game. That is the only real test.

One caution specific to painting from references: **`paint()` requantises the texture
through median-cut each time it touches it**, so painting over a painted result degrades
the palette. Build each variant from the pristine original with more in the paint
function, never by stacking passes. That is the same rule as everything else here, for a
different reason.

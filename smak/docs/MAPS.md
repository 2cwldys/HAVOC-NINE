# SMAK and maps: reading a compiled map

Everything here is exported from `src/maps/index.mjs`. A map is a Node `Buffer` holding the whole `.bsp` file;
`readBsp` gives a plain object over it, and the functions below take that object. A function that changes a map
returns a **new** buffer. Apart from `wadsFor` and `texturesFor` (and the pictures, when they are given
`folders`), which look for files in folders you name, nothing here touches the disk.

```js
import { readFileSync, writeFileSync } from "node:fs";
import * as maps from "./smak/src/maps/index.mjs";

const bytes = readFileSync("gatecity.bsp");
const bsp = maps.readBsp(bytes);
const start = maps.byClass(bsp.entities, "info_player_start")[0];
console.log(maps.contentsName(maps.contentsAt(bsp, maps.originOf(start))));   // "empty"

const moved = maps.moveEntity(bsp.entities, start, [96, 96, 40]);
writeFileSync("gatecity_moved.bsp", maps.withEntities(bytes, moved));          // never over the original
```

This page covers reading a compiled map, its textures and `.wad` files, changing its entities, and drawing
it ("Pictures", which also draws brush source). Writing brush source (`.map`) and compiling it are the other
half of `src/maps/`, in `docs/MAPS-MAKING.md`. The command line has a command for most of this: `smak map-info`,
`map-check`, `map-entities`, `map-set`, `map-plan`, `map-view`, `map-views`, `map-textures`, `wad`, `wad-make` and
`map-compile` (`node bin/smak.mjs help`; `AGENTS.md` has them with their recipes).

## What a compiled map is

A `.bsp` of GoldSrc is version 30: four bytes that say so, then a table of fifteen **lumps** (where each
begins and how long it is), then the lumps. Quake 1's maps are version 29 and Quake 3's begin with the letters
`IBSP`: other formats, refused in words. The engine finds every lump through the table alone; the lumps may lie
in any order.

| Lump | What it holds | In `readBsp`'s result |
| --- | --- | --- |
| `entities` | Text: every entity as `{ "key" "value" ... }`, the world itself first | `entities` |
| `planes` | The planes the world is cut by | `planes` |
| `textures` | The names and sizes of the textures, and the pixels of those kept inside the map | `textures` (the directory) |
| `vertices`, `edges`, `surfedges` | The corners of the faces: a face walks a run of surfedges, each an edge, each two vertices | `vertices`, `edges`, `surfedges` |
| `faces` | The polygons that are drawn | `faces` |
| `texinfo` | How a texture lies on a face: two axes and two offsets | `texinfo` |
| `lighting` | The baked light, three bytes a sample | read by `faceLightmap` |
| `nodes`, `leaves` | The tree the drawn world is cut into: a node is a plane with a child on each side, a leaf is a convex room of space with one **contents** | `nodes`, `leaves` |
| `marksurfaces` | For each leaf, the faces that touch it | `marksurfaces` |
| `visibility` | For each leaf, the leaves that can be seen from it, packed | read by `visibleFrom` |
| `clipnodes` | Three more trees, for what a moving box bumps into | `clipnodes` |
| `models` | Model 0 is the world; each of the others is the brushes of one entity (a door is `"model" "*7"`) | `models` |

**Units and axes.** A unit is about an inch; `+z` is up. A player is 72 tall and 32 wide.

**Contents.** What a leaf holds, in `CONTENTS`: `EMPTY` -1, `SOLID` -2, `WATER` -3, `SLIME` -4, `LAVA` -5,
`SKY` -6, then the water currents (-9 to -14), `TRANSLUCENT` -15 and `LADDER` -16. `ORIGIN` -7 and `CLIP` -8
are used up by the compiler and are not in a compiled map. `contentsName(n)` puts a number in words. Everything
outside the map is solid, and every solid place is the one leaf 0.

**Hulls.** The engine does not move a box through the world: it moves a point through a copy of the world in
which every wall was grown by half the box. A map carries four such copies, `HULLS`:

| Hull | For | The box |
| --- | --- | --- |
| 0 | a point: a bullet, a line of sight, the drawn world itself (the nodes and leaves) | none |
| 1 | a standing player | 32 x 32 x 72 |
| 2 | a large monster | 64 x 64 x 64 |
| 3 | a crouching player | 32 x 32 x 36 |

So "can a player stand here" is `contentsAt(bsp, middleOfThePlayer, { hull: 1 }) !== CONTENTS.SOLID`, with the
middle 36 units over the feet. Hulls 1 to 3 know only solid and not solid as a rule, and they hold what the
mapper's invisible `clip` brushes block, which hull 0 does not.

**Brush entities.** A door, a grate, a `func_wall` has its own model, with its own little tree, in the model's
own space. It is **not** in the world's tree: `contentsAt` over the world says a doorway is empty though a
closed door stands in it. Ask the model (`{ model: n }`), taking the entity's `origin` from the point first.

**How textures are found.** The map's texture directory names every texture and gives its size. For each, the
pixels are either inside the map (`embedded`: four sizes of palette indices and a palette of 256 colours) or
left out, and then the engine looks for the name, whatever its case, in the `.wad` files that the worldspawn's
`wad` key lists. That key holds paths from the mapper's machine, joined by `;`: only the file names count, and
they are looked for in the mod's folder and then in `valve`. GoldSrc opens **every** listed file when a map
wants even one texture from outside, and stops with an error when one is not there; it never looks in
`pldecal.wad` or `tempdecal.wad`. A texture's name says what it is (`{` holes, `!` a liquid, `sky`, `+0` an
animation...): the table is in `docs/MAPS-MAKING.md`, "Textures", and `textureKind(name)` reads a name. Both
sides of a texture are multiples of 16.

**Light.** Each lit face has a small picture of light, one sample for every 16 units along its texture's axes.
Its size is nowhere in the file: it is worked out from the face's corners (`lightmapSize`). A face can be lit
by up to four **light styles**, and keeps one such picture for each, one after another. Style 0 is the light
that is always on. Styles 1 to 11 are the game's patterns that flicker and pulse (a `light` entity's `style`
key); from 32 up, the compiler gives a number to each group of lights that carry a `targetname`, so that a
switch can turn them on and off. The game multiplies each style's picture by how bright that style is at the
moment and adds them up. 255 in a face's list means "no style here". The samples are what the compiler wrote,
before the engine's gamma: what the game shows is brighter than these bytes read as plain colours.

**Visibility.** For each leaf the compiler (hlvis) works out which other leaves could possibly be seen from
anywhere inside it; the engine draws only those. A map compiled without it, or with a leak, has none, and the
whole map is drawn from everywhere.

## Reading (`src/maps/bsp.mjs`)

| Function | Gives |
| --- | --- |
| `readBsp(bytes)` | `{ bytes, version, blueShift, lumps, entities, planes, vertices, edges, surfedges, faces, texinfo, textures, models, nodes, leaves, marksurfaces, clipnodes }`. Throws, in words, unless the file is a whole GoldSrc map. The shapes are below. |
| `contentsAt(bsp, point, { hull = 0, model = 0 })` | The contents at `[x, y, z]`: a number of `CONTENTS`. `hull` 0 to 3; `model` the map's model to ask. |
| `contentsName(n)` | `"empty"`, `"solid"`, `"water"` ...; `"unknown (n)"` for a number the format does not name. |
| `leafAt(bsp, point, model = 0)` | The number of the leaf a point is in. 0: solid. |
| `floorUnder(bsp, point, { hull = 0, model = 0, reach = 4096 })` | The `z` at which solid begins straight under the point, to a 64th of a unit; `null` when the point is in solid or nothing is found within `reach`. With hull 1 it is where a standing player's middle rests: his feet are 36 lower. It does not know of brush entities (a crate, a bridge that is a `func_wall`): ask their models too. |
| `worldBounds(bsp)` | `{ mins, maxs }` of the world. |
| `modelFaces(bsp, model = 0)` | The faces of one model: the world's, or a brush entity's. |
| `facePolygon(bsp, face)` | A face's corners `[[x, y, z]]`, clockwise as seen from the side it looks to. `face` is one of `bsp.faces` or its number. Three corners in a row can lie on one line (the compiler adds corners where a neighbour's edge ends). |
| `faceNormal(bsp, face)` | The way it looks: its plane's normal, turned about when `face.side` is not 0. |
| `faceTexture(bsp, face)` | The directory entry of its texture. |
| `faceTexels(bsp, face)` | Each corner's place on the texture in pixels from its top left, `[[s, t]]`; past the picture's sides where it repeats. |
| `faceUvs(bsp, face)` | The same as the kit's `uv`: `[[u, v]]`, 1 for one turn of the texture. |
| `hasLightmap(bsp, face)` | Whether it has baked light. Sky and liquids have none; nor has a face whose styles are all 255, even where its `lightOffset` looks good (the compiler leaves a stale one). |
| `lightmapSize(bsp, face)` | `{ width, height, originS, originT }`: samples across and down, and the texture pixel the first stands on. |
| `faceLightmap(bsp, face)` | `{ width, height, originS, originT, styles: [{ style, rgb }] }`, or `null`. `rgb`: `width * height` samples of three bytes, a view of the map. The sample for texture pixel `(s, t)` is at `((s - originS) / 16, (t - originT) / 16)`. |
| `visibleFrom(bsp, leaf)` | The numbers of the leaves seen from a leaf, itself among them; `null` when the map keeps none for it (then everything is drawn). |
| `sees(bsp, from, to)` | Whether one leaf is seen from another. |
| `embeddedTexture(bsp, which)` | A texture whose pixels are in the map (see "A map texture"), or `null` when it is wanted from a `.wad`. `which`: its number or its name. |
| `wantedTextures(bsp)` | `{ wads, textures }`: the `.wad` file names the worldspawn lists, as the engine looks for them, and the names of the textures left to them. |

What `readBsp` gives, entry by entry:

| | |
| --- | --- |
| `lumps` | `{ entities: { name, slot, offset, length, inside }, ... }` for all fifteen |
| `entities` | A list; each entity is a list of `[key, value]` pairs in the file's order (see "Entities") |
| `planes` | `[{ normal, dist, type }]`: the points `p` with `normal . p = dist` |
| `vertices`, `edges`, `surfedges` | `[[x, y, z]]`, `[[vertex, vertex]]`, `[edge, or minus an edge walked backwards]` |
| `faces` | `[{ plane, side, firstEdge, edgeCount, texinfo, styles: [4], lightOffset }]` |
| `texinfo` | `[{ s: [x, y, z, offset], t: [x, y, z, offset], texture, flags }]`; flag 1: sky or liquid, not lit |
| `textures` | `[{ index, name, width, height, embedded, absent, at }]`. `absent`: the map leaves the entry empty |
| `models` | `[{ mins, maxs, origin, headNodes: [4], visLeaves, firstFace, faceCount }]` |
| `nodes` | `[{ plane, children: [front, back], mins, maxs, firstFace, faceCount }]`; a child under 0 is leaf `-1 - child` |
| `leaves` | `[{ contents, visOffset, mins, maxs, firstMarkSurface, markSurfaceCount, ambient: [4] }]` |
| `marksurfaces` | `[face]` |
| `clipnodes` | `[{ plane, children: [front, back] }]`; a child under 0 is a contents |

`blueShift` is true for a map laid out as those of Half-Life: Blue Shift, whose header has the entities and the
planes changed over. It is read like any other, and `withEntities` writes into the right place.

Also exported: `CONTENTS`, `HULLS`, `LUXEL` (16), `ENTRY_SIZES` (the bytes of one entry of each lump),
`LUMP_NAMES`, and from `lumps.mjs` `locateLumps(bytes)` (the table alone; a lump outside the file is marked
`inside: false` and not thrown for) and `lumpBytes(bytes, lump)` (a lump's bytes, for what the kit does not
read).

## A map texture (`src/maps/miptex.mjs`)

`{ name, width, height, pixels, palette, mips, holes }`: `pixels` is one palette index a pixel at full size,
`palette` 768 bytes, `mips` the four sizes (`mips[0]` is `pixels`; then a half, a quarter, an eighth), `holes`
whether index 255 is see-through. It is the kit's texture with the smaller sizes added, so `rgbaOf` and `bmp`
of `image.mjs` take it as it is.

| Function | Gives |
| --- | --- |
| `textureRgba(texture, level = 0)` | `{ width, height, rgba }` of one of its sizes; a hole has alpha 0. `png(width, height, rgba)` writes it. |
| `textureKind(name)` | `{ holes, sky, water, animated, frame, random, lit, tool }`, from the name. |
| `mapTexture(source)` | A map texture from `{ name, image }` (an image `{ width, height, rgb }` or `{ width, height, rgba }`, cut down to 256 colours; to 255 and holes for a `{` name) or from `{ name, width, height, pixels, palette }`, kept index for index. Makes the smaller sizes. Throws for a side that is not a multiple of 16 and for a name over 15 letters. |
| `mipsOf(texture, holes?)` | The four sizes, shrunk from the full one: each smaller pixel is the palette's nearest colour to the mean of its block. With holes, a block in which 40% or less is solid is a hole. This is not the games' tool to the pixel: against their own `.wad` files it picks the same index for a third of the pixels and is within about 4 levels in 255 a channel on average. |
| `readMiptex(bytes, at)`, `writeMiptex(texture)`, `miptexHeader(bytes, at)`, `miptexSize(width, height)` | The texture's bytes as a map or a `.wad` keeps them, read and written. |

## Texture files (`src/maps/wad.mjs`)

| Function | Does |
| --- | --- |
| `readWad(bytes)` | `{ textures, others }`: every map texture of a WAD3 file, in its order, and what else it holds (`[{ name, kind }]`: menu pictures, fonts, sprays; not read). The pixels are views of `bytes`. Throws for Quake's WAD2 and for anything else. |
| `textureFromWad(wad, name)` | One texture by name, whatever its case, or `undefined`. `wad`: the file's bytes, or what `readWad` gave. |
| `writeWad(textures)` | A `.wad` file's bytes from `[{ name, image }]` or `[{ name, width, height, pixels, palette }]` (what `mapTexture` takes). A name given twice is refused. |
| `listedWads(value)` | The file names in a worldspawn's `wad` value, as the engine looks for them: lower case, no path, `.wad` put on, the two decal files left out. |
| `wadsFor(bsp, folders)` | `{ found: [{ name, path }], missing: [name] }`: where the map's listed `.wad` files are, in the folders given, in that order (the mod's own, then `valve`). |
| `texturesFor(bsp, folders, { pixels = false })` | `{ wads, textures: [{ name, wad, path, texture? }], missing: [name], unreadable }`: every texture the map wants from outside, in the first listed file that has it. With `pixels`, each brings its `texture`. |

To give a map textures made with the kit: `writeFileSync("mine.wad", writeWad([{ name: "mywall", image }]))`,
name `mine.wad` in the `.map`'s `wad` key, and compile.

## Entities (`src/maps/entities.mjs`)

An entity is a list of pairs, `[["classname", "light"], ["origin", "96 96 104"]]`, in the file's order: a map
may give a key twice, and the game reads both. `bsp.entities[0]` is the worldspawn. The compilers write an
entity's `classname` last.

An entity that was read and not changed is written back as the very text it was read from. So a map whose
entities are read and written with nothing changed is the same file, byte for byte (held on 466 maps of the
games). A changed or new entity is written in the compilers' own form, one pair a line.

| Function | Gives |
| --- | --- |
| `parseEntities(text or bytes)` | The list. What follows the first zero byte is not read. `readBsp` has done this: use `bsp.entities`. |
| `writeEntities(entities)` | The text, with no zero byte after it. |
| `entityLump(entities, terminator = "\0")` | The lump's bytes. |
| `valueOf(entity, key)` | Its value, the first when given twice; `undefined` when not given. |
| `valuesOf(entity, key)` | Every value it gives for the key. |
| `numberOf(entity, key, otherwise?)` | The value as a number. |
| `vectorOf(entity, key)` | `"96 96 40"` as `[96, 96, 40]`, or `null`. |
| `originOf(entity)` | Where a point entity is. For a brush entity: how far it is shifted from where it was compiled, or `null`. |
| `anglesOf(entity)` | `[pitch, yaw, roll]` in degrees, from `angles` or the older `angle` (-1 up, -2 down). |
| `brushModelOf(entity)` | The number of its model (`"*7"`: 7), or `null` for a point entity. |
| `isBrushEntity(entity)` | Whether it is made of brushes: the worldspawn, or one with a `*N` model. |
| `asObject(entity)` | `{ key: value }`, for reading; of a key given twice, the first. |
| `byClass(entities, classname)` | The entities of a class: the whole name, or a RegExp. |
| `byKey(entities, key, value?)` | Those that have the key, or give it that value. |
| `byModel(entities, n)` | Those made of the map's model `n`. |
| `worldspawn(entities)` | The map's own entity. |

Changing. Each returns a **new list** and leaves the one given alone; `which` is an entity of the list or its
number. After a change, take entities from the new list.

| Function | Does |
| --- | --- |
| `setKey(entities, which, key, value)` | Sets a key: the first pair of that key where it stands, or a new pair at the end. `value`: text, a number, or `[x, y, z]`. A quote in a key or a value is refused (the text cannot hold one), and so is a value over 1023 letters. |
| `removeKey(entities, which, key)` | Takes out every pair of that key. |
| `moveEntity(entities, which, [x, y, z])` | Puts a **point** entity elsewhere. A brush entity is refused: `setKey(..., "origin", ...)` shifts one from where it was compiled, with the light it was compiled in. |
| `addEntity(entities, classname, origin, keys?)` | One more point entity at the end. `origin` may be `null`; `keys` an object or a list of pairs. It may be given the `*N` model of a brush entity that is in the map (the same brushes shown twice), not one the map does not have. |
| `removeEntity(entities, which)` | Takes a **point** entity out. A brush entity is refused, with the reason: its model would stay in the file, faces, collision and light, with nothing to show or move it. To hide one, set `rendermode` 2 and `renderamt` 0: it still blocks the way, and that is hiding, not removing. |
| `withEntities(bytes, entities)` | The map with these entities: new bytes. |

**What `withEntities` writes.** Only the entity lump and the two numbers of the header that say where it is and
how long. Text no longer than the old goes in the old one's place, and what is left over of that place is
zeroed. Longer text goes to the end of the file, on a multiple of four bytes, and the old place is zeroed
(unless the entity lump was already the last thing in the file: then it grows where it is). No other lump
moves or changes by a byte. Both engines find lumps by the header alone, so this is safe; the checksum by which
a server tells that a player has the same map leaves the entity lump out in both, so a map with changed
entities still matches the original. Because longer text leaves a zeroed gap behind, start each change from
the original file, as with models, not from your last output.

One thing is refused: a map that carries a block of extra lumps after its own (`BSPX`, written by a few newer
compilers) cannot take longer entity text, because Xash finds that block by where the last lump ends.

A changed map is not a recompiled one. Lights are baked: moving or adding a `light` entity changes nothing that
is seen. Visibility and collision are baked too. What does take effect is everything the game reads at run
time: where things and monsters stand, what they are, their keys, targets and scripts.

## Pictures (`src/maps/draw.mjs`)

A map that reads and checks can still be dark, or have a door in the wrong wall. These draw it, with the kit's
own arithmetic (no browser, no GPU; a 640 x 480 view of a map of 15000 faces takes about a tenth of a second).
Each returns `{ width, height, rgba, facts }`: a picture as `render` gives one of a model
(`png(width, height, rgba)` writes it), and `facts`, what was drawn in numbers and sentences. **Look at the
picture**, and read `facts.notes`.

```js
import { readFileSync, writeFileSync } from "node:fs";
import { maps, png } from "./smak/src/index.mjs";

const bsp = maps.readBsp(readFileSync("gatecity.bsp"));
const game = { folders: ["C:/games/Half-Life/msc", "C:/games/Half-Life/valve"] };   // where its .wad files are
const plan = maps.planOf(bsp, game);                                               // from above: where everything is
writeFileSync("plan.png", png(plan.width, plan.height, plan.rgba));
const view = maps.drawMap(bsp, { ...game, from: [-191, -802, -433], yaw: 90 });     // from inside, as the game lights it
console.log(view.facts.notes, view.facts.missing, view.facts.brightness);
```

| Function | Draws |
| --- | --- |
| `drawMap(bsp, { from, to \| yaw, pitch, fov, width, height, light, brightness, textures, folders, entities, labels, sky })` | A view from a point inside the map, 640 x 480: textured, lit by the map's own lightmaps, `{` textures with their holes, sky a flat colour, liquids of the world letting the bottom show, brush entities where their `origin` puts them. Without `from`: from the first place to start, at eye height, the way it faces. |
| `planOf(bsp, { z, slice, scale, width, height, area, entities, labels, ... })` | The map from straight above, `+y` up the picture and `+x` to its right: floors (their texture's mean colour under the map's light), walls as lines, every point entity a dot in the colour of its kind, every brush entity outlined, a scale bar and a north arrow. With `z`: a cut at that height, what is solid there filled in one colour (a storey's floor plan, doorways open). |
| `viewsOf(bsp, { count, at, width, height, cols, ... })` | Several views in one picture, each named in its corner: from the places to start, and from the middle of the largest rooms looking four ways. An overview in one call. |
| `drawSource(map, { from, to \| yaw, pitch, ... })` | A view of brush source (what `writeMap` takes and `readMap` gives), with no compile: each face one flat colour by its texture's name, shaded by the way it looks, its edges drawn. |
| `planOfSource(map, { z, scale, area, entities, labels })` | The plan of brush source: a cut through its brushes at `z` (the first start's height unless told), entities marked as on `planOf`. |
| `viewFrom(bspOrMap, which)` | `{ from, yaw, pitch, name }` for a view from an entity: its number, or a classname. A place to start is looked from 28 over its origin, a player's eyes. |

**Angles.** `yaw` 0 looks along `+x` (east) and turns anticlockwise seen from above: 90 looks along `+y` (north).
`pitch` over 0 looks up, under 0 down. `to: [x, y, z]` looks at a point instead. `fov` is degrees across (90; a
game at 16:9 shows about 106).

**Where a point is on a plan.** `facts.scale` is pixels a unit, `facts.x0` the world's x at the picture's left
edge and `facts.y0` its y at the top: a point `(x, y)` is at pixel `((x - x0) * scale, (y0 - y) * scale)`.
`facts.marks` lists every entity that was marked with its number, class, kind, origin and pixel (`at`). A map
with more than 60 marks labels only its places to start: `area: { min: [x, y], max: [x, y] }` draws a part of
it closer, `labels: true` labels all that fit.

**Light.** `light: true` (unless told) adds up the light that is always on (style 0) and the game's flickering
styles (1 to 31: torches; a cave city can be lit by nothing else) at their full; `"steady"` is style 0 alone;
`"all"` adds the switched lights (32 and up) as if each were on; `false` draws the textures as they are. A
sample multiplies the texture by `sample / 255 * brightness`, and `brightness` is 1.55 unless told: measured
against the game's own screenshots of one map (Xash in the browser, its defaults), where it came within 10
levels in 255 a channel; a gamma curve fitted worse. `facts.brightness` is the picture's mean (0 to 255),
and a view under 24 carries a note that says it is dark: so is the map there. `brightness: 4` looks into a
dark place; it is then no longer what the game shows. A map with no light data is shaded plainly by the way
each face looks, and `facts.notes` says so.

**Textures.** Those inside the map; then `textures` (map textures by name, `readWad(bytes).textures`); then
the `.wad` files the worldspawn lists, looked for in `folders` (the mod's folder, then `valve`). One found
nowhere is drawn in one flat colour of its own and named in `facts.missing`.

**What is not drawn.** The models and sprites of point entities: one that names a `.mdl` or a `.spr`, or is a
monster or an NPC, is marked in a view by a small box with its number and class (`entities: "all"` marks every
point entity, `false` none), and the kit does not look for the file. Brush entities the game never shows are
left out: triggers, ladders, `zhlt_invisible`, a `rendermode` faded to `renderamt` 0, and faces wearing
`aaatrigger`, `clip`, `null`, `origin`, `hint`, `skip` (a plan outlines triggers too, in a colour of their own).
Also not drawn: decals, the sky's picture (`skyname`), a brush entity's turn (`angles`: a door is drawn
closed), dynamic lights, fog, and anything a script does when the game runs. The pictures are an honest
stand-in, not the game.

## Checking (`src/maps/check.mjs`)

`checkBsp(bytes, { engine = "goldsrc", folders })` gives `{ errors, warnings, facts, counts, resources }`, the
first three lists of sentences as `check` gives for a model. Nothing is thrown for what is wrong with the map:
a file that is cut short, or is not a GoldSrc map, is reported as an error.

- **Errors**: a lump outside the file, or not a whole number of entries ("funny lump size"); a count over what
  the engine holds; a number that names something the map does not have; a face's light past the end of the
  light; a lit face too wide for GoldSrc; a texture whose side is not a multiple of 16; a value too long; an
  entity on a model that is not there; with `folders`, for GoldSrc, a listed `.wad` that is not found.
- **Warnings**: a count over three quarters of a limit; no light or no visibility; textures wanted and not
  found; models that belong to no entity; entities with no classname; the Blue Shift layout.
- **Facts**: the counts, the world's bounds, the light and its styles, the textures inside and those wanted
  from `.wad` files with the files listed, the entities by class, and the models, sprites and sounds the
  entities name (also in `resources`: `{ models, sprites, sounds }`).

`folders`: the game's folders, the mod's own and then `valve`. With them, the `.wad` files and the textures are
looked for; without, the map's wants are only listed.

## Limits

`MAP_LIMITS` holds them; the comment over it in `check.mjs` says where each number is from.

| | GoldSrc | Xash3D FWGS | Why |
| --- | --- | --- | --- |
| planes | 32767 | 131072 | GoldSrc reads a face's plane as a signed 16 bit number |
| nodes | 32767 | 32767 | a node's child is a signed 16 bit number, and under 0 is a leaf |
| clipnodes | 32767 | 32767 | the same, and under 0 is a contents |
| leaves | 32767 | 32768 | GoldSrc's visibility row; the compilers of the SDK stopped at 8192 |
| vertices | 65535 | 65535 | an edge names them with 16 bits |
| faces | 65535 | 65535 | a node names them with 16 bits. GoldSrc reads the faces of a leaf as signed: in the world, in practice 32768 |
| marksurfaces | 65535 | 65535 | a leaf names its first with 16 bits |
| texinfo | 32767 | 65535 | GoldSrc reads a face's as signed |
| edges, surfedges | not bounded | 1048576, 2097152 | |
| models | 512 | 2048 | in GoldSrc the brush models share 512 slots with every `.mdl` and `.spr` the game loads on the map |
| textures | not bounded | 2048 | |
| entities | not checked | 8192 | GoldSrc's own bound is how many the game has alive at once, which the file does not tell |
| entity text | not bounded | 2 MB, and 32 bytes at the least | |
| texture, light, visibility bytes | not bounded | 32 MB, 32 MB, 16 MB | |
| a lit face's width | 512 texture pixels (256 for the software renderer) | not bounded | 33 samples of light a side |
| a texture's sides | multiples of 16 | | |
| a key, a value | 31 letters (the compilers), 1023 (the engine) | the same | |

Valve's SDK lists smaller numbers for some of these (8192 leaves, 400 models, 512 textures, 2 MB of light):
they bound its old compilers, not the engine, and today's maps pass them.

## What is not read

- **BSP30ext and BSPX**: Xash's block of extra lumps after the header (`XASH`) and other tools' after the
  lumps (`BSPX`): coloured or directional light, per-face light scale, clipnodes of 32 bits. `checkBsp` says
  when a map has them; nothing reads them.
- **Quake 1 (29), BSP2, Quake 3 and Source maps**: refused.
- **Decals, sprays, menu pictures and fonts** in `.wad` files: listed in `others`, not decoded.
- **The engine's gamma** over the light, and the brightness of each light style over time: `faceLightmap` gives
  the samples as stored.
- **Traces**: there is no "what does a line from here to there hit", only what is at a point and the floor
  under one.
- **The models' `.mdl`, sprites and sounds** an entity names are listed, not looked for on the disk.
- **Brush entities in the world's answers**: `contentsAt`, `floorUnder` and `leafAt` ask one model at a time.

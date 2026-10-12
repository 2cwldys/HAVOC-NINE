# SMAK: guide for the agent

SMAK (Studio Model Agent Kit) is a set of JavaScript modules for making and changing GoldSrc studio models: the
`.mdl` files Half-Life and its mods use for weapons, players, monsters and props. You, an AI agent, are its user.
There is no editor and no GUI: you write short Node scripts over the library, run them, look at the pictures the kit
draws, and repeat until the model is right. The person you work for sees the result in their game.

This file is the whole briefing. `docs/API.md` lists every function; `docs/ENGINES.md` covers GoldSrc against Xash.

## What it needs

- **Node 18 or later.** Nothing else: no `npm install`, no browser, no compiler, no Blender, no studiomdl.
- **The mod's own model files**, for any work that changes an existing model. They are not in this kit. Ask the
  person where the mod is installed (for example `…/Half-Life/ts/models/`).
- A way for you to look at a PNG. You must look at what you make; see "The loop".

First thing on a new machine, from this folder:

```
node test/selftest.mjs
```

It makes a model from nothing and exercises every part of the kit. If all 21 tests pass, the kit works here.

## What it can and cannot do

| It can | It cannot |
| --- | --- |
| Read everything in a `.mdl`: bones, meshes, textures, animations, events, attachments | Read Source engine models (`.mdl` version 44+), or `.smd` / `.qc` source files |
| Write a whole new model from triangles, with bones and animations | Give a new model hit boxes, attachments or bone controllers |
| Replace a mesh inside an existing model, keeping its skeleton and animations | Weight one vertex to several bones (the format has one bone a vertex) |
| Replace or add textures; recolour by palette; export and import PNG / BMP | Edit animations kept in separate `name01.mdl` files |
| Replace or add animations, and the events (sounds) on their frames | Show the engine's real lighting: its pictures are a plain stand-in |
| Add bones to a model | Run or test anything inside the game |
| Check a model against GoldSrc's and Xash's limits | |
| Draw a model from any side, or as the player sees a weapon, into a PNG | |
| Paint a model by where a point is on its body, across all its textures | Give the two sides of a body different marks where they share the same pixels of a texture |
| Find a model's loose pieces and take them off; move a part between models on one skeleton | Put a body under armour that has none: taking such a piece off leaves a gap |
| Show models side by side in the person's browser, turning and animated | |

When a task needs something in the right-hand column, say so to the person instead of working round it silently.

## The loop

Every task goes the same way. Do not skip the last two steps: a model that parses can still be inside out, tiny,
or held by the wrong end, and only the picture shows it.

1. **Look at what is there.** `node bin/smak.mjs info model.mdl`, then `sheet` or `strip` to see it.
2. **Write a script** in a working folder of your own (not inside this kit) that reads the model, changes it and
   writes the result to a **new** file.
3. **Check it.** `check(mdl, "goldsrc")` in the script, or `node bin/smak.mjs check out.mdl`. Fix every error.
4. **Draw it and look at the PNG.** Compare with the picture from step 1. Iterate on the script.

Always start from the original file, not from your last output: every change appends to the file and leaves the
old data unused inside it, so stacking runs makes it grow. Keep the originals untouched and write elsewhere.

## The command line

```
node bin/smak.mjs info <mdl> [--json]              bones, bodyparts with their body numbers, textures, animations, events
node bin/smak.mjs check <mdl> [--engine xash]      errors and warnings; exit code 1 on an error
node bin/smak.mjs sheet <mdl> -o s.png             six views in one picture
node bin/smak.mjs render <mdl> -o r.png --yaw 30 --pitch 15 [--view first]
node bin/smak.mjs strip <mdl> -o a.png --seq reload --count 12 [--view first]
node bin/smak.mjs textures <mdl> -o dir [--bmp]    every texture as a file
node bin/smak.mjs uv <mdl> -o dir                  every texture with the triangles that wear it drawn over it
node bin/smak.mjs retexture <mdl> <texture> <picture> -o out.mdl
node bin/smak.mjs sequence <mdl> <anim> -o a.json  /  sequence-set  /  sequence-add
node bin/smak.mjs inline <mdl> -o out.mdl          put the textures of <name>t.mdl inside the model
node bin/smak.mjs pieces <mdl>                     its loose pieces, each with its number, place and size
node bin/smak.mjs view <folder|mdl> [more ...]     the viewer, for the person: two models side by side in the browser
```

`view` keeps running until stopped: start it in the background, give the person the address it prints, and stop
it when they are done. It is for them to look and compare; your own checking is still `render`, `sheet` and
`strip`, whose pictures you can read.

`render`, `sheet` and `strip` take `--seq <name|number|rest>`, `--frame`, `--body`, `--skin`, `--width`,
`--height`, `--no-light` (the texture as it is) and `--no-cull` (both sides of every triangle).

**If a picture comes out empty**, the body number shows an empty submodel. Many models keep a blank submodel at
body 0. `info` lists the body number of each submodel; pass it with `--body`.

## How a studio model is put together

You need this model in your head; the API mirrors it exactly.

- **Bones.** A tree. Each has a rest position and rotation relative to its parent. Hand and weapon bones of
  first-person models are usually named `Bip01 R Hand` and the like; check with `info`.
- **Bodyparts → submodels → meshes.** A model has bodyparts (`weapons`, `arms`). Each bodypart holds submodels,
  of which the game shows one, chosen by a **body number**. Each submodel holds meshes, one per texture.
  A file like `v_knife.mdl` may hold several weapons as submodels of one bodypart.
- **Vertices live in the space of one bone.** Each vertex belongs to exactly one bone and is stored relative to
  it. To get a point in model space, multiply by that bone's matrix: `apply34(pose[bone], p)`.
- **Textures** are inside the file: 8 bits a pixel with a 256-colour palette each. Texture coordinates are stored
  in **pixels** of that texture, from its top left.
- **Animations (sequences)** hold, for each frame and each bone, six numbers: position x, y, z from the parent and
  rotation about x, y, z in radians. Events (a sound, a muzzle flash) are fastened to frames.
- **Attachments** are named points on bones: where a muzzle flash or a shell appears.

### Conventions

| | |
| --- | --- |
| Axes | `+x` forward, `+y` left, `+z` up. A model faces `+x`. |
| Units | About an inch. A player is 72 tall; a pistol about 8 long. |
| First-person models | The eye is at the model's origin looking along `+x`. |
| Matrices | 3 rows of 4 (`[[r r r t] ×3]`), taking a bone's space to the model's. `mul34`, `apply34`, `inverse34`. |
| A piece's own axes | `+x` its length (grip or butt at low x, tip at high x), `+y` its width, `+z` its thickness. |
| A triangle (in the kit) | Three corners `{ p: [x, y, z], uv: [u, v] }`, `uv` from 0 to 1 from the picture's top left. |
| An image | `{ width, height, rgb }`, three bytes a pixel. |
| A texture | `{ name, width, height, pixels, palette, flags }`: one palette index a pixel, 768 bytes of palette. |
| Texture flags | 1 flat shaded, 2 chrome, 4 full bright, 32 additive (a glow), 64 masked (palette index 255 is a hole). |
| Which way triangles go | Decided for you by `meshOf` / `buildMdl` / `swapMesh`. `check` reports triangles that face inwards. |

## Rules that keep a model working in the game

1. **Never reorder or remove animations.** Game code plays a weapon's animations by number (`info` lists them in
   order). Replace one where it stands (`replaceSequence`) or add after the last (`addSequence`).
2. **Never renumber submodels, bones or attachments** of a model the game already uses. Everything in this kit
   that adds, adds at the end, so numbers stay. Do not work round that.
3. **Keep an animation's frame count and rate close to the original** when the game times something by it (a
   reload that fills the magazine when the animation ends). If you change its length, tell the person.
4. **Keep to the engine's limits.** Run `check` for `goldsrc` unless told the target is Xash only. The ones you
   will meet: 2048 vertices and 2048 normals a submodel, 128 bones, textures 512 pixels at most and a power of
   two on each side (256x256 or 512x256 are the safe sizes).
5. **Keep texture names unique** inside one file, and end them in `.bmp` as the format expects.
6. **Never write over the mod's original files.** Write to a working folder; the person installs the result.
7. **Do not copy a game's models or textures into this kit** or into anything that is shared: they belong to the
   game's authors.

## Recipes

Each has a runnable example in `examples/`. Read the example first; it is the template.

### A new texture on an existing model (reskin): `examples/03-reskin.mjs`

The least risky change. Three ways, cheapest first:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { textureOf, replaceTexture, textureFrom, check } from "./smak/src/index.mjs";

const src = readFileSync("v_knife.mdl"), old = textureOf(src, "knife.bmp");
// 1. the palette alone: every pixel keeps its place
const dark = replaceTexture(src, "knife.bmp", { ...old, palette: old.palette.map((v) => Math.round(v * 0.6)) });
// 2. a picture painted elsewhere (PNG or BMP, any size): corners are moved to match a new size
const mine = replaceTexture(src, "knife.bmp", { ...textureFrom(readFileSync("painted.png"), old.name), flags: old.flags });
```

Before painting, run `smak uv` to see which part of the picture each part of the shape takes its colour from.
To paint by rule, turn the texture into an image (`rgbOf({ width, height, rgba: rgbaOf(old) })`), change its
`rgb`, and bring it back with `indexed(image, old.name)`. A masked texture (flag 64) goes through `masked` so
that its holes stay holes.

### A new shape in place of an old one: `examples/02-swap-mesh.mjs`

Use this for any weapon or item the game already has a model for. The model keeps its hands, bones, animations,
events and attachments, so the game notices nothing.

```js
import { swapMesh, indexed, shrink, check } from "./smak/src/index.mjs";

const piece = makeMyPiece();                       // { tris, image }: see "Making a shape"
const texture = indexed(shrink(piece.image, 2), "mygun_smak.bmp");
const { mdl, report } = swapMesh(src, { body: 3, piece, texture, size: "own" });
```

- `body`: the number `info` shows beside the submodel to replace.
- `pick`: which of its meshes are the old piece. By default all but those whose texture name contains `hands`,
  `arms` or `body`. If the mod names its hand textures otherwise, pass your own `(mesh) => boolean`.
- `size: "old"` stretches the piece to the old one's length (like for like). `size: "own"` keeps the size you
  drew it at, in units, and holds its low-x end (the grip) where the old one's was.
- `place: "bone"` skips the fitting: the piece's points are already in the space of the bone that carried the
  old one. Use it when the automatic fit turns the piece the wrong way; measure with `measure()` and `frameOf()`.
- `report.left` is how far the new outline is from the old, in units. Large means look closely at the picture.

A weapon usually has two or three models: `v_` (first person), `p_` (in another player's hands) and `w_` (lying
in the world). Do all of them, the world ones with a smaller texture (`shrink(image, 4)`).

### A whole new model: `examples/01-new-model.mjs`

For a prop, a pickup, a thrown thing, something worn. `buildMdl` takes bones, triangles, textures and
animations and returns the file. It writes no hit boxes or attachments, so do not use it for a first-person
weapon the game expects to have a muzzle attachment: swap a mesh in an existing one instead.

### Animations: `examples/04-animate.mjs`

```js
import { readSequence, replaceSequence, addSequence, bones, events, setEvents } from "./smak/src/index.mjs";

const reload = readSequence(src, "reload");        // .frames[frame][bone] = [x, y, z, rx, ry, rz]
const b = bones(src).findIndex((x) => x.name === "Bip01 R Hand");
const frames = reload.frames.map((f, t) => f.map((v, i) => (i === b ? [v[0], v[1], v[2] - 2 * Math.sin(Math.PI * t / (reload.frames.length - 1)), v[3], v[4], v[5]] : v)));
let mdl = replaceSequence(src, "reload", { frames });                       // same place in the list
mdl = addSequence(mdl, { name: "inspect", fps: 30, frames, events: [{ frame: 10, event: 5004, options: "weapons/slide.wav" }] });
```

- A bone's numbers are **relative to its parent**. Moving the hand moves the fingers and whatever it holds.
- Rotations are Euler angles applied about x, then y, then z. Small edits to existing frames are safe; building
  a large rotation from nothing is easier by starting from a frame that already has the bone near where you want.
- To see a pose before writing it: `render(src, { pose: poseOf(src, frame), view: "first" })`.
- `strip` draws an animation frame by frame. Look at it: a wrist bent backwards is obvious in the picture and
  invisible in the numbers.
- Event 5004 plays a sound on the client; 5001 is the first muzzle flash. Read the mod's existing events with
  `info` and follow what it already does.
- A bone that has to move further than the file's scale for it allows is given a wider scale automatically, and
  the model's other animations are rewritten to match (same motion, very slightly coarser for that bone).

### Wear, damage and markings by place: `examples/05-by-place.mjs`

A character has several textures and a wound, a burn or a layer of mud crosses them. `paint` calls your function
for every pixel that some triangle wears, with the point of the body that pixel colours:

```js
import { paint, surface, spot, workshop as W } from "./smak/src/index.mjs";

const pose = { seq: "idle", frame: 0 };                       // measure in a pose the model is usually seen in
const surf = surface(src, pose), hit = spot(surf, [20, 0, 50], [1, 0, 0]);        // the place on its front nearest that point
const { mdl, shared } = paint(src, ({ p, n, rgb, tex }) => {
  const d = Math.hypot(p[0] - hit.p[0], p[1] - hit.p[1], p[2] - hit.p[2]);
  const soot = Math.max(0, W.fbm3(p, 0.3, 7) - 0.6) * 5;      // noise in space: the same on both sides of a seam
  return W.mix(W.mix(rgb, [0.05, 0.05, 0.05], Math.min(1, soot)), [0.02, 0.02, 0.02], d < 0.6 ? 1 : 0);
}, { pose });
```

- `p` is in model space (units; `+z` up), `n` the way the surface faces, `rgb` the colour there now, 0 to 1.
  Return nothing to leave a pixel alone.
- Make stages by building each from the **original** with more in the function, not by painting over the last.
- **Read `shared`.** It gives, for each texture, the share of its pixels that two places of the body both wear.
  Arms, legs and gear are often mirrored like that: a mark on the left shows on the right. Tell the person when a
  one-sided mark they asked for cannot be one-sided. Trousers and torsos are usually not shared.
- Textures keep their size and are cut back to 256 colours each. A masked texture keeps its holes.
- The palette alone (recipe "A new texture") is still the way to change a colour everywhere: a team colour, a
  camouflage. Turn only the colours that are clearly coloured and leave the greys, or the reverse.

### Taking pieces off, and moving parts between models

```js
import { pieces, dropTriangles, graft } from "./smak/src/index.mjs";

const P = pieces(src, pose);                                  // P.list: [{ id, tex, tris, mid, mn, mx }]; `smak pieces` prints it
const { mdl } = dropTriangles(src, (t) => [59, 36].includes(P.of(t)), pose);          // those two pieces off
const helmetOff = graft(dropTriangles(src, (t) => HELMET.includes(P.of(t)), pose).mdl, other, (mesh) => /head/i.test(mesh.texture.name));
```

- A piece is a group of triangles that touch. Tell what each is from its place and size, then **draw the model
  without it before trusting it**: what looks like armour is often the body itself, with no limb under it.
  A gap in the picture means the piece has to stay.
- `dropTriangles` also takes any rule on a triangle's place: `(t) => t.mid[2] > 60`.
- `graft` needs both models on the same skeleton and finds bones **by name**, so the two files may number them
  differently. It throws when a bone is missing. Draw a run or a jump afterwards: a part on the wrong bone shows
  at once in motion.
- A new piece of gear made in the workshop is hung on a model with `addMesh`, `meshOf` and `replaceMesh`: give
  each corner `bone` and `to: inverse34(pose[bone])` so that it follows that bone. One bone a piece: it will not
  bend, so fasten it to the bone that moves least under it (a spine bone for the back, a thigh for a holster).
- None of this touches bones, animations, hit boxes or attachments.

### Making a shape

A shape is a list of triangles and a painted picture. `src/workshop.mjs` gives the two tools:

```js
import { workshop, indexed } from "./smak/src/index.mjs";
const S = workshop.sheet(512, 256);                // the picture being painted
const M = workshop.shape(512, 256);                // the triangles being built

// a turned part: a barrel 10 long, radius 0.6, drawn in a zone of the picture
const BARREL = { x: 8, y: 8, w: 300, h: 60 };
M.lathe([[0, 0.6], [9.5, 0.6], [10, 0.5]], BARREL, { sides: 10, px: 30, caps: [true, true] });
S.zone(BARREL, (u, v) => workshop.iron(u / 12, v / 12, workshop.cylinderLight(v / BARREL.h), 7));

const piece = { tris: M.tris, image: S.image() };
```

- `M.lathe(profile, zone, options)`: a solid of revolution along x (`at` places it anywhere). Barrels, grips,
  handles, scopes, magazines with `sides: 4`.
- `M.plate(stations, zoneA, zoneB, options)`: a flat thing with a section, two faces. Blades, slides, stocks.
- `M.quad` / `M.tri` with `M.V(point, [pixelX, pixelY])`: anything else, corner by corner. The last argument is
  a point inside the solid, so that the face is turned outwards for you.
- `S.zone({ x, y, w, h }, (u, v) => [r, g, b])`: paints that rectangle; colours are 0 to 1.
- Materials: `steel`, `iron`, `wood`, `leatherWrap`, `rust`; noise: `fbm`, `noise`; shading helpers:
  `cylinderLight`, `bell`, `step`, `mix`, `times`, `rivet`.
- **Paint the light into the picture.** The engine lights models softly and flatly; edges, bevels, grooves and
  wear have to be in the texture. Keep painted shadow gentle: the piece is seen from every side.

`kits/` holds four finished builders made this way, each a function from a description to `{ tris, image }`:
`sword` (any blade: knives, katanas, machetes), `axe`, `blunt` (bats, clubs, hammers, batons) and `bow`. Their
headers document every option. For anything else (a firearm, a grenade, a tool), write the piece from `shape`
and `sheet` directly, a part at a time, checking each in a picture; the kits are the worked examples to read.

Budget: a first-person weapon of 300 to 1500 triangles with one 512x256 or 512x512 texture is typical for
GoldSrc; a world model a third of that with a 128 or 256 texture.

## When something is wrong

| What you see | What it is |
| --- | --- |
| `not a studio model, version 10` | A Source model, a sprite, or a `name01.mdl` / `namet.mdl` side file. Open the main file. |
| Meshes have `texture: null`; grey model | The textures are in `<name>t.mdl`. The command line reads them itself; in a script call `withTextures(src, readFileSync("namet.mdl"))` first. |
| `an animation kept in another file` | The model has `name01.mdl` sequence files. Those animations cannot be read or changed. |
| An empty picture | A blank submodel. Use the right `--body`. |
| Holes in the model in the picture | Triangles facing inwards. `check` counts them. If you built corners by hand, your `inside` point is outside. |
| The new piece is back to front or upside down | The automatic fit chose the wrong turn (it happens with symmetric shapes). Use `place: "bone"`. |
| The piece is in the right place and huge or tiny | `size: "old"` against `size: "own"`. |
| `moves further than its scale holds` | Should not happen: `replaceSequence` and `addSequence` widen a bone's scale themselves. Tell the person; it is a fault in the kit. |
| `too long for one animation` | Over 64 KB of values. Fewer frames, or split it in two. |
| Texture looks blurry in the game but not in the picture | Larger than `gl_max_size`, or not a power of two. See `docs/ENGINES.md`. |
| A mark painted on one arm is on both | The two share the same pixels (`paint` reports it as `shared`). It cannot be one-sided without laying that texture out again. |
| A hole where a piece was taken off | It was part of the body, not gear over it. Leave it on. |
| The model shows in the picture and not in the game | Run `check`. If it passes, the game is loading another file: ask where the mod looks first. |

## Reporting to the person

They cannot read the model; you can. When you hand work over, say what file to put where, what you changed in
plain terms, what `check` said, and show them the picture. For several models, or anything that moves, start the
viewer for them (`smak view`) on the originals' folder and yours together. Say plainly what you could not verify: the kit's
pictures are not the game, and timing, lighting and how a weapon sits in the hand while moving only show there.

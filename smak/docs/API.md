# SMAK API

Everything is exported from `src/index.mjs`. A model is a Node `Buffer` holding the whole `.mdl` file. Functions
that change a model return a **new** buffer and leave the one they were given alone. Nothing here touches the
disk: read with `readFileSync`, write with `writeFileSync`.

```js
import { readFileSync, writeFileSync } from "node:fs";
import { readMdl, swapMesh, check, sheet, png, workshop } from "./smak/src/index.mjs";
```

Words used below: `which` is a texture's or an animation's number or its name. `where` is
`{ bodypart, model, mesh }`, three numbers. A matrix is 3 rows of 4 and takes a bone's space to model space.

## Reading a model (`src/mdl.mjs`)

| Function | Gives |
| --- | --- |
| `readMdl(b)` | `{ bones: [name], textures: [{ name, flags, width, height, index }], bodyparts: [{ name, base, models: [{ name, numverts, numnorms, meshes: [{ numtris, skinref, texture }] }] }] }`. Throws unless the file is a studio model, version 10. |
| `readMesh(b, model, mesh)` | The mesh's triangles: `[[{ p, n, bone, s, t } ×3]]`. `p` and `n` are in the space of `bone` (a number); `s`, `t` are pixels of the mesh's texture. `model` and `mesh` are the objects from `readMdl`. |
| `bones(b)` | `[{ name, parent, pos, rot, scale }]` as they rest. |
| `boneParents(b)` | `[parent]`, -1 for a root. |
| `bodyOf(b, body)` | For a body number, the submodel shown of each bodypart: `[index]`. The body number of submodel `k` of a bodypart is `k * base`; add one from each bodypart. |
| `skinFamilies(b)` | `[[texture number for each skinref]]`, one list a family. A model shown with skin `n` wears family `n`. |
| `textureOf(b, which)` | `{ name, flags, width, height, pixels, palette }`, copied out. |
| `sequences(b)` | `[{ name, fps, frames, loops, flags, motion, move, speed, blends, group }]`. `group` is not 0 for an animation kept in another file. |
| `sequenceAt(b, which)` | The animation's number, or -1. |
| `readSequence(b, which, blend = 0)` | What `sequences` tells, plus `index` and `frames[frame][bone] = [x, y, z, rx, ry, rz]`. |
| `frameValues(b, seq, frame, blend = 0)` | One frame of that. |
| `events(b, which)` | `[{ frame, event, type, options }]` of one animation. |
| `attachments(b)` | `[{ name, bone, pos }]`. |
| `hitboxes(b)` | `[{ bone, group, min, max }]`. |
| `drawnCorners(b)` | `[{ name, corners }]` for each submodel: how many corners the engine draws for it. |

## Poses

| Function | Gives |
| --- | --- |
| `restPose(b)` | Every bone's matrix with the bones at rest. |
| `poseAt(b, seq, frame, blend = 0)` | The same at one frame of an animation (`seq` is a number). |
| `poseBetween(b, seq, at, loop = true)` | At a moment between two frames (`at` may be fractional). |
| `poseOf(b, values)` | For a frame given as numbers (`[bone][6]`), not yet in the file. |
| `boneMatrices(list, values?)` | The same for a list of bones `[{ parent, pos, rot }]` that is not in a file. |
| `mul34(a, b)`, `apply34(m, p)`, `inverse34(m)` | Matrix times matrix, matrix times point, inverse of a rigid matrix. |

A point of a mesh in model space, in some pose: `apply34(pose[corner.bone], corner.p)`.

## Changing meshes

| Function | Does |
| --- | --- |
| `replaceMesh(src, where, mesh, texture)` | Replaces one mesh. `mesh`: `{ bone, verts, norms, tris: [[[vert, norm, s, t] ×3]], vertBones?, normBones? }` (what `meshOf` returns). `texture` is added to the file unless one of that name is there. |
| `addMesh(src, { bodypart, model })` | One more mesh in a submodel, empty; `replaceMesh` fills it. For a part that needs a texture of its own. |
| `addModel(src, bodypart, name)` | One more submodel in a bodypart, with one empty mesh. Its number is the old count. |
| `emptyMesh(src, where)` | Leaves a mesh without triangles. |
| `filterMesh(src, where, keep)` | Keeps the triangles for which `keep([bone, bone, bone])` is true. |
| `addBones(src, [{ name, parent, pos, rot }])` | More bones after the ones it has, at rest in every animation. Old bones keep their numbers. |

## Changing textures

| Function | Does |
| --- | --- |
| `replaceTexture(src, which, texture)` | Another picture on an existing texture: `{ width, height, pixels, palette, name?, flags? }`. Of the same size it is written in place; of another size, the corners that wear it are moved to match. |
| `retexture(src, where, texture, uvOf?)` | Gives **one mesh** a new texture (added to the file); the others that wore the old one keep it. `uvOf(triangle, corner)` returns `[u, v]` (0 to 1) to lay it out again. |
| `withTextures(src, tfile)` | For a model whose textures are in `<name>t.mdl`: a copy with them inside. |

## Changing animations

| Function | Does |
| --- | --- |
| `replaceSequence(src, which, { frames, blends, fps, loops })` | Other frames for an animation, in the place it had. What is not given stays (its events too). `frames[frame][bone][6]`; every frame lists every bone. |
| `addSequence(src, { name, fps = 30, loops = false, frames, activity = 0, events, like = 0 })` | A new animation after the others. Its bounding box is copied from animation `like`. |
| `setEvents(src, which, [{ frame, event, options, type }])` | Replaces an animation's events. |

A bone whose new motion goes beyond what the file's 16-bit scale for it can hold gets a wider scale, and every
animation of the file is written again by it. Animations kept in other files (`group` not 0) make that fail.

## Whole models

`writeMdl({ name, bones, sequences, textures, skins, bodyparts })` writes a file from tables that are already in
the format's own terms (points in bone space, normals indexed per mesh). Prefer `buildMdl`, which takes triangles.

`buildMdl({ name, bones, bodyparts, sequences, smooth = 40 })` (`src/build.mjs`):

```js
buildMdl({
  name: "crate.mdl",
  bones: [{ name: "crate", parent: -1 }, { name: "lid", parent: 0, pos: [-12, 0, 18] }],
  bodyparts: [{ name: "body", models: [{ name: "crate", meshes: [{ tris, texture }] }] }],
  sequences: [{ name: "idle", fps: 10, loops: true, frames: [ /* [bone][6] */ ] }],
});
```

- `tris`: `[[{ p, uv, bone } ×3]]`. `p` in model space with the bones at rest; `uv` 0 to 1; `bone` a name or a
  number (the first bone when left out).
- Meshes that give a texture of the same name share it.
- With no `bones`: one, called `root`. With no `sequences`: one, `idle`, holding the rest pose.
- No hit boxes, attachments, bone controllers or events.

## Putting a piece into a model (`src/build.mjs`, `src/fit.mjs`, `src/mesh.mjs`)

`swapMesh(src, { body, pick, piece, texture, place = "fit", size = "old", name })` → `{ mdl, report }`

| Option | Meaning |
| --- | --- |
| `body` | The body number that shows the submodel (of the first bodypart). |
| `pick(mesh)` | True for the meshes that are the old piece. Default: all whose texture name does not match `HANDS` (`/hands|arms|body/i`). |
| `piece` | `{ tris, haft?, rig?, bones? }`. `haft: true`: it is laid along the old one's handle. `rig: "nearest"`: each corner takes the bone of the old piece's nearest corner. `bones: [, "name"]`: corners with `part: n` go to that bone. |
| `texture` | The piece's texture. |
| `place` | `"fit"`: laid over the old piece's outline. `"bone"`: its points are already in the carrying bone's space. |
| `size` | `"old"`: stretched to the old length. `"own"`: keeps its drawn size, its low-x end held where the old one's was. |

`report`: `{ model, bone, bones, was, now, verts, scale, turn, left, boxOff, textures }`.

The parts it is made of, for when you need them separately:

| Function | Gives |
| --- | --- |
| `measure(src, body, pick, what)` | `{ info, j, model, meshes, rest, bone, original }`: the picked meshes, the bone that carries most of them, and their triangles in that bone's space. |
| `frameOf(tris)` | A frame `{ X, Y, Z, o }`: the piece's own axes (principal axes by area) and its middle. |
| `bestTurn(pieceTris, originalInItsAxes, haft)` | `{ k, name, left, at(p) }`: the scale, which of four turns fits best, what is left over, and the function that places a point. |
| `shieldFit(original)` | For a thing with straps on its back: its frame and measures. |
| `into(frame, p)`, `out(frame, p)` | A point into a frame's axes and back. |
| `meshOf(original, tris, texture, bone, smooth = 40)` | Triangles as `replaceMesh` takes them: shared points, smoothed normals, winding as the original's (pass `null` for the format's usual). A corner may carry `bone` and `to` (the matrix taking `p` into that bone's space). |
| `FRONT` | -1: the sign of `(b - a) × (c - a)` against the outward normal in a compiled model. |

## Working by place (`src/place.mjs`)

`pose` below is what `posed` takes: `{ seq, frame, body, skin }`. Points are in model space as the model stands in it.

| Function | Gives |
| --- | --- |
| `surface(src, pose)` | `[{ p, n, tex }]`, one a triangle: its middle, the way it faces, its texture's name. |
| `spot(surface, near, facing?, on?)` | The place of the surface nearest `near` that looks towards `facing` and wears one of the textures `on`; or null. |
| `paint(src, fn, { pose, only, islands, soft = 1, apart = 3 })` | `{ mdl, shared }`. `fn(place)` returns the new colour (0 to 1) of the pixel that colours the point `place.p`, or nothing to leave it. `only`: texture names; `islands`: island ids (see `uvIslands`); `soft`: see below. `shared[name]`: the share of that texture's painted pixels worn by two places more than `apart` units from each other. A list in place of `fn` paints several passes: see below. |
| `uvIslands(src, pose)` | `{ list, of(t) }`: the islands of the model's pictures, each the triangles of one texture joined through the edges they share in it. `list[id]`: `{ id, tex, tris, box: [x0, y0, x1, y1], uses: [{ bodypart, model, mesh, body, part, name, tris }], bones: [names], mn, mx, mid, n, border, open }`. `of(t)`: the id for anything with `where` and `tri` (a triangle of `posed`, what `dropTriangles` and `paint` hand over). |
| `islandMap(src, which, { scale, body })` | A picture, as `uvMap`: the texture greyed, each island tinted and numbered, open borders white and seams in the island's colour. Also returns `scale`, `texture`, `islands` (the ids drawn). `body`: only what that body number's submodels use. |
| `pieces(src, pose)` | `{ list: [{ id, tex, part, model, where, tris, mn, mx, mid }], of(t) }`: the groups of triangles that touch, mesh by mesh, of every submodel. `of` takes what `dropTriangles` hands its rule. |
| `dropTriangles(src, drop, pose)` | `{ mdl, gone }`: without the triangles `drop({ p, mid, tex, part, model, where, tri })` accepts. |
| `graft(to, from, pick, where = { bodypart: 0, model: 0 }, move?)` | `to` with the meshes of `from` that `pick(mesh, model, bodypart)` accepts added to the submodel `where`, their textures with them. Bones are matched by name. |
| `copyBody(src, body, name, texture, { instead, bodypart = 0 })` | The model with one body again as a new submodel called `name`, after the others of its bodypart, wearing `texture`: the same points on the same bones. `body`: a submodel's name, or a body number (of `bodypart`). `texture`: the name of one in the file, a texture, or an image with a `name` (cut to 256 colours; of another size, the corners follow). `instead`: which of the old body's textures it takes the place of, when the body wears several. The new body's number is the bodypart's old count of submodels times its `base`. |

What `paint` hands its function, one object a call:

| Field | |
| --- | --- |
| `p`, `n` | The point of the body the pixel colours, in model space as the model stands in `pose`, and the way the surface faces there. |
| `rgb` | The colour there now, 0 to 1. In a later pass: as the passes before left it. |
| `tex`, `u`, `v` | The texture's name and the place in it, in pixels from its top left: the middle of the pixel (`x + 0.5`), or with `soft` the point inside it that is asked about. Not wrapped: a corner laid outside the picture gives a `u` outside it. |
| `bone`, `boneIndex` | The bone the point follows, by name and by number: that of the nearest of the triangle's corners. |
| `where`, `body`, `tri` | Its mesh `{ bodypart, model, mesh }`, the body number that shows that submodel, and the triangle's number in the mesh (the order of `readMesh`). |
| `island` | The id of the island of the picture the triangle is in (`uvIslands`). |
| `edge` | How far the pixel is from its island's border, in pixels: 0 on it, growing inwards. The border is that of the island within the triangle's own mesh. |
| `open` | The same to the nearest *open* stretch of the border: an edge that no triangle of the submodel goes on across in space (a hem, an armhole). The rest of a border is seams, where the surface goes on in another island or on the far side of this one. `Infinity` when the island has no open border. |
| `per` | Units of the model that a pixel covers in this triangle: `edge * per` and `open * per` are those distances in units, near enough (the scale is this triangle's, not that of every triangle on the way). |
| `at(u, v)` | The colour (0 to 1) of this texture at another pixel, as it stood before this pass. |
| `blur(r)` | That picture smoothed about this pixel with a bell `r` pixels wide each way, over the pixels this island lies on (those of the pass's triangles) and no others. A hole of a masked texture is left out. |

`edge`, `open`, `at` and `blur` cost nothing unless the function reads them.

`soft: n` (2, 3, 4...) asks the function at `n` by `n` points inside each pixel, each with its own `p`, `n`, `u`,
`v`, `edge` and `open`, and writes the average; a point for which it returns nothing counts with the colour the
pixel had. So the edge of any shape comes out soft instead of as a staircase. It multiplies the calls by `n * n`.

Several passes: `paint(src, [pass, pass, ...], options)`. A pass is a function, or `{ fn, only, islands, pose,
soft, apart }`: what it leaves out is taken from `options`. Every pass sees the picture as the one before left
it, in full colour (8 bits a channel), in `rgb`, `at` and `blur`; each texture is cut to 256 colours once, after
the last. Painting in two calls instead cuts twice, and the second call sees no more than 256 colours.

```js
const ids = uvIslands(src, pose).list.filter((e) => e.tex === "coat.bmp" && e.n[0] > 0.5).map((e) => e.id);
const { mdl } = paint(src, [({ blur }) => blur(4), { soft: 3, fn: ({ p, rgb, edge }) => (edge < 2 ? [0, 0, 0] : p[2] > 50 ? [0.6, 0.1, 0.1] : rgb) }], { pose, islands: ids });
```

Islands are numbered through the whole model, texture after texture, in the order their first triangle comes in
the file, and by the textures of the first skin family. Two submodels that lay the same triangles on a picture
share an island (`uses` lists both); `mn`, `mx`, `mid` and `n` are taken over all of them. `border` and `open`
are lengths in pixels. The command line draws them: `smak islands <mdl> [-o dir] [--texture t] [--body n]`.

`copyBody`, like `addModel`, adds to one bodypart's count of submodels. The body numbers of the bodyparts after it
are counted from that, so in a model of several bodyparts add to the last one only.

## Pictures and files (`src/image.mjs`)

| Function | Gives |
| --- | --- |
| `indexed(image, name, most = 256)` | An image cut down to a texture (median cut). |
| `masked({ width, height, rgba }, name)` | A texture with holes where alpha is under 128: 255 colours, index 255 the hole, `flags: 64`. |
| `shrink(image, k)` | The image `k` times smaller each way, averaged. |
| `textureFrom(fileBuffer, name, { holes })` | A PNG or BMP file as a texture. An 8-bit BMP keeps its palette exactly. |
| `rgbaOf(texture, masked = false)` | A texture as RGBA bytes. |
| `rgbOf({ width, height, rgba })` | RGBA as an image. |
| `png(width, height, rgba)` | A PNG file (a Buffer). |
| `unpng(buffer)` | `{ width, height, rgba }`. 8 bits a channel, not interlaced. |
| `bmp(texture)` | An 8-bit BMP file with the texture's palette as it is. |
| `unbmp(buffer)` | 8-bit: a texture without a name; 24 or 32-bit: an image. |

## Drawing (`src/render.mjs`)

All return `{ width, height, rgba }`; write with `png(img.width, img.height, img.rgba)`.

| Function | Draws |
| --- | --- |
| `render(src, options)` | One view. |
| `sheet(src, options)` | Six views: front, left side, back, right side, top, three quarter. `size` (384) is each one's side. |
| `strip(src, { seq, count = 12, cols = 4, from, to, ... })` | An animation, `count` frames from first to last, each numbered. |
| `uvMap(src, which, { scale })` | A texture enlarged with the triangles that wear it drawn over it. Also returns `scale`, `meshes`, `triangles`. |
| `tile(images, cols, names)` | Pictures of one size side by side, named. For before and after. |
| `lineup([[name, model], ...], { yaws = [20, 200], pitch, zoom, width, height, cols, target, seq, frame })` | Several models to one scale, each from the same sides. |
| `label(img, text, x, y)` | Writes on a picture. |
| `posed(src, options)` | No picture: the triangles in model space as shown, `{ info, tris, pose }`. A triangle: `{ tex, where, tri, c: [{ p, n, u, v, bone } ×3] }` (`where`: its mesh; `tri`: its number in it; `u`, `v` in pixels; `bone` a number). |
| `framing(src, [options])` | `{ mid, far }` over several poses, for `within`. |

Options of `render` (and the others pass them on):

| Option | Default | |
| --- | --- | --- |
| `view` | `"orbit"` | `"orbit"`: from outside, no perspective. `"first"`: the eye at the origin looking along +x. |
| `yaw`, `pitch` | 30, 15 | Degrees. Yaw 0 looks at the front, 90 at the left side, 180 at the back. Pitch 90 looks down. |
| `zoom`, `target`, `within` | 1 | Closer or farther; the point looked at; a shared framing. |
| `fov` | 90 | First person: degrees across. |
| `seq`, `frame` | 0, 0 | The animation (a name, a number, `null` for the rest pose) and the frame. The rest pose may be turned from the animated one (a quarter turn in some models): yaw 0 is the front of the model as it is animated. |
| `pose` | | Matrices of your own instead (from `poseOf`). |
| `body`, `skin` | 0, 0 | Which submodels and which skin family. |
| `width`, `height` | 512² (640×480 first person) | |
| `light` | true | False: textures at full brightness. |
| `cull` | true | False: both sides of every triangle. |
| `background` | `[58, 62, 70]` | |

`TEXTURE` names the texture flags: `{ flat: 1, chrome: 2, fullbright: 4, additive: 32, masked: 64 }`.

## Checking (`src/check.mjs`)

`check(src, engine = "goldsrc")` → `{ errors, warnings, facts }`, lists of sentences. `engine` is `"goldsrc"`
or `"xash"`. `LIMITS` holds the numbers. An error is something that crashes the engine or cannot be drawn; a
warning is something it will put up with. See `docs/ENGINES.md`.

`engineLayout(src)` → the same model with its textures at the file's end in their table's order, as a dedicated
server reads them (`src/layout.mjs`); `isEngineLayout(src)` says whether it is so already. The functions that
change a model call it themselves: use it on files that came from elsewhere.

## The viewer (`viewer/serve.mjs`)

`view(roots, port = 8098)` starts it over folders or single files and resolves to the Node server (`.close()` stops
it). From the command line: `smak view <folder|mdl> ... [--port n]`. It listens on this machine only.

## Vectors (`src/vec.mjs`)

`sub`, `dot`, `cross`, `unit`, `box(points)` → `{ mn, mx }`, `uniq(tris)` (distinct points), `mainAxes(samples)`
(principal axes of weighted points `[x, y, z, weight]`), `into`, `out`.

## The workshop (`src/workshop.mjs`, exported as `workshop`)

| | |
| --- | --- |
| `sheet(width, height, ground?)` | A picture to paint: `.zone({ x, y, w, h }, (u, v) => [r, g, b], bleed = 4)`, `.image()`. `u`, `v` are pixels inside the zone; colours 0 to 1. |
| `shape(width, height)` | A mesh to build: `.V(p, [px, py], part?)`, `.tri(a, b, c, inside)`, `.quad(a, b, c, d, inside)`, `.lathe(profile, zone, options)`, `.plate(stations, zoneA, zoneB, options)`, `.tris`. |
| `lathe` options | `sides = 10`, `flatten = 1` (squash in z), `px = 48` (pixels a unit along it), `at(s, a, b)` (placing; along x unless told), `caps: [start, end]` (`true` or a zone), `twist`, `part`. `profile`: `[[s, radius], ...]`. Returns its length. |
| `plate` options | `px`, `s0`, `at(s, t, g)`, `part`. `stations`: `[{ s, pts: [[t, g], ...] }]`, `g` the half thickness. Zones are `{ x, yc }`. |
| Noise | `rand(x, y, seed)`, `noise`, `fbm(x, y, seed, octaves)`, all 0 to 1. `fbm3(p, lumps a unit, seed, octaves)`: the same in space, for `paint`. `seeded(n)`: a random number maker that repeats. |
| Blending | `step(a, b, x)`, `mix(c1, c2, t)`, `times(c, k)`, `bell(d, width)`, `smooth(t)`. |
| Materials | `steel(x, y, light, seed, rust)`, `iron(a, b, light, seed, rust)`, `wood(x, y, light, seed, tone)`, `leatherWrap(u, v, seed, base)`, `rust(x, y, seed)`. |
| Shading | `cylinderLight(v, strength)`, `rivet(x, y, cx, cy, radius)`, `polyDist(x, y, polygon)`. |

## The kits (`kits/`)

Each takes a description and returns `{ tris, image }`. Their file headers list every option.

| Import | Makes |
| --- | --- |
| `sword(spec)`, `taper`, `METALS`, `carved` from `kits/swordkit.mjs` | Any blade with a grip: pommel, grip, guard, blade (`section: "diamond" | "single" | "fuller"`, `curve`). Texture 1024x256. |
| `axe(spec)`, `crescent`, `flared`, `wrap`, `bolts` from `kits/axekit.mjs` | A haft with one or more bits. `haft: true`. Texture 1024x512. |
| `blunt(spec)`, `toward` from `kits/bluntkit.mjs` | A haft with turned parts on it: clubs, bats, hammers, maces. `haft: true`. |
| `bow(spec)`, `through` from `kits/bowkit.mjs` | A bent stave and its string. `rig: "nearest"`. Texture 1024x256. |

The kits paint large. Bring a picture down with `shrink(image, 2)` or `4` before `indexed` for GoldSrc.

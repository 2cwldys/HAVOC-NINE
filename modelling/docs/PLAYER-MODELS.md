# New player models on The Specialists' skeleton

SMAK's own docs and examples are about weapons and props. Player models are different in
one way that decides everything else, so this file covers that and nothing it already
says well. Read `smak/AGENTS.md` first; it is the contract, and the loop it mandates
applies here unchanged.

## You cannot build a player model from scratch

`buildMdl` says so itself:

> It has no hit boxes, attachments or events: enough for a thing that is carried, worn,
> dropped or stood somewhere.

And there is no way to add them afterwards. `attachments()` and `hitboxes()` are
read-only projections; `writeMdl` writes an empty table into those header slots. SMAK has
no writer for either, nor for bone controllers.

For a player model that means:

- **no hitboxes** -- the player cannot be shot, anywhere
- **no attachments** -- nothing to hang a weapon, a muzzle flash or a tracer origin off
- **no events** -- no footsteps, no reload sounds

So a from-scratch `.mdl` is not a player model. It is a prop shaped like one.

## What to do instead: keep a donor's skeleton

Take an original, keep everything that is bookkeeping, replace only the geometry and the
textures. The thirteen TS player models all carry:

| | |
|---|---|
| bones | 22, Italian names, in one of two orders |
| sequences | 171, index 0 is `empty`, index 1 is `standard_idle` |
| hitboxes | 20 |
| attachments | 4 -- three on `Bip01 DX Mano`, one on `Bip01 SX Mano` |
| bodyparts | **varies** -- see below |

**What does not hold constant is the bodyparts, or the bone order.** Two real models,
read with `node modelling/inspect.mjs <name>`:

```
XCCPsgts   bodyparts  body(1) body(1)                        Testa -> bone 21
            7 textures, 552x474 and the like

repuheavy  bodyparts  body(1) xccpbody(1) glasses_Ref(1)     Testa -> bone 13
            27 textures, most of them 64x64 and smaller
```

So `bodypart: 1` is `stuff` on one and `xccpbody` on the other, and a bone index that is
right for one is wrong for the other. **Inspect the donor before writing anything**, and
resolve both bones and bodyparts by name. `hang()` below hard-codes `bodypart: 1`
because the trial only ever targeted `XCCPsgts`; on another donor, look it up.

Every one of those survives a mesh replacement, because **every SMAK edit appends**: new
data goes at the end of the file and the existing tables are pointed at it. Nothing is
renumbered, which is what `AGENTS.md` rules 1 and 2 are protecting.

`XCCPsgts` is the donor to start from. It is the one the trial scripts target by
default, the one whose parts are mapped in `ts-trial/00_originals_seen/parts_XCCPsgts.png`,
and the one whose loose pieces are already catalogued.

### Choosing a donor by what you need to replace

Run this before anything else:

```
node smak/bin/smak.mjs info ts-trial/originals/XCCPsgts/XCCPsgts.mdl
```

It prints bones, bodyparts with their **body numbers**, textures with sizes, all 171
sequences in order with their events, the attachments and the hitbox count. Then look at
the model:

```
node smak/bin/smak.mjs sheet ts-trial/originals/XCCPsgts/XCCPsgts.mdl -o out/sgts.png
```

The trial already learnt the thing that decides how much you can replace:

> **Much of the body is not under the armour.** On `XCCPsgts` the right forearm, the knee
> pads, the shins and the helmet are the body itself: take one off and there is a gap.
> The pack, pouches, canisters and neck guard come off cleanly.

So gear is replaceable; body is not, unless you supply a replacement for it in the same
edit.

## The pose everything is measured in

```js
export const POSE = { seq: 1, frame: 0 };
```

Sequence 0 is `empty`. Measuring in it gives you a collapsed skeleton and nonsense
coordinates. **Always measure in sequence 1.** Every trial script does, through
`lib.mjs`.

```js
const P = K.poseAt(base, 1, 0);          // one 3x4 matrix per bone, in model space
```

## Bone names

`Bip01` is the root. Every other bone is `Bip01 ` plus an Italian name, so the trial
scripts all do this:

```js
const names = K.bones(base).map((b) => b.name);
const bone = (n) => names.indexOf(`Bip01 ${n}`);
```

The ones you will reach for:

| Name | Where |
|---|---|
| `Bacino` | pelvis |
| `Dorso`, `Dorso1`, `Dorso2`, `Dorso3` | spine, lowest to highest |
| `Collo` | neck |
| `Testa` | head |
| `SX Coscia`, `DX Coscia` | left / right thigh |
| `SX Mano`, `DX Mano` | left / right hand (the attachment bones) |

`SX` is left, `DX` is right. **The thirteen models share this skeleton but in two
different orders**, so never hard-code a bone index -- look it up by name every time.
That is also why a part moves between models by bone name with nothing else to fit.

## Fastening new geometry to a bone

This is the whole idiom, from `ts-trial/scripts/05_gear.mjs`:

```js
function hang(mdl, tris, boneName) {
  const b = bone(boneName);
  const to = K.inverse34(P[b]);                  // model space -> this bone's space
  const where = { bodypart: 1, model: 0 };       // the "stuff" bodypart
  const mesh = K.readMdl(mdl).bodyparts[1].models[0].meshes.length;   // append
  return K.replaceMesh(
    K.addMesh(mdl, where),
    { ...where, mesh },
    K.meshOf(null, tris.map((t) => t.map((c) => ({ ...c, bone: b, to }))), texture, b, 50),
    texture,
  );
}
```

Four things are load-bearing:

1. **`to = K.inverse34(P[b])`** -- your triangles are in model space; the format stores
   them in bone space. Passing `to` on each corner lets `meshOf` do the transform.
2. **`bodypart: 1`** -- the `stuff` bodypart. Putting gear there keeps it away from the
   body mesh.
3. **`mesh` is the current count** -- so `addMesh` then `replaceMesh` appends rather than
   overwriting an existing mesh.
4. **One bone per mesh.** The format allows one bone per *vertex* and SMAK sets them all
   to `b`. A shield on `Dorso2` follows the back; it does not deform. The trial is honest
   about the consequence: *"The shield and baton are each fastened to one bone. They
   follow a run in the pictures; a dive or a kick may push them through the body."*

### Probing the model for where to put it

Do not guess coordinates. Measure them off the posed surface:

```js
const surf = K.surface(base, POSE);          // [{ p: [x,y,z], tex, ... }]

// how far back the vest reaches, between z 6 and 24, near the centre line
const backAt = Math.min(...surf
  .filter((s) => Math.abs(s.p[1]) < 5 && s.p[2] > 6 && s.p[2] < 24)
  .map((s) => s.p[0]));

// how far out the left hip is, on the trousers texture
const hipOut = Math.max(...surf
  .filter((s) => s.tex === "07.bmp" && s.p[2] > -9 && s.p[2] < 0 && Math.abs(s.p[0]) < 3 && s.p[1] > 0)
  .map((s) => s.p[1]));
```

Axes, on the XCCP family: **+x is behind him, +y is to his left, +z is up.**

**Check the facing per donor.** It is not a property of the skeleton. `merc` faces the
other way -- **+x is his front** -- which was proved by painting the sign of `n[0]`
onto the body and looking at it, after a mask built on the assumption landed on the
back of his head. One render settles it; reasoning about it does not.

### Measuring something to wrap around him

A belt, a harness or a bandolier needs the body's cross-section, not a radius. `merc`'s
waist is a low-poly octagon centred at x 2.34 rather than on the model axis, 4.8 deep at
the back and 6.1 across the sides. `modelling/waist.mjs` measures one: it takes the
furthest vertex within a +/-35 degree window of each of 16 spokes, which is needed
because the whole body is 592 vertices and a band of z holds about a dozen, so fixed
buckets come back mostly empty.

Two things about that measurement will bite:

1. **Evening out the spokes must never pull one in.** Averaging each spoke with its
   neighbours shaves the peaks -- a measured 6.1 at the back quarters comes out 5.7 --
   and a strap built on that is a tenth of a unit inside the shirt all the way round
   the back, which is invisible in a preview and plain in game. Smooth with
   `Math.max(measured, averaged)` so it fills dips and never cuts clearance.
2. **Below the waist the body stops being one mass.** At z -3 the two thighs reach 8.3
   out against the waist's 6.1, so anything long enough to hang past the hip has to be
   checked against the vertices actually near it rather than against the ring.

**Check the clearance in the build, not in the render.** `make-medic-belt.mjs` measures
every body vertex the strap passes against the strap's own polygon -- its chords, not
the circle through its corners, since a 24-sided ring dips inward between them by about
the same amount as the error being hunted -- and throws if anything is inside it. A
preview of three yaws does not show the back, which is where this went wrong.

### A hanging tool wants a tall zone

Texture zones are not interchangeable. A **lathe** runs its profile along the zone's
width and its turn down the height, so it always wants a wide zone. A **slab** maps the
zone across and down the face, so a tool that hangs -- a blade, a saw, a scalpel --
wants a tall one. Giving a six-unit saw a 150x34 strip stretches 34 pixels over its
length and smears its teeth into streaks.

Mind the vertical sense too. On a box built from corner sign triples, corners 0 and 1
are the BOTTOM pair, so their `v` belongs at the bottom of the zone. Getting it the
other way up flips every hanging tool, which is unnoticeable on a strap and obvious on
a saw: the teeth come out along the spine.

## Appended geometry needs the textures moved back to the end

**A model with a new mesh on it draws as NOTHING unless its texture data ends the file.**

This is the single worst failure in the kit, because every check says the model is fine:
`check` passes with zero errors, the header length matches the file size, every bone
index, skin index and vertex index is in range, SMAK's own renderer draws the model
correctly in a preview PNG -- and in GoldSrc the player is invisible. Not
untextured, not misplaced. Absent.

The cause is a collision between two habits. **Every edit SMAK makes is an append**: it
writes new data at the end of the file and repoints an offset at it, never moving what
is already there. And **studiomdl always writes the texture block last**: all seven TS
player models measured have their final texture ending at exactly EOF, with not one byte
after it. The engine relies on that -- it treats everything from `texturedataindex` to
the end of the file as texture data. Append a mesh and the geometry lands *past* the
textures, inside the region the engine has already claimed, and nothing draws.

So after the last mesh or texture change, and before writing the file:

```js
import { texturesLast } from "./lib.mjs";

const out = texturesLast(K.replaceMesh(K.addMesh(base, where), ...));
writeFileSync(path, checked("name", out));
```

`texturesLast` copies each texture's pixels and palette to the end of the file and
repoints the texture table at the copies. The originals stay behind as dead bytes, which
costs file size and nothing else -- SMAK already leaves orphaned data on every edit. It
is a no-op on a model whose textures are already last, so it is safe to call always, and
calling it always is the right habit.

To confirm it worked, compare the end of the texture block against the file size:

```js
const b = readFileSync(path), i32 = (o) => b.readInt32LE(o);
const nt = i32(180), ti = i32(184);
let hi = 0;
for (let i = 0; i < nt; i++) {
  const o = ti + i * 80;
  hi = Math.max(hi, i32(o + 76) + i32(o + 68) * i32(o + 72) + 768);
}
console.log(hi === b.length ? "textures are last" : `${b.length - hi} bytes after the textures`);
```

This is the territory SMAK's own `docs/ENGINES.md` flags, where by-place and by-mesh
operations are recorded as *"read back, checked and drawn ... not yet loaded by any
engine."* They are drawn correctly by SMAK. Drawing them in the engine is this.

A model with its textures in a separate `<name>t.mdl` does not have the problem, because
its geometry file has no texture block to be displaced. `texturesLast` returns it
untouched.

## The limit you will actually hit

`check` enforces GoldSrc's **2048 vertices and 2048 normals per submodel**. The donor is
already most of the way there -- `XCCPsgts` is 1734 points in `body` and 992 in `stuff`.
`graft`'s own docstring warns about it. So:

- add gear to bodypart 1 (`stuff`), which has the room
- run `check` after every addition, not at the end
- if you are over, decimate your shape rather than hoping

```js
const r = K.check(mdl, "goldsrc");
if (r.errors.length) throw new Error(r.errors.join("\n"));
```

Copy `checked()` out of `ts-trial/scripts/lib.mjs` and use it on every save. Textures
over 512 on a side raise a *warning*, not an error -- the originals already do that, and
keeping each texture's original size is correct.

## Do not trust the internal name field

The studio header carries a 64-byte name at offset 8. On the real TS models it is
garbage:

```
XCCPsgts.mdl              internal = "C:\Documents and Settings\Administrator\Desktop\Xccpsoldier\Xccp"
RepuHeavyM.mdl            internal = "RepuHeavy.mdl"        (a different model)
scda_Spy02.mdl            internal = "merc.mdl"             (unrelated)
XCCPmutant.mdl            internal = "XCCPsoldierzomb.mdl"  (unrelated)
```

Five of the thirteen are saturated at the full 64 bytes with a truncated build path. The
engine loads player models by **file path** -- `models/player/<name>/<name>.mdl` -- so
this has never mattered. Two consequences: never use the internal name as an identity
key, and do not try to "fix" it, because SMAK has no API to rewrite it on an existing
model (only `buildMdl`/`writeMdl` take a `name`, and those are for new files).

## Installing and the one test that counts

```
ts/models/player/<name>/<name>.mdl
```

Copy your variant over that path under **the original's name**, keeping a copy of the
original. The directory and file must share the name.

Nothing SMAK has produced has ever been loaded by The Specialists. `check` passing, the
render looking right and the viewer playing all 171 animations are all necessary and
none of them is sufficient. Put it in the game.

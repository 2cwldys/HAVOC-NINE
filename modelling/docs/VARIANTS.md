# Variants of a player model

Five recipes, cheapest and safest first. All five are proven on real TS player models in
`test/ts-trial/`, and each folder there has the script that made it.

## The rule that applies to all of them

**Build every variant from the pristine original.** Never from your last output.

Every SMAK edit *appends*: new vertices, textures, animations and tables go at the end of
the file and the existing tables are pointed at them. The old bytes stay inside, unused.
So stacking runs makes the file grow without bound and, for anything involving `paint`,
degrades the palette each pass because the texture is requantised every time.

Where a variant genuinely needs to build on another -- the trial's `02_strip` works from
`01_damage`'s output, and `06_animation` from `02_strip`'s -- that is a deliberate chain
with a documented order, not convenience. Say so in the script when you do it.

---

## 1. Recolour, by palette alone

**The safest edit there is.** No pixel moves, so nothing can land out of place, and the
file does not grow when the texture is the same size.

The whole technique: walk each texture's 256 palette entries through a colour transform
and write them back.

```js
const out = K.replaceTexture(mdl, which, { ...old, palette: newPalette });
```

The trial's `03_recolour.mjs` does two strategies worth copying:

- **hue-rotate anything saturated** -- changes unit colours and leaves greys alone
- **remap cloth greys through a 5-stop luminance ramp** -- desert, woodland, arctic camo
  from the same source

One gotcha it handles: on a masked texture the last palette entry is the transparency
key, so stop at index 254.

```js
const last = t.flags & 64 ? 255 : 256;    // 64 is the masked flag
```

Use this when the ask is "the same soldier in green".

## 2. Paint by body position

`paint(src, fn, { pose, only, apart })` calls your function for each texture pixel with
**where that pixel sits on the posed body**, so you can paint by height, by surface
normal, by distance from a point -- and it carries across texture seams, because it
works in model space rather than UV space.

```js
const out = paint(mdl, ({ v, n, zf, tex }) => {
  // v: model-space point   n: surface normal   zf: normalised height   tex: sheet name
  const mud = clamp((0.35 - zf) * 3) * clamp(n[2]);     // from the boots up, on upward faces
  return mud > 0 ? W.mix(base, [0.21, 0.17, 0.12], mud) : null;    // null leaves it alone
});
```

`01_damage.mjs` is the flagship example and worth reading in full: dust and mud keyed to
height and surface-up, paint rubbed through on hard textures only, procedural scratches
as 3-D line segments, soot with a blast epicentre, blood that runs downward, and bullet
strikes placed *semantically* with `spot(surf, [x, y, Z(frac)], FRONT)` rather than by
raw coordinate.

Two cautions:

- **Read `shared`.** A third to two thirds of arm, gear and helmet pixels are worn by
  both sides of the body, so a one-sided mark often cannot be one-sided. Tell the person
  rather than shipping it wrong.
- **Each stage from the original**, with more in the function. Not painted over the last.

Use this for damage, weathering, dirt, battle wear.

## 3. Take gear off

`pieces()` finds the loose connected sub-meshes; `dropTriangles()` removes the ones you
name.

```
node smak/bin/smak.mjs pieces <mdl> --seq 1
```

lists each piece with its number, place and size. Then:

```js
const out = dropTriangles(mdl, [12, 13, 44]);
```

**What comes off and what does not is a property of the model, not a setting.** The trial
recorded this for `XCCPsgts`, and the comment is the most useful line in the folder:

> Looked at and left alone: the right forearm (1), the knee pads (25, 26), the shins (2
> to 5) and the helmet (57, 58, 60, 61) are the body itself there. The model has no arm,
> leg or head under them, so taking them off leaves a gap.

The pack, belt pouches, canisters and neck guard come off cleanly. Check with `pieces`
and a render before deciding, on every model -- piece numbers are not transferable
between models.

Use this for light-kit, recruit and stripped variants.

## 4. Graft a part from another model

`graft(to, from, pick, where, move)` moves meshes between models. It works because the
thirteen models **share one skeleton**, so a part transfers by bone name with nothing
else to fit.

```js
const headless = dropTriangles(soldier, helmetPieces);
const out = K.graft(headless, rebel, (me) => /head/i.test(me.texture.name), { bodypart: 1, model: 0 });
```

Two things to watch:

- **Mind the receiving submodel's vertex count.** GoldSrc allows 2048 per submodel and
  the donors are already most of the way there. `check` after the graft, not at the end.
- **Verify in motion, not in a pose.** `04_graft.mjs` renders a 6-frame `run2` strip for
  exactly this reason: *"a head that follows the wrong bone shows at once in a run or a
  dive"*.

The trial's residual defect is instructive about the limits: in `XCCPsgts_mask_only`,
*"the tip of the nose shows through the mask"* -- grafting does not solve
interpenetration.

Use this for mix-and-match heads, helmets and limbs within the family.

## 5. New gear, built from nothing and hung on a bone

Covered fully in [FROM-REFERENCE.md](FROM-REFERENCE.md) and
[PLAYER-MODELS.md](PLAYER-MODELS.md); the short version is: build triangles with
`workshop`, paint one sheet, and `hang()` the mesh on a bone with
`to = K.inverse34(P[b])`.

The known limitation, from the trial: *"The shield and baton are each fastened to one
bone. They follow a run in the pictures; a dive or a kick may push them through the
body."* One bone per mesh means gear is rigid relative to that bone -- fine for a pack or
a shield, wrong for anything that should bend.

Use this for equipment the model does not already have.

---

## Editing an animation

Not a variant recipe exactly, but it belongs here because `06_animation.mjs` does it and
it is the easiest way to break a model permanently.

`replaceSequence(src, which, { frames, blends, fps, loops })` replaces one **where it
stands**, keeping its index, events, activity and linear movement. `addSequence` appends
after the last.

**Never reorder or remove a sequence.** `AGENTS.md` rule 1, and the reason is that game
code plays animations by number. The same goes for submodels, bones and attachments --
rule 2. Everything in SMAK appends precisely so that numbers stay stable; do not work
around it.

Two things the trial got right and are worth copying:

- **Make a loop close.** Its breath cycle has a period that is a whole number of turns
  over the sequence, so frame *n* meets frame 0.
- **Prove you did not disturb the rest.** It diffs frame 0 and the last frame of all 170
  other sequences bone-by-bone and prints the maximum delta. On a model with 171
  sequences sharing one animation-value table, that check is the difference between a
  variant and a corrupted file.

One thing SMAK handles for you: if your new frames swing a bone further than its stored
channel scale reaches, it widens that scale and rewrites every other sequence against
the new one -- same motion, imperceptibly coarser for that bone. If you ever see
`moves further than its scale holds`, that is a bug in the kit, not in your script.

## What none of this can do

From `AGENTS.md`'s own list, so you do not go looking:

- give a model hitboxes, attachments or bone controllers (read-only; see
  [PLAYER-MODELS.md](PLAYER-MODELS.md))
- weight a vertex to more than one bone
- edit an animation kept in a separate `<name>01.mdl` -- SMAK refuses these outright
- read Source models, `.smd` or `.qc`
- make the two sides of a body differ where they share texture pixels
- put a body under armour that has none
- tell you how any of it looks under the game's light, or whether it loads at all

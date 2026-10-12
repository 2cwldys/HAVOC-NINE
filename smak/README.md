# SMAK: Studio Model Agent Kit

Tools for making and changing GoldSrc models (`.mdl`: Half-Life and its mods), built to be driven by an AI
coding agent such as Claude Code. You say what you want; the agent writes small scripts with this kit, draws the
result into pictures to check its own work, and hands you a `.mdl` to try in the game.

Version 0.4.0. An early release, made for an agent to work. For the person it has two pages in the browser: a
**viewer** that shows any two models side by side, turning and playing their animations together, and an
**editor** for touching up a model by hand (its animations, events and textures; not its shape), on a project
file the agent can work on too (`editor/README.md`).

## What it does

- **Textures**: takes them out of a model, puts new ones in (PNG or BMP), recolours, or paints them by rule.
- **Shapes**: replaces a weapon or item inside an existing model, keeping its hands, skeleton and animations;
  or writes a whole new model for a prop or pickup.
- **Animations**: reads them, changes them, replaces them in place or adds new ones, with their sound events.
- **By place**: paints wear, damage or markings where a point is on the body, across every texture it has, or a
  garment on chosen islands of a picture, in passes and with soft edges; adds a body again in another texture; finds
  a model's loose pieces (a pack, a pouch, a helmet) and takes them off; moves a part from one model to another
  that shares its skeleton.
- **Checking**: tells whether a model stays inside what GoldSrc, or Xash3D, can load.
- **Pictures**: draws any model from any side, or as the player sees a weapon, so the agent can see what it made.

It reads and writes the `.mdl` file directly. No decompiler, no studiomdl, no Blender, no `.smd` or `.qc`.

## What you need

- [Node.js](https://nodejs.org) 18 or later. Nothing to install after that: the kit has no dependencies.
- An AI coding agent that can run commands and look at images (Claude Code, or similar).
- Your mod's own model files.

## Starting

1. Unpack this folder somewhere, for example next to your working folder.
2. Check it runs: `node test/selftest.mjs` should end with `28 passed, 0 failed`.
3. Open your agent in a working folder and tell it where the kit is:

   > Read `smak/AGENTS.md`. I want to work on models for my GoldSrc mod; its models are in `C:\…\ts\models`.

   Agents that read `AGENTS.md` or `CLAUDE.md` on their own pick it up if you start them inside the `smak` folder.
4. Ask for what you want, with the model's file name. For example:
   - "Show me what is in `v_katana.mdl`."
   - "Make the blade texture of `v_katana.mdl` darker and more worn."
   - "Replace the knife in `v_knife.mdl` with a longer combat knife with a black cord grip."
   - "Slow the draw animation of `v_katana.mdl` down a little and add a sound at the frame the blade clears."
   - "Make three versions of this player model, more battle-worn each time, and one without its backpack."
5. The agent gives you a new `.mdl` and pictures of it. Copy the `.mdl` into your mod's `models` folder (keep a
   copy of the original) and look at it in the game.

Start with a texture change. It is the smallest step and proves the whole route on your game before anything
larger.

## Trying it yourself

```
node bin/smak.mjs info  path/to/model.mdl
node bin/smak.mjs sheet path/to/model.mdl -o sheet.png
node bin/smak.mjs strip path/to/v_model.mdl -o draw.png --seq 0 --view first
node bin/smak.mjs check path/to/model.mdl
node bin/smak.mjs view  path/to/a/folder/of/models
node examples/01-new-model.mjs out
```

`view` prints an address (http://127.0.0.1:8098/) to open in the browser. It lists every model in the folders
you give it; press A or B beside two of them, drag to turn, pick an animation. Give it your originals' folder
and the agent's output folder together to compare before and after.

`node bin/smak.mjs help` lists every command. If a picture comes out empty, the model keeps a blank submodel at
body 0: `info` shows the body numbers, and `--body N` picks one.

## What is in the folder

| | |
| --- | --- |
| `AGENTS.md` | The briefing for the agent: how a model is put together, the rules, the recipes. Worth a read yourself. |
| `docs/API.md` | Every function. |
| `docs/ENGINES.md` | GoldSrc against Xash: limits and differences. |
| `bin/smak.mjs` | The command line. |
| `src/` | The library: the model reader and writer, pictures, fitting, drawing, checking, working by place, and the workshop for building shapes and painting textures. |
| `kits/` | Builders for swords and knives, axes, blunt weapons and bows. |
| `viewer/` | The page that shows models side by side, and its small server. |
| `editor/` | The page for re-timing and re-posing animations, events and textures by hand, its server, and the same edits from a terminal. |
| `examples/` | Five scripts, one for each kind of work. |
| `test/selftest.mjs` | The kit checking itself. |

## Limits worth knowing first

- GoldSrc models only (version 10). Not Source.
- A new model written from nothing has no hit boxes and no attachments. For a weapon's first-person model, the
  kit replaces the shape inside the model your mod already has, which keeps both.
- One bone a vertex, as the format has it.
- Animations kept in separate `name01.mdl` files cannot be edited.
- The kit's pictures and its viewer use a plain light of their own. Shape, size, texture and pose are true;
  brightness is not.
- Written for GoldSrc's limits by default, so the same files load in Xash3D. See `docs/ENGINES.md`.
- It was built for another GoldSrc mod (Master Sword). Thirteen player models of The Specialists have been read,
  changed and drawn with it, but **nothing it made has been loaded by The Specialists yet**: your first model in
  the game is the real test.
- Many models give the left and right side of the body the same pixels of a texture. A mark painted on one side
  then shows on the other; the kit reports how much of each texture is shared.

## What changed in 0.4.0

Out of an agent's first armour texture made with the kit, and what got in its way.

- **`paint` tells its function where it is painting**: beside the point, the normal, the colour and the texture,
  now the bone the point follows, its mesh, body and triangle, the pixel's `u` and `v`, and the **island** of the
  picture it is in (a trunk's front, a sleeve), with how far the pixel is from that island's border (`edge`) and
  from the nearest open stretch of it, a hem or an armhole (`open`).
- **Islands**: `uvIslands(src, pose)` lists them (texture, box, bones, place, the way each faces, how much of its
  border is open), `islandMap` and `smak islands <mdl> -o dir` draw each texture with its islands tinted and
  numbered, and `paint`'s new `islands` option paints the chosen ones only.
- **Soft edges**: `paint(..., { soft: 3 })` asks the function at 3x3 points inside each pixel and averages them.
- **Passes**: `paint(src, [pass, pass], options)` paints several layers in full colour and cuts each picture to
  256 colours once, at the end. A pass can read the picture as it stood before it at any pixel (`at`) and
  smoothed within its island (`blur`), to lose an old picture's fine detail and keep its light and shade.
- **`copyBody(src, body, name, texture)`**: a body again, as a new body after the others, wearing another texture.
- `smak pieces <mdl> --body n` lists that body's pieces (it listed every submodel's); `pieces` gives each piece's
  mesh (`where`), `dropTriangles` each triangle's number (`tri`), `posed` both and each corner's bone.
- The editor's texture sliders: a focused slider takes the arrow keys (they stepped the timeline instead), each
  has a number box beside it and the tint colour a box for its hex digits, and one change of the tint is one line
  of the project's log.
- `AGENTS.md` now says what is true of texture sizes (any size loads; `check` notes what GoldSrc stretches or
  shrinks) and that a model's rest pose can be turned from its animated one.
- The editor's browser tests take their models and their Playwright from `SMAK_MODELS` and `SMAK_PLAYWRIGHT`.

Nothing that 0.3.0 had was changed or removed: the same calls of `paint` write the same bytes, and scripts
written for it run as they are. One thing behaves otherwise in the editor's page: letting a slider go where it
stood no longer writes a revision that changes nothing.

Earlier versions, and what a model made with one of them needs: `CHANGELOG.md`.

## Where it comes from

SMAK is the model tooling of the msr-web project, taken out so that it stands on its own. The kits for swords,
axes, blunt weapons and bows were made for that project's medieval weapons; for firearms and anything else the
agent builds shapes from the workshop's parts (`AGENTS.md`, "Making a shape").

## Licence

MIT (see `LICENSE`): use it, change it and pass it on freely, for any purpose. That covers the kit's code only.
The models and textures of a game belong to that game's authors, and what you make from them is theirs to allow.

# What changed, version by version

The newest first. A version that changes what a model's file looks like, or that a model made before needs
mending for, says so under **Mind**.

## 0.4.0 (2026-10-12)

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

## 0.3.0 (2026-10-12)

- **The editor** (`editor/`): `node bin/smak.mjs edit <folder of models>`, a page in the browser. Play and re-time
  an animation, pose a bone at a frame, thin an animation's keys so that it can be shaped by hand, add and move
  events, replace or adjust a texture, and save a model checked for GoldSrc or Xash. The models are only read: the
  work goes to a project file beside the saved model, and an agent makes the same edits on that file with
  `node editor/cli.mjs` (`editor/AGENTS.md`).
- It opens any model. A weapon in the player's hands (`v_<name>.mdl`) is shown as the player sees it, anything else
  from outside.
- An animation the game mixes from several (a player's aim up and down) is not posed, by the page or the command
  line: written from one set of frames it would lose the others. Its speed, looping and events can be changed, and
  a copy of it posed freely.
- The self-test covers the editor without a browser: 22 cases.

## 0.2.1 (2026-10-12)

- **A fault mended: models written by 0.2.0 and before can end a dedicated server (HLDS, ReHLDS) on a change of
  level.** They were written with their texture table, new textures or new animations after the first textures;
  the server's engine does not look there (`docs/ENGINES.md`, "The same file, appended to"). The clients draw such
  a file without complaint. Every function that changes a model now returns it laid out as the server reads it,
  and `check` refuses a file that is not.
- `engineLayout` (`src/layout.mjs`), which lays a model out so.

**Mind**: a model made with an earlier version that a server loads has to be mended once:
`writeFileSync(file, engineLayout(readFileSync(file)))`. Its numbers, shapes, animations and textures stay as they
were.

## 0.2.0 (2026-10-11)

- Working by place (`src/place.mjs`): `paint` across a texture's seams, `surface`, `spot`, `pieces` (a model's
  loose pieces), `dropTriangles`, and `graft` (parts from one model onto another with the same skeleton).
- The viewer: `smak view <folders>`, any two models side by side, turned and animated together.
- `smak pieces <mdl>`, `lineup` for before-and-after pictures, `workshop.fbm3` and `workshop.seeded`.
- `examples/05-by-place.mjs`.
- First run against another game: 13 player models of The Specialists, 20 variants made from them.

## 0.1.0 (2026-10-11)

The first release: the model tooling of the msr-web project, taken out to stand on its own.

- The reader and writer of GoldSrc studio models (`.mdl`, version 10): bones, bodyparts, meshes, textures, skins,
  animations, events, attachments, hit boxes; a model built from nothing (`buildMdl`), meshes replaced and added,
  textures replaced, animations replaced and added.
- `check` for GoldSrc and for Xash, pictures of a model (`render`, `sheet`, `strip`, `uvMap`), fitting a shape to
  a hand or a body, and the workshop for building shapes and painting textures.
- Kits for swords and knives, axes, blunt weapons and bows.
- The command line (`bin/smak.mjs`), four examples, the self-test, and the guide for an agent (`AGENTS.md`).

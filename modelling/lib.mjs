// What the modelling scripts share: where SMAK is, where the game's models are, and the
// pose everything is measured in.
//
// Modelled on test/ts-trial/scripts/lib.mjs, which is the worked example, but pointed at
// the game's own models rather than the trial's thirteen copies -- the install has 1893
// player model folders and the trial only took a family out of them.
//
// SMAK is looked for in `smak` beside this folder, or wherever SMAK points:
//     set SMAK=C:\tools\smak            (PowerShell: $env:SMAK = "C:\tools\smak")
// Models are read from TS_MODELS, or from the install below. NOTHING is ever written
// there: output goes to modelling/out.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- edit this if your install moves --------------------------------------
const GAME_MODELS = "D:/SteamLibrary/steamapps/common/Half-Life/ts/models/player";
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "out");
export const IN = resolve(process.env.TS_MODELS ?? GAME_MODELS);

const kit = resolve(process.env.SMAK ?? join(HERE, "..", "smak"));
if (!existsSync(join(kit, "src/index.mjs"))) {
  console.error(`SMAK is not at ${kit}.\nPut the kit there, or set the SMAK environment variable to its folder.`);
  process.exit(1);
}
export const K = await import(pathToFileURL(join(kit, "src/index.mjs")).href);
export const W = K.workshop, SMAK = kit;

if (!existsSync(IN)) {
  console.error(`No models at ${IN}.\nFix GAME_MODELS at the top of lib.mjs, or set TS_MODELS.`);
  process.exit(1);
}

/**
 * Reads a player model, folding in its external texture file if it has one.
 *
 * TS keeps some models' textures in a separate `<name>t.mdl`. Reading only the first
 * gives a model whose textures are an empty table, which then renders untextured and
 * confuses every measurement taken off its surface. The CLI does this inlining itself;
 * a script has to ask.
 */
export function load(name, dir = name) {
  const base = join(IN, dir, `${name}.mdl`);
  if (!existsSync(base)) {
    throw new Error(`no model at ${base}\n  (a player model lives at <models>/<name>/<name>.mdl)`);
  }
  const mdl = readFileSync(base);
  const tex = join(IN, dir, `${name}t.mdl`);
  return existsSync(tex) ? K.withTextures(mdl, readFileSync(tex)) : mdl;
}

export const save = (path, buf) => {
  mkdirSync(dirname(join(OUT, path)), { recursive: true });
  writeFileSync(join(OUT, path), buf);
  return buf;
};
export const savePng = (path, img) => save(path, K.png(img.width, img.height, img.rgba));
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// Sequence 0 is `empty` on these models: measuring in it gives a collapsed skeleton and
// nonsense coordinates. Sequence 1 is `standard_idle` and is what everything is measured in.
export const POSE = { seq: 1, frame: 0 };

export const surface = (src, pose = POSE) => K.surface(src, pose), spot = K.spot;
export const paint = (src, fn, opts = {}) => K.paint(src, fn, { pose: POSE, ...opts });
export const pieces = (src, pose = POSE) => K.pieces(src, pose);
export const dropTriangles = (src, drop, pose = POSE) => K.dropTriangles(src, drop, pose);
export const lineup = (list, opts = {}) => K.lineup(list, { ...POSE, ...opts });

/** Bone lookup by Italian name, without the `Bip01 ` prefix. Never hard-code an index:
 *  these models share one skeleton in two different orders. */
export function boneIndex(src) {
  const names = K.bones(src).map((b) => b.name);
  return (n) => {
    const i = names.indexOf(n === "" ? "Bip01" : `Bip01 ${n}`);
    if (i < 0) throw new Error(`no bone "Bip01 ${n}" -- this model has: ${names.join(", ")}`);
    return i;
  };
}

/**
 * Moves the texture data back to the end of the file.
 *
 * MODELS WITH APPENDED GEOMETRY DRAW AS NOTHING WITHOUT THIS, and that failure is
 * silent: check() passes, every index is in range, every pointer is inside the file,
 * and the model still renders as empty air in GoldSrc.
 *
 * Every edit SMAK makes appends to the end of the file. That is fine until the thing
 * already at the end is the texture block, which it is in every model studiomdl ever
 * wrote -- all seven TS player models measured have their last texture ending exactly
 * at EOF, with not one byte after it. Appending a mesh puts geometry past the
 * textures and breaks that invariant, and the engine does not forgive it.
 *
 * So each texture's pixels and palette are COPIED to the end and the texture table is
 * repointed at the copies. The originals stay where they were as dead bytes, which
 * costs file size and nothing else -- SMAK already leaves orphaned data behind on
 * every edit. Nothing but the texture table moves, so no other offset needs fixing.
 *
 * Call it LAST, after every mesh or texture change, and before writing the file.
 */
export function texturesLast(buf) {
    const i32 = (b, o) => b.readInt32LE(o);
    const nt = i32(buf, 180), ti = i32(buf, 184);
    if (!nt) {
        return buf;                      // textures live in a separate <name>t.mdl
    }

    const sizeOf = (o) => i32(buf, o + 68) * i32(buf, o + 72) + 768;   // w * h + palette

    let end = 0;
    for (let i = 0; i < nt; i++) {
        const o = ti + i * 80;
        end = Math.max(end, i32(buf, o + 76) + sizeOf(o));
    }
    if (end === buf.length) {
        return buf;                      // already last; nothing to do
    }

    const parts = [Buffer.from(buf)];
    let size = buf.length;
    const moved = [];

    for (let i = 0; i < nt; i++) {
        const o = ti + i * 80;
        const at = i32(buf, o + 76), need = sizeOf(o);
        const pad = (4 - size % 4) % 4;  // 4-byte aligned, as SMAK aligns its own appends
        if (pad) {
            parts.push(Buffer.alloc(pad));
            size += pad;
        }
        moved.push(size);
        parts.push(Buffer.from(buf.subarray(at, at + need)));
        size += need;
    }

    const out = Buffer.concat(parts, size);
    for (let i = 0; i < nt; i++) {
        out.writeInt32LE(moved[i], ti + i * 80 + 76);
    }
    out.writeInt32LE(moved[0], 188);     // texturedataindex
    out.writeInt32LE(out.length, 72);    // studiohdr.length, which check() verifies
    return out;
}

/**
 * Grows the painted part of every texture out into the unused background around it.
 *
 * REPAINTING A MODEL EXPOSES SEAMS ITS ORIGINAL NEVER SHOWED. A texture is a handful of
 * panels with dead space between them, and that dead space is usually near-black. The
 * engine filters and mipmaps across panel edges regardless, so it pulls that black in
 * and draws a dark line along every seam -- down the side of a face, round a jaw, over
 * a scalp. The donor hides it under dark hair or a dark suit; a repaint in any lighter
 * colour does not, and no amount of adjusting the paint helps, because the colour being
 * dragged in was never painted at all.
 *
 * So the painted colour is pushed outwards a few pixels into the black, giving the
 * filter something of the right colour to find. `floor` is what counts as background,
 * summed over the three channels; nothing SMAK's workshop paints comes near it.
 *
 * Call it after painting and before texturesLast, which it displaces.
 */
/** Checks a model for GoldSrc and says so; throws on an error. */
export function checked(name, mdl) {
  const r = K.check(mdl, "goldsrc");
  console.log(`${name}: ${mdl.length} bytes, ${r.errors.length} errors, ${r.warnings.length} warnings`);
  if (r.errors.length) throw new Error(r.errors.join("\n"));
  return mdl;
}

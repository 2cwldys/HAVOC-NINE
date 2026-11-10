// Shared helpers of the Mech arm models: the M60's skeleton and animations carried into a fresh model, the placing of
// triangles drawn in the view model's own space onto bones, and the three sides' colours.
//
// A view model is built from the stock M60's bones, animations, events and attachments (read from v_m60.mdl), with
// none of its meshes or pictures: SMAK's buildMdl writes a new file, so the Mech's models hold only the Mech's parts.
// Everything is drawn in the view model's space at the stock idle pose: +x forward from the eye, +y to the left, +z up.
import { readFileSync } from "node:fs";
import * as K from "file:///D:/Downloads/TSM/smak/src/index.mjs";

export { K };
export const TSM = process.env.TSM_ROOT ?? "D:/Downloads/TSM";
export const STOCK_MODELS = process.env.MECH_STOCK ?? `${TSM}/H9XASH/ts/models`;

/** The three sides' accent colours (0 to 1). default: null, which is the hazard yellow and black. */
export const SIDES = {
  msr: [60 / 255, 120 / 255, 255 / 255],
  insurgent: [80 / 255, 200 / 255, 90 / 255],
  default: null,
};

/** A stock model's skeleton, animations, events, attachments and hit boxes, with room to add bones. */
export function loadStock(file) {
  const src = readFileSync(file);
  const bones = K.bones(src).map((b) => ({ ...b }));
  const seqs = K.sequences(src).map((s, i) => ({
    name: s.name, fps: s.fps, loops: s.loops, flags: s.flags, activity: s.activity, actweight: s.actweight,
    frames: K.readSequence(src, i).frames.map((f) => f.map((v) => [...v])), events: K.events(src, i),
  }));
  return { src, bones, seqs, attachments: K.attachments(src).map((a) => ({ ...a })), hitboxes: K.hitboxes(src), boxes: K.modelBoxes(src) };
}

/** More bones after the stock's, at rest in every animation. */
export function addBones(stock, list) {
  for (const b of list) {
    const parent = typeof b.parent === "string" ? stock.bones.findIndex((x) => x.name === b.parent) : b.parent;
    stock.bones.push({ name: b.name, parent, pos: b.pos, rot: b.rot ?? [0, 0, 0] });
    for (const s of stock.seqs) for (const f of s.frames) f.push([...b.pos, ...(b.rot ?? [0, 0, 0])]);
  }
}

export const boneIndex = (stock, name) => {
  const i = stock.bones.findIndex((b) => b.name === name);
  if (i < 0) throw new Error(`no bone ${name}`);
  return i;
};

/** Each bone's matrix at the idle pose (the first frame of the first animation) and at rest. */
export function poses(stock) {
  const idle = K.boneMatrices(stock.bones, stock.seqs[0].frames[0]);
  const rest = K.boneMatrices(stock.bones);
  return { idle, rest };
}

/**
 * Triangles drawn in idle-pose space (`place` moves each point first, for the p_ and w_ models), each corner's `of` (the
 * part's name) starting with a prefix that `boneOf` maps to a bone, as the corners buildMdl takes: the point in the model's rest space, and the bone.
 */
export function onBones(stock, tris, boneOf, place) {
  const { idle, rest } = poses(stock);
  const cache = new Map();
  const bone = (of) => {
    if (!cache.has(of)) {
      const name = boneOf(of);
      if (!name) throw new Error(`no bone for part ${of}`);
      cache.set(of, name);
    }
    return cache.get(of);
  };
  const byBone = new Map();
  for (const t of tris) {
    const name = bone(String(t[0].of ?? ""));
    const b = boneIndex(stock, name);
    const inv = K.inverse34(idle[b]);
    const corners = t.map((c) => ({ ...c, p: K.apply34(rest[b], K.apply34(inv, place ? place(c.p) : c.p)), bone: b }));
    if (!byBone.has(name)) byBone.set(name, []);
    byBone.get(name).push(corners);
  }
  return byBone;
}

/** The model file: the stock's skeleton and animations with `parts`, as bodyparts (one submodel and mesh each). */
export function writeModel(stock, { name, parts, texture, extraAttachments }) {
  const bodyparts = parts.map(({ name: partName, tris }) => ({
    name: partName,
    models: [{ name: partName, meshes: [{ tris, texture }] }],
  }));
  const box = stock.boxes;
  return K.buildMdl({
    name,
    bones: stock.bones,
    sequences: stock.seqs,
    attachments: extraAttachments ?? stock.attachments,
    hitboxes: stock.hitboxes,
    bodyparts,
    eyes: box.eyes, min: box.min, max: box.max, bbmin: box.bbmin, bbmax: box.bbmax,
  });
}

/** Where a bone stands in idle-pose space, and a point of the model's space taken into its own space. */
export const intoBone = (stock, bone, p) => {
  const { idle } = poses(stock);
  return K.apply34(K.inverse34(idle[boneIndex(stock, bone)]), p);
};

/**
 * One 8-bit texture for each side from the sides' pictures, which differ only inside `rect` (the band's zone): the palette is
 * made from the default picture with 16 entries kept free, the band's own colours of the other sides take those, and every
 * pixel outside the rectangle is the same index in all three. So a set differs from another only in its band, in the exact
 * colours the side asks for.
 */
export function sideTextures(images, rect, name, bleed = 3) {
  const base = K.indexed(images.default, name, 240);
  const out = { default: base };
  const inRect = (x, y) => x >= rect.x - bleed && x < rect.x + rect.w + bleed && y >= rect.y - bleed && y < rect.y + rect.h + bleed;
  for (const side of Object.keys(images)) {
    if (side === "default") continue;
    const img = images[side];
    const palette = new Uint8Array(base.palette);
    // the colours of the band, most used first, the first 16 not already in the palette
    const count = new Map();
    for (let y = rect.y - bleed; y < rect.y + rect.h + bleed; y++) for (let x = rect.x - bleed; x < rect.x + rect.w + bleed; x++) {
      const i = (y * img.width + x) * 3;
      const key = (img.rgb[i] << 16) | (img.rgb[i + 1] << 8) | img.rgb[i + 2];
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    let used = 240;
    for (const [key] of [...count].sort((a, b) => b[1] - a[1])) {
      if (used >= 256) break;
      const c = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
      palette.set(c, used * 3);
      used++;
    }
    const pixels = new Uint8Array(base.pixels);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      if (!inRect(x, y)) continue;
      const i = (y * img.width + x) * 3;
      let best = 0, least = 1e9;
      for (let j = 0; j < used; j++) {
        const d = (palette[j * 3] - img.rgb[i]) ** 2 + (palette[j * 3 + 1] - img.rgb[i + 1]) ** 2 + (palette[j * 3 + 2] - img.rgb[i + 2]) ** 2;
        if (d < least) { least = d; best = j; }
      }
      pixels[y * img.width + x] = best;
    }
    out[side] = { ...base, palette, pixels };
  }
  return out;
}

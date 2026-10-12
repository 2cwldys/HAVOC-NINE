// The two ways a new shape gets into the game: a whole model written from triangles (buildMdl), and a new piece put
// in the place of one that an existing model already shows (swapMesh), which keeps that model's bones, animations,
// events and attachments, so the game goes on using it as it did.
//
// A piece is what the workshop and the kits make: { tris, image }. A triangle is three corners { p: [x, y, z],
// uv: [u, v] (0..1, from the picture's top left) } and, where the piece hangs from more than one bone, `bone`.
import { writeMdl, readMdl, replaceMesh, emptyMesh, boneMatrices, mul34, inverse34 } from "./mdl.mjs";
import { meshOf } from "./mesh.mjs";
import { HANDS, measure, frameOf, bestTurn } from "./fit.mjs";
import { into, out, box, uniq } from "./vec.mjs";

/**
 * A whole model from triangles.
 *   name       what the file calls itself ("mygun.mdl")
 *   bones      [{ name, parent (-1 for a root; a parent comes before its children), pos, rot }]; one bone, "root", unless told
 *   bodyparts  [{ name, models: [{ name, meshes: [{ tris, texture }] }] }]
 *              tris: corners { p (where it is in the model, the bones at rest), uv, bone (a bone's name or number; the first unless told) }
 *              texture: { name, width, height, pixels, palette, flags } (see image.mjs: indexed, masked, textureFrom);
 *              meshes that give a texture of the same name share it
 *   sequences  [{ name, fps, loops, frames: [for each frame, for each bone, [x, y, z, about x, about y, about z]] }];
 *              one, "idle", holding the bones at rest, unless told
 *   smooth     faces meeting at less than this many degrees share a normal (40)
 * It has no hit boxes, attachments or events: enough for a thing that is carried, worn, dropped or stood somewhere.
 * A weapon's first-person model needs those: start from the one the game has and use swapMesh.
 */
export function buildMdl({ name, bones = [{ name: "root", parent: -1 }], bodyparts, sequences, smooth = 40 }) {
  const rest = boneMatrices(bones), back = rest.map(inverse34), textures = [];
  const boneAt = (b) => { const i = typeof b === "number" ? b : b === undefined ? 0 : bones.findIndex((x) => x.name === b); if (!bones[i]) throw new Error(`${name}: no bone ${b}`); return i; };
  const skinOf = (t) => { let i = textures.findIndex((x) => x.name === t.name); if (i < 0) i = textures.push(t) - 1; return i; };
  const parts = bodyparts.map((bp) => ({
    name: bp.name,
    models: bp.models.map((md) => {
      const verts = [], vertBones = [], meshes = [];
      for (const x of md.meshes) {
        const m = meshOf(null, x.tris.map((t) => t.map((c) => { const b = boneAt(c.bone); return { p: c.p, uv: c.uv, bone: b, to: back[b] }; })), x.texture, 0, smooth), base = verts.length;
        verts.push(...m.verts); vertBones.push(...m.vertBones);
        meshes.push({ skin: skinOf(x.texture), norms: m.norms, normBones: m.normBones, tris: m.tris.map((t) => t.map(([v, n, s, tt]) => [base + v, n, s, tt])) });
      }
      return { name: md.name, verts, vertBones, meshes };
    }),
  }));
  const still = bones.map((b) => [...(b.pos ?? [0, 0, 0]), ...(b.rot ?? [0, 0, 0])]);
  return writeMdl({ name, bones, sequences: sequences ?? [{ name: "idle", fps: 10, loops: true, frames: [still] }], textures, bodyparts: parts });
}

/**
 * Returns a copy of a model with a new piece where one of its submodels shows an old one.
 *   body     the number the game gives the model to show that submodel (of the first bodypart)
 *   pick     (mesh) -> true for the meshes that are the old piece (default: all but the hands' and arms', told by their texture's name)
 *   piece    { tris, haft, rig, bones } as the kits make it
 *   texture  the piece's picture as a texture (indexed(piece.image, "name.bmp"))
 *   place    "fit" (default): the piece is drawn in its own axes, at any size (+x its length, +y its width, +z its
 *              thickness), and is laid over the old one: same length, same place, and of the four ways of turning it
 *              the one whose outline follows the old one's best
 *            "bone": its points are already where they must be, in the space of the bone that carries the old piece
 *   size     "old" (default): the piece is stretched to the old one's length, whatever size it was drawn at
 *            "own": it was drawn in the game's units and keeps its size; the end it starts at (its lowest x: the grip,
 *              the butt) stays where the old one's was, so the hand still holds it
 * The first of the old meshes takes the new piece; the others are left without triangles. A corner goes on the bone that
 * carried the old piece, unless the piece says otherwise: `rig: "nearest"` gives each corner the bone of the old piece's
 * nearest corner (what bent goes on bending), and `bones: [, "name", ...]` sends the corners of `part` n to that bone.
 * Returns { mdl, report }: `report.left` is what is left between the two outlines, in units (small is good).
 */
export function swapMesh(src, { body = 0, pick = (mesh) => !HANDS.test(mesh.texture.name), piece, texture, place = "fit", size = "old", name = "" }) {
  const { info, j, model, meshes, rest, bone, original } = measure(src, body, pick, name);
  const laid = place === "fit", frame = laid ? frameOf(original) : null, inAxes = laid ? original.map((t) => t.map((c) => ({ p: into(frame, c.p), mesh: c.mesh, bone: c.bone }))) : original;
  let fit = laid ? bestTurn(piece.tris, inAxes, piece.haft) : { k: 1, name: "as given", left: 0, at: (p) => p };
  if (laid && size === "own") {
    const b = box(uniq(piece.tris)), hold = fit.at([b.mn[0], (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2]), at = fit.at, k = fit.k;
    fit = { ...fit, k: 1, at: (p) => at(p).map((v, a) => hold[a] + (v - hold[a]) / k) };
  }
  const parts = (piece.bones ?? []).map((n, i) => (i ? info.bones.indexOf(n) : bone)), theirs = piece.rig === "nearest" ? inAxes.flat() : null;
  const nearest = (q) => { let b = bone, d = Infinity; for (const c of theirs) { const e = 3 * Math.abs(c.p[0] - q[0]) + Math.abs(c.p[1] - q[1]) + Math.abs(c.p[2] - q[2]); if (e < d) { d = e; b = c.bone; } } return b; };
  const tris = piece.tris.map((t) => t.map((c) => {
    const q = fit.at(c.p), p = laid ? out(frame, q) : q, b = theirs ? nearest(q) : parts[c.part] ?? -1;
    return b >= 0 && b !== bone ? { p, uv: c.uv, bone: b, to: mul34(inverse34(rest[b]), rest[bone]) } : { p, uv: c.uv };
  }));
  const mesh = meshOf(original, tris, texture, bone);
  let mdl = replaceMesh(src, { bodypart: 0, model: j, mesh: meshes[0].k }, mesh, texture);
  for (const { k } of meshes.slice(1)) mdl = emptyMesh(mdl, { bodypart: 0, model: j, mesh: k });
  const nb = box(uniq(tris)), ob = box(uniq(original));
  return { mdl, report: { model: model.name, bone: info.bones[bone], bones: [...new Set(mesh.vertBones)].map((b) => info.bones[b]), was: original.length, now: tris.length, verts: mesh.verts.length, scale: fit.k, turn: fit.name, left: fit.left,
    boxOff: Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(nb.mn[a] - ob.mn[a]), Math.abs(nb.mx[a] - ob.mx[a])])), textures: readMdl(mdl).textures.length } };
}

// A model looked over before it goes into a game: what would crash the engine or draw wrong (errors), and what it
// will put up with but should be known (warnings). Run it on everything that is written.
//
// The two engines read the same file and differ in how much of it they hold:
//   goldsrc   Half-Life's own engine (Steam), which a GoldSrc mod runs on today
//   xash      Xash3D FWGS, which holds more
// A model that passes for goldsrc passes for xash.
import { readMdl, readMesh, sequences, bones, frameValues, drawnCorners, skinFamilies } from "./mdl.mjs";
import { sub, dot, cross } from "./vec.mjs";
import { FRONT } from "./mesh.mjs";
import { isEngineLayout } from "./layout.mjs";

/** What each engine holds. `verts`: points and normals of one submodel, and the corners it draws. */
export const LIMITS = {
  goldsrc: { verts: 2048, bones: 128, textures: 100, bodyparts: 32, models: 32, meshes: 256, sequences: 2048, texture: 512 },
  xash: { verts: 16384, bones: 128, textures: 256, bodyparts: 32, models: 32, meshes: 256, sequences: 2048, texture: 4096 },
};
const pow2 = (n) => n > 0 && (n & (n - 1)) === 0;

/** Returns { errors, warnings, facts }, each a list of sentences. */
export function check(src, engine = "goldsrc") {
  const L = LIMITS[engine]; if (!L) throw new Error(`engine: goldsrc or xash, not ${engine}`);
  const errors = [], warnings = [], facts = [];
  let info;
  try { info = readMdl(src); } catch (e) { return { errors: [e.message], warnings, facts }; }
  if (src.readInt32LE(72) !== src.length) errors.push(`the file says it is ${src.readInt32LE(72)} bytes long and is ${src.length}`);
  if (!isEngineLayout(src)) errors.push("the texture table does not come before the textures, or they are not in its order: a dedicated server (HLDS, ReHLDS) reads it wrongly and dies on a change of level. Pass the model through engineLayout before writing it");
  const nb = info.bones.length, seqs = sequences(src), fams = skinFamilies(src), refs = fams[0]?.length ?? 0;
  if (nb > L.bones) errors.push(`${nb} bones: the engine holds ${L.bones}`);
  if (!nb) warnings.push("no bones");
  bones(src).forEach((b, i) => { if (b.parent >= i) errors.push(`the bone ${b.name} hangs from a bone that comes after it`); });
  // the compiler's own limits, which models in use are known to pass: told, not refused
  if (info.textures.length > L.textures) warnings.push(`${info.textures.length} textures: more than the ${L.textures} ${engine === "goldsrc" ? "GoldSrc's compiler" : "Xash"} allows for; try it in the game`);
  if (info.bodyparts.length > L.bodyparts) errors.push(`${info.bodyparts.length} bodyparts: the engine holds ${L.bodyparts}`);
  if (seqs.length > L.sequences) warnings.push(`${seqs.length} animations: more than the ${L.sequences} the engine's header allows for; try it in the game`);
  if (!seqs.length) warnings.push("no animation: the engine expects one at least");
  const outside = seqs.filter((s) => s.group);
  if (outside.length) warnings.push(`${outside.length} animations are kept in other files (name01.mdl...): they cannot be read or changed here`);
  if (!info.textures.length && info.bodyparts.some((bp) => bp.models.some((m) => m.meshes.length))) warnings.push("its textures are kept in another file (the same name with a t before .mdl): put them inside with withTextures before working on it");
  const big = [], odd = [];
  for (const t of info.textures) {
    if (t.index + t.width * t.height + 768 > src.length) errors.push(`the texture ${t.name} runs past the end of the file`);
    if (t.width > L.texture || t.height > L.texture) big.push(`${t.name} ${t.width}x${t.height}`);
    if (!pow2(t.width) || !pow2(t.height)) odd.push(`${t.name} ${t.width}x${t.height}`);
    if (t.flags & 2 && engine === "goldsrc" && (t.width !== 64 || t.height !== 64)) warnings.push(`the chrome texture ${t.name} is ${t.width}x${t.height}: older GoldSrc draws chrome right only at 64x64`);
  }
  const some = (list) => `${list.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}`;
  if (big.length) warnings.push(engine === "goldsrc" ? `${big.length} textures larger than 512 (${some(big)}): GoldSrc draws nothing finer than gl_max_size (512 by default, 256 in builds before 2023) and shrinks them` : `${big.length} textures larger than ${L.texture} (${some(big)})`);
  if (odd.length && engine === "goldsrc") facts.push(`${odd.length} textures have a side that is not a power of two (${some(odd)}): GoldSrc stretches those to one when it loads them, a little softer`);
  const drawn = drawnCorners(src); let k = 0, turned = 0, total = 0;
  for (const bp of info.bodyparts) {
    if (bp.models.length > L.models) facts.push(`${bp.name}: ${bp.models.length} submodels, more than the compiler's ${L.models} (models in use have as many)`);
    for (const m of bp.models) {
      const corners = drawn[k++].corners, where = `${bp.name}/${m.name}`;
      if (m.numverts > L.verts) errors.push(`${where}: ${m.numverts} points: ${engine} holds ${L.verts} a submodel`);
      if (m.numnorms > L.verts) errors.push(`${where}: ${m.numnorms} normals: ${engine} holds ${L.verts} a submodel`);
      if (engine === "xash" && corners > L.verts) errors.push(`${where}: ${corners} corners to draw: Xash holds ${L.verts} a submodel`);
      else if (engine === "xash" && corners > L.verts * 0.75) warnings.push(`${where}: ${corners} corners to draw, near Xash's ${L.verts}`);
      if (m.meshes.length > L.meshes) errors.push(`${where}: ${m.meshes.length} meshes: the engine holds ${L.meshes}`);
      const vi = src.readInt32LE(m.at + 84), ni = src.readInt32LE(m.at + 96);
      for (let i = 0; i < m.numverts; i++) if (src[vi + i] >= nb) { errors.push(`${where}: a point on bone ${src[vi + i]}, and there are ${nb}`); break; }
      for (let i = 0; i < m.numnorms; i++) if (src[ni + i] >= nb) { errors.push(`${where}: a normal on bone ${src[ni + i]}, and there are ${nb}`); break; }
      let before = 0;
      m.meshes.forEach((x, q) => {
        if (info.textures.length && x.skinref >= refs) errors.push(`${where} mesh ${q}: wears skin ${x.skinref}, and there are ${refs}`);
        if (!x.numtris) { before += x.numnorms; return; }
        // every corner's point and normal have to be the submodel's own, and the normal one of this mesh's turn
        let bad = 0, far = 0;
        for (let o = x.triindex; ;) { const c = Math.abs(src.readInt16LE(o)); o += 2; if (!c) break; for (let i = 0; i < c; i++, o += 8) { const v = src.readInt16LE(o), n = src.readInt16LE(o + 2); if (v < 0 || v >= m.numverts || n < 0 || n >= m.numnorms) bad++; else if (n < before || n >= before + x.numnorms) far++; } }
        if (bad) { errors.push(`${where} mesh ${q}: ${bad} corners point outside the submodel's points or normals`); before += x.numnorms; return; }
        if (far) warnings.push(`${where} mesh ${q}: ${far} corners use normals that are not this mesh's own: they are lit with another texture's light`);
        before += x.numnorms;
        for (const t of readMesh(src, m, x)) {
          total++;
          if (t[0].bone === t[1].bone && t[0].bone === t[2].bone && dot(cross(sub(t[1].p, t[0].p), sub(t[2].p, t[0].p)), t[0].n) * FRONT < 0) turned++;
        }
      });
    }
  }
  if (total && turned / total > 0.05) warnings.push(`${turned} of ${total} triangles look the other way from their normals: right for a sheet seen from both sides (a leaf, a cloth), wrong for a solid, which would be seen from inside`);
  for (const [q, s] of seqs.entries()) {
    if (s.group) continue;
    if (s.frames < 1) errors.push(`the animation ${s.name} has no frames`);
    try { for (let bl = 0; bl < s.blends; bl++) frameValues(src, q, Math.max(0, s.frames - 1), bl); } catch { errors.push(`the animation ${s.name} cannot be read to its last frame`); }
  }
  facts.push(`${src.length} bytes, ${nb} bones, ${info.textures.length} textures, ${seqs.length} animations, ${info.bodyparts.length} bodyparts, ${total} triangles in all`);
  const worst = [...drawn].sort((a, b) => b.corners - a.corners)[0];
  if (worst) facts.push(`the heaviest submodel is ${worst.name}: ${worst.corners} corners drawn`);
  return { errors, warnings, facts };
}

// Working on a model by place: where a point is on the body, not where it is in a picture or which mesh holds it.
// Painting across texture seams, finding and taking off loose pieces, and moving a part from one model to another.
import { readMdl, readMesh, textureOf, replaceTexture, replaceMesh, addMesh, filterMesh, bones, apply34 } from "./mdl.mjs";
import { rgbaOf, indexed, masked } from "./image.mjs";
import { posed } from "./render.mjs";
import { sub, dot, unit, box } from "./vec.mjs";

const clamp = (v) => Math.min(1, Math.max(0, v));

/**
 * The model's surface as it stands in `pose` (what `posed` takes: { seq, frame, body, skin }): one { p, n, tex } a
 * triangle, its middle, the way it faces and its texture's name. For choosing where things land.
 */
export function surface(src, pose = {}) {
  return posed(src, pose).tris.map((t) => ({ p: [0, 1, 2].map((a) => (t.c[0].p[a] + t.c[1].p[a] + t.c[2].p[a]) / 3), n: unit([0, 1, 2].map((a) => t.c[0].n[a] + t.c[1].n[a] + t.c[2].n[a])), tex: t.tex?.name ?? null }));
}
/** The place of a surface (from `surface`) nearest `near` that looks towards `facing` and, when told, wears one of the textures `on`. Null when there is none. */
export function spot(surf, near, facing = null, on = null) {
  let best = null, bd = Infinity;
  for (const s of surf) {
    if (on && !on.includes(s.tex)) continue;
    if (facing && dot(s.n, facing) < 0.35) continue;
    const d = Math.hypot(...sub(s.p, near)); if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/**
 * Paints the model by place. `fn({ p, n, rgb, tex })` is called for every pixel of every texture that some triangle wears,
 * with the point of the body it colours (model space, as the model stands in `pose`), the way the surface faces there, the
 * colour there now (0 to 1) and the texture's name; it returns the new colour, or nothing to leave it. A mark made at one
 * place of the body so crosses from one texture to the next without a seam.
 *   only    the names of the textures to paint (all of them unless told)
 *   pose    as `posed` takes it
 * Each painted texture is cut back to 256 colours and put back in its place at its own size; a masked one keeps its holes.
 * Returns { mdl, shared }: `shared[name]` is the share of that texture's pixels worn by two places of the body more than
 * `apart` (3) units from each other. Models often give the left and right arm or leg the same pixels: what is painted on
 * one side then shows on the other, and nothing short of laying the texture out again changes that.
 */
export function paint(src, fn, { pose = {}, only = null, apart = 3 } = {}) {
  const { info, tris } = posed(src, pose);
  let mdl = src; const shared = {};
  for (const t of info.textures) {
    if (only && !only.includes(t.name)) continue;
    const mine = tris.filter((x) => x.tex === t); if (!mine.length) continue;
    const tex = textureOf(src, t.name), { width: w, height: h } = tex, holes = Boolean(t.flags & 64), was = rgbaOf(tex, holes);
    const rgba = Uint8Array.from(was), done = new Uint8Array(w * h), at = new Float32Array(w * h * 3);
    let twice = 0, once = 0, changed = false;
    for (const x of mine) {
      const [a, b, c] = x.c, det = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
      if (Math.abs(det) < 1e-6) continue;
      const x0 = Math.floor(Math.min(a.u, b.u, c.u)) - 1, x1 = Math.ceil(Math.max(a.u, b.u, c.u)) + 1, y0 = Math.floor(Math.min(a.v, b.v, c.v)) - 1, y1 = Math.ceil(Math.max(a.v, b.v, c.v)) + 1;
      const slack = 1.2 / Math.sqrt(Math.abs(det));           // about a pixel past each edge, so that seams are covered
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const u = px + 0.5, v = py + 0.5;
        const wb = ((u - a.u) * (c.v - a.v) - (c.u - a.u) * (v - a.v)) / det, wc = ((b.u - a.u) * (v - a.v) - (u - a.u) * (b.v - a.v)) / det, wa = 1 - wb - wc;
        if (wa < -slack || wb < -slack || wc < -slack) continue;
        const inside = wa >= 0 && wb >= 0 && wc >= 0, i = (((py % h) + h) % h) * w + (((px % w) + w) % w);
        const p = [0, 1, 2].map((k) => a.p[k] * wa + b.p[k] * wb + c.p[k] * wc);
        if (done[i]) {
          if (!inside) continue;
          if (done[i] === 2 && Math.hypot(p[0] - at[i * 3], p[1] - at[i * 3 + 1], p[2] - at[i * 3 + 2]) > apart) { twice++; done[i] = 3; }      // counted once, however many wear it
          if (done[i] >= 2) continue;                    // a pixel first reached only by the margin of a triangle is painted again by the one it lies in
        }
        if (inside) once++;
        done[i] = inside ? 2 : 1; at.set(p, i * 3);
        if (holes && was[i * 4 + 3] < 128) continue;
        const n = unit([0, 1, 2].map((k) => a.n[k] * wa + b.n[k] * wb + c.n[k] * wc));
        const out = fn({ p, n, rgb: [was[i * 4] / 255, was[i * 4 + 1] / 255, was[i * 4 + 2] / 255], tex: t.name });
        if (out) { changed = true; for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(clamp(out[k]) * 255); }
      }
    }
    shared[t.name] = +(twice / Math.max(1, once)).toFixed(2);
    if (!changed) continue;
    const rgb = new Uint8Array(w * h * 3); for (let i = 0; i < w * h; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const next = holes ? masked({ width: w, height: h, rgba }, t.name) : indexed({ width: w, height: h, rgb }, t.name);
    mdl = replaceTexture(mdl, t.name, { ...next, name: t.name, flags: t.flags });
  }
  return { mdl, shared };
}

const keyOf = (p) => p.map((v) => v.toFixed(2)).join();
/** Every mesh's triangles in model space as the model stands in `pose`, with where the mesh is. */
function meshes(src, pose) {
  const info = readMdl(src), P = posed(src, pose).pose, out = [];
  info.bodyparts.forEach((bp, i) => bp.models.forEach((m, j) => m.meshes.forEach((me, k) => {
    if (me.numtris) out.push({ where: { bodypart: i, model: j, mesh: k }, part: bp.name, model: m.name, tex: me.texture?.name ?? null, tris: readMesh(src, m, me).map((t) => t.map((c) => apply34(P[c.bone], c.p))) });
  })));
  return out;
}

/**
 * The model's loose pieces: within each mesh, the groups of triangles that touch one another. A pouch, a plate, a pack, a
 * helmet is usually one piece. Returns { list, of }:
 *   list   [{ id, tex, part, model, tris (how many), mn, mx, mid }] in model space, as the model stands in `pose`
 *   of(t)  the id of the piece a triangle belongs to, for a `t` as `dropTriangles` hands it to its `drop`
 * A body's own limb is a piece too, and often there is nothing under what looks like armour: look at a picture of the
 * model without a piece before deciding it can come off.
 */
export function pieces(src, pose = {}) {
  const list = [], by = new Map();
  for (const m of meshes(src, pose)) {
    const parent = new Map(), find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (const t of m.tris) { const ks = t.map(keyOf); for (const k of ks) if (!parent.has(k)) parent.set(k, k); parent.set(find(ks[1]), find(ks[0])); parent.set(find(ks[2]), find(ks[0])); }
    const groups = new Map();
    for (const t of m.tris) { const r = find(keyOf(t[0])); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
    for (const g of groups.values()) {
      const b = box(g.flat()), id = list.length, r1 = (v) => +v.toFixed(1);
      list.push({ id, tex: m.tex, part: m.part, model: m.model, tris: g.length, mn: b.mn.map(r1), mx: b.mx.map(r1), mid: b.mn.map((v, a) => r1((v + b.mx[a]) / 2)) });
      for (const t of g) by.set(`${m.where.bodypart}|${m.where.model}|${m.where.mesh}|${t.map(keyOf).join("|")}`, id);
    }
  }
  return { list, of: (t) => by.get(`${t.where.bodypart}|${t.where.model}|${t.where.mesh}|${t.p.map(keyOf).join("|")}`) };
}

/**
 * A copy of the model without the triangles `drop` accepts. It is given { p: [three points], mid, tex, part, model, where }
 * in model space, as the model stands in `pose`. Points, normals, bones, animations and the other triangles stay as they
 * are (`filterMesh` does the cutting). Returns { mdl, gone }.
 *   const P = pieces(src); dropTriangles(src, (t) => [59, 36].includes(P.of(t)))     // two pieces off
 *   dropTriangles(src, (t) => t.mid[2] > 60)                                          // everything above a height
 */
export function dropTriangles(src, drop, pose = {}) {
  let mdl = src, gone = 0;
  for (const m of meshes(src, pose)) {
    let at = 0, cut = 0;
    const next = filterMesh(mdl, m.where, () => { const p = m.tris[at++], d = drop({ p, mid: [0, 1, 2].map((a) => (p[0][a] + p[1][a] + p[2][a]) / 3), tex: m.tex, part: m.part, model: m.model, where: m.where }); if (d) cut++; return !d; });
    if (cut) { mdl = next; gone += cut; }
  }
  return { mdl, gone };
}

/**
 * Meshes of one model added to another that hangs from the same skeleton: a head, a pack, a holster. Every point stays
 * where it is in the space of its own bone, and the bone is looked up in the target **by name**, so the two files may
 * keep their bones in another order. The meshes' textures come with them.
 *   pick(mesh, model, bodypart)   which meshes of `from` to take (mesh.texture.name, mesh.numtris, model.name)
 *   where                         the submodel of `to` that receives them: { bodypart, model }
 *   move(p, boneName)             a nudge to a point in its bone's space, when the two bodies differ a little
 * Throws when `from` uses a bone `to` has no bone of that name for. Mind the limit of points in the receiving submodel.
 */
export function graft(to, from, pick, where = { bodypart: 0, model: 0 }, move = (p) => p) {
  const A = readMdl(to), B = readMdl(from), names = bones(from).map((b) => b.name);
  const numberIn = (i) => { const n = A.bones.indexOf(names[i]); if (n < 0) throw new Error(`graft: the target has no bone called ${names[i]}`); return n; };
  let mdl = to;
  for (const bp of B.bodyparts) for (const m of bp.models) for (const me of m.meshes) {
    if (!me.numtris || !me.texture || !pick(me, m, bp)) continue;
    const verts = [], vertBones = [], norms = [], normBones = [], vi = new Map(), ni = new Map();
    const index = (list, bn, map, v, b) => { const k = b + ":" + v.join(); if (!map.has(k)) { map.set(k, list.length); list.push(v); bn.push(b); } return map.get(k); };
    const tris = readMesh(from, m, me).map((t) => t.map((c) => { const b = numberIn(c.bone); return [index(verts, vertBones, vi, move(c.p, names[c.bone]), b), index(norms, normBones, ni, c.n, b), c.s, c.t]; }));
    const mesh = readMdl(mdl).bodyparts[where.bodypart].models[where.model].meshes.length;
    mdl = replaceMesh(addMesh(mdl, where), { ...where, mesh }, { bone: vertBones[0], verts, norms, vertBones, normBones, tris }, textureOf(from, me.texture.name));
  }
  return mdl;
}

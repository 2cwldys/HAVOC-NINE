// Working on a model by place: where a point is on the body, not where it is in a picture or which mesh holds it.
// Painting across texture seams, finding and taking off loose pieces, and moving a part from one model to another.
import { readMdl, readMesh, textureOf, replaceTexture, replaceMesh, addMesh, addModel, filterMesh, bones, bodyOf, apply34 } from "./mdl.mjs";
import { rgbaOf, indexed, masked } from "./image.mjs";
import { posed, label } from "./render.mjs";
import { sub, dot, cross, unit, box } from "./vec.mjs";
import { FRONT } from "./mesh.mjs";

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

// ── the islands of a picture ───────────────────────────────────────────────
const NONE = new Float64Array(0), uvKey = (c) => c.s + "," + c.t, pair = (a, b) => (a < b ? a + ";" + b : b + ";" + a), meshKey = (w) => `${w.bodypart}|${w.model}|${w.mesh}`;
/**
 * Every triangle that wears a texture (of the first skin family), with the island of that picture it belongs to: triangles
 * of one texture joined through an edge they share in the picture. Islands are numbered through the whole model, texture
 * after texture, in the order their first triangle comes in the file. Each triangle also gets its island's border within
 * its own mesh: the edges with one triangle of the picture on them (the same triangle twice, as a sheet seen from both
 * sides or two arms on the same pixels, counts once), five numbers an edge: u, v, u, v and 1 when the border is open (no
 * triangle of its submodel goes on across it in space) or 0 for a seam.
 */
function islandsOf(src) {
  const info = readMdl(src), all = [], by = new Map();
  info.bodyparts.forEach((bp, i) => bp.models.forEach((m, j) => m.meshes.forEach((me, k) => {
    const tex = info.textures.indexOf(me.texture); if (!me.numtris || tex < 0) return;
    const where = { bodypart: i, model: j, mesh: k }, list = readMesh(src, m, me).map((c, tri) => ({ where, tex, tri, c, uv: c.map(uvKey), q: c.map((x) => x.bone + ":" + x.p.join()) }));
    by.set(meshKey(where), list); for (const t of list) all.push(t);
  })));
  const tally = () => { const m = new Map(); return { add(k, t) { let s = m.get(k); if (!s) m.set(k, s = new Set()); s.add(t); }, n: (k) => m.get(k)?.size ?? 0 }; };
  const parent = all.map((_, n) => n), find = (n) => { while (parent[n] !== n) n = parent[n] = parent[parent[n]]; return n; }, first = new Map(), flat = tally(), solid = tally();
  all.forEach((t, n) => {
    const m = meshKey(t.where), part = `${t.where.bodypart}|${t.where.model}|`, tu = [...t.uv].sort().join("|"), tq = [...t.q].sort().join("|");
    for (let e = 0; e < 3; e++) {
      const edge = pair(t.uv[e], t.uv[(e + 1) % 3]), g = t.tex + "|" + edge;
      if (first.has(g)) parent[find(n)] = find(first.get(g)); else first.set(g, n);
      flat.add(m + "|" + edge, tu); solid.add(part + pair(t.q[e], t.q[(e + 1) % 3]), tq);
    }
  });
  const ids = new Map(), groups = new Map();
  for (const n of all.map((_, n) => n).sort((x, y) => all[x].tex - all[y].tex || x - y)) { const r = find(n); if (!ids.has(r)) ids.set(r, ids.size); all[n].island = ids.get(r); }
  for (const t of all) {
    const m = meshKey(t.where), part = `${t.where.bodypart}|${t.where.model}|`, g = m + "|" + t.island; if (!groups.has(g)) groups.set(g, { segs: [], at: new Map() });
    const G = t.group = groups.get(g);
    for (let e = 0; e < 3; e++) {
      const a = t.c[e], b = t.c[(e + 1) % 3], edge = pair(t.uv[e], t.uv[(e + 1) % 3]);
      if (t.uv[e] === t.uv[(e + 1) % 3] || flat.n(m + "|" + edge) !== 1) continue;
      const open = solid.n(part + pair(t.q[e], t.q[(e + 1) % 3])) === 1, o = G.at.get(edge);
      if (o === undefined) { G.at.set(edge, G.segs.length); G.segs.push(a.s, a.t, b.s, b.t, open ? 1 : 0); } else if (!open) G.segs[o + 4] = 0;
    }
  }
  for (const G of groups.values()) G.segs = Float64Array.from(G.segs);
  return { info, all, of: (t) => by.get(meshKey(t.where))?.[t.tri] };
}
/** How far a point of a picture is from the nearest edge of a border, and from the nearest open one: [pixels, pixels]. */
function borderAt(segs, u, v) {
  let any = Infinity, open = Infinity;
  for (let o = 0; o < segs.length; o += 5) {
    const x = segs[o], y = segs[o + 1], dx = segs[o + 2] - x, dy = segs[o + 3] - y, k = Math.max(0, Math.min(1, ((u - x) * dx + (v - y) * dy) / (dx * dx + dy * dy))), d = (u - x - dx * k) ** 2 + (v - y - dy * k) ** 2;
    if (d < any) any = d; if (segs[o + 4] && d < open) open = d;
  }
  return [Math.sqrt(any), Math.sqrt(open)];
}
/**
 * The islands of the model's pictures: the patches a texture is cut into, each a group of triangles joined through the
 * edges they share in the picture. A trunk's front, a sleeve, a boot's sole is usually one island. Returns { list, of }:
 *   list   [{ id, tex, tris, box: [x0, y0, x1, y1], uses: [{ bodypart, model, mesh, body, part, name, tris }], bones, mn, mx, mid, n, border, open }]
 *            box: in pixels of its texture; uses: the meshes that have triangles of it, `body` the body number that shows each;
 *            bones: the names of the bones it hangs on, the one that carries most of it first;
 *            mn, mx, mid: its place in model space as the model stands in `pose`, over every submodel that uses it;
 *            n: the way it faces on the whole (a unit vector: n[0] > 0.5 looks forwards);
 *            border: the length of its edge in pixels; open: how much of that has no triangle going on across it in space
 *            (a hem, an armhole, a neckline: the rest is seams, where the surface goes on in another island)
 *   of(t)  the id of the island a triangle belongs to, for a `t` with `where` and `tri`: what `posed` lists, what
 *          `dropTriangles` hands its rule and what `paint` hands its function
 * An id stays the same for as long as the file's meshes do: another picture, or a body added after the others, moves none.
 */
export function uvIslands(src, pose = {}) {
  const I = islandsOf(src), P = posed(src, pose).pose, list = [], r1 = (v) => +v.toFixed(1);
  for (const t of I.all) {
    const bp = I.info.bodyparts[t.where.bodypart], e = list[t.island] ??= { id: t.island, tex: I.info.textures[t.tex].name, tris: 0, box: [1e9, 1e9, -1e9, -1e9], uses: [], bones: new Map(), mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9], n: [0, 0, 0], groups: new Set() };
    let use = e.uses.find((x) => x.bodypart === t.where.bodypart && x.model === t.where.model && x.mesh === t.where.mesh);
    if (!use) e.uses.push(use = { ...t.where, body: t.where.model * bp.base, part: bp.name, name: bp.models[t.where.model].name, tris: 0 });
    use.tris++; e.tris++; e.groups.add(t.group);
    const p = t.c.map((c) => apply34(P[c.bone], c.p)), face = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    for (let a = 0; a < 3; a++) e.n[a] += face[a] * FRONT;
    t.c.forEach((c, k) => {
      e.box = [Math.min(e.box[0], c.s), Math.min(e.box[1], c.t), Math.max(e.box[2], c.s), Math.max(e.box[3], c.t)]; e.bones.set(c.bone, (e.bones.get(c.bone) ?? 0) + 1);
      for (let a = 0; a < 3; a++) { e.mn[a] = Math.min(e.mn[a], p[k][a]); e.mx[a] = Math.max(e.mx[a], p[k][a]); }
    });
  }
  const length = (groups, open) => Math.round(Math.max(...[...groups].map(({ segs }) => { let l = 0; for (let o = 0; o < segs.length; o += 5) if (!open || segs[o + 4]) l += Math.hypot(segs[o + 2] - segs[o], segs[o + 3] - segs[o + 1]); return l; })));
  return {
    list: list.map(({ groups, ...e }) => ({ ...e, bones: [...e.bones].sort((x, y) => y[1] - x[1]).map(([b]) => I.info.bones[b]), mn: e.mn.map(r1), mx: e.mx.map(r1), mid: e.mn.map((v, a) => r1((v + e.mx[a]) / 2)), n: unit(e.n).map((v) => +v.toFixed(2)), border: length(groups, false), open: length(groups, true) })),
    of: (t) => I.of(t)?.island,
  };
}
/**
 * One of the model's textures, enlarged and greyed, with each of its islands tinted and numbered: the picture to choose
 * islands from. An open border (a hem, an armhole) is drawn white, a seam in the island's own colour. `which`: the
 * texture's number or name; `body`: only the islands the submodels of that body number use (every submodel's unless told).
 * Returns the picture with `scale`, `texture` and `islands` (the ids drawn).
 */
export function islandMap(src, which, { scale, body } = {}) {
  const I = islandsOf(src), info = I.info, n = typeof which === "number" ? which : info.textures.findIndex((x) => x.name.toLowerCase() === String(which).toLowerCase()), t = info.textures[n];
  if (!t) throw new Error(`no texture ${which}`);
  const k = scale ?? Math.max(1, Math.min(8, Math.floor(1024 / Math.max(t.width, t.height)))), W = t.width * k, Hh = t.height * k, img = { width: W, height: Hh, rgba: new Uint8Array(W * Hh * 4) }, size = t.width * t.height;
  const pixels = src.subarray(t.index, t.index + size), palette = src.subarray(t.index + size, t.index + size + 768), shown = body === undefined ? null : bodyOf(src, body);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const p = pixels[Math.floor(y / k) * t.width + Math.floor(x / k)], g = Math.round(24 + 0.45 * (palette[p * 3] + palette[p * 3 + 1] + palette[p * 3 + 2]) / 3); img.rgba.set([g, g, g, 255], (y * W + x) * 4); }
  const ink = (id) => { const h = (id * 0.618034) % 1 * 6, f = h - Math.floor(h); return [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][Math.floor(h)].map((v) => Math.round(255 * (0.25 + 0.75 * v))); };
  const mine = I.all.filter((x) => x.tex === n && (!shown || shown[x.where.bodypart] === x.where.model)), marks = new Map(), groups = new Set(), tinted = new Uint8Array(W * Hh);
  for (const x of mine) {
    const [a, b, c] = x.c.map((q) => [q.s * k, q.t * k]), det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]), col = ink(x.island), m = marks.get(x.island) ?? { area: -1, tris: 0, col, lo: [1e9, 1e9], hi: [-1e9, -1e9] }; groups.add(x.group);
    marks.set(x.island, m); m.tris++; for (const q of [a, b, c]) for (let j = 0; j < 2; j++) { m.lo[j] = Math.min(m.lo[j], q[j]); m.hi[j] = Math.max(m.hi[j], q[j]); }
    if (Math.abs(det) > m.area) Object.assign(m, { area: Math.abs(det), x: (a[0] + b[0] + c[0]) / 3, y: (a[1] + b[1] + c[1]) / 3 });
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0]))), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(Hh - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const u = px + 0.5, v = py + 0.5, wb = ((u - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (v - a[1])) / det, wc = ((b[0] - a[0]) * (v - a[1]) - (u - a[0]) * (b[1] - a[1])) / det, o = py * W + px;
      if (wb < 0 || wc < 0 || wb + wc > 1 || tinted[o]) continue;            // a dot is tinted once, however many triangles lie on it
      tinted[o] = 1; for (let j = 0; j < 3; j++) img.rgba[o * 4 + j] = Math.round(img.rgba[o * 4 + j] * 0.5 + col[j] * 0.5);
    }
  }
  const line = (a, b, c) => { const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])))); for (let i = 0; i <= steps; i++) { const x = Math.round(a[0] + (b[0] - a[0]) * i / steps), y = Math.round(a[1] + (b[1] - a[1]) * i / steps); if (x >= 0 && y >= 0 && x < W && y < Hh) img.rgba.set(c, (y * W + x) * 4); } };
  for (const x of mine) if (groups.delete(x.group)) for (let o = 0, s = x.group.segs; o < s.length; o += 5) line([s[o] * k, s[o + 1] * k], [s[o + 2] * k, s[o + 3] * k], s[o + 4] ? [255, 255, 255, 255] : [...ink(x.island), 255]);
  // the numbers, a large island's after a small one's so that it lies over it
  for (const [id, m] of [...marks].sort((x, y) => x[1].tris - y[1].tris)) { const text = String(id), dots = Math.min(m.hi[0] - m.lo[0], m.hi[1] - m.lo[1]) > 60 ? 2 : 1; label(img, text, Math.round(m.x - text.length * 2 * dots), Math.round(m.y - 2.5 * dots), dots, m.col.map((v) => Math.min(255, v + 70))); }
  return { ...img, scale: k, texture: t, islands: [...marks.keys()].sort((x, y) => x - y) };
}

/**
 * Paints the model by place. `fn` is called for every pixel of every texture that some triangle wears, with the point of the
 * body it colours, and returns the new colour, or nothing to leave it. A mark made at one place of the body so crosses from
 * one texture to the next without a seam. It is handed one object:
 *   p, n       the point (model space, as the model stands in `pose`) and the way the surface faces there
 *   rgb        the colour there now, 0 to 1 (in a later pass: as the passes before left it)
 *   tex        the texture's name; u, v: where in it, in pixels from its top left (the middle of the pixel, or the point
 *              inside it that is asked about when `soft` is set)
 *   bone, boneIndex   the bone the point follows (the nearest corner's), by name and by number
 *   where, body, tri  its mesh ({ bodypart, model, mesh }), the body number that shows that submodel, and the triangle's
 *              number in the mesh (as `readMesh` lists them)
 *   island     the island of the picture the triangle belongs to (see `uvIslands`)
 *   edge, open how far the pixel is from its island's border, and from the nearest open stretch of it (a hem, an armhole:
 *              no triangle goes on across it in space; Infinity when the island has none), both in pixels
 *   per        units of the model a pixel covers here: `edge * per` is the distance in units, near enough
 *   at(u, v)   the colour of this texture at another pixel, as it stood before this pass
 *   blur(r)    that picture smoothed about this pixel over `r` pixels, taking only pixels of this island: its broad light
 *              and shade without its fine detail, and nothing of a neighbour on the picture
 * Options:
 *   only       the names of the textures to paint (all of them unless told)
 *   islands    the ids of the islands to paint (all of them unless told): the others' triangles are not there for this call
 *   pose       as `posed` takes it
 *   soft       2, 3, 4...: `fn` is asked at that many points each way inside every pixel and the answers are averaged, so
 *              that the edge of any shape comes out soft instead of as a staircase (1, the default: once, at its middle)
 * Several passes in one call: give a list in place of `fn`, each a function or { fn, only, islands, pose, soft, apart } (what
 * a pass leaves out is taken from the options). Each pass sees what the one before left, in full colour.
 * Each painted texture is cut back to 256 colours, once, after the last pass, and put back in its place at its own size; a
 * masked one keeps its holes. Returns { mdl, shared }: `shared[name]` is the share of that texture's painted pixels worn by
 * two places of the body more than `apart` (3) units from each other. Models often give the left and right arm or leg the
 * same pixels: what is painted on one side then shows on the other, and nothing short of laying the texture out again
 * changes that.
 */
export function paint(src, fn, options = {}) {
  const I = islandsOf(src), work = new Map(), stands = new Map(), kernels = new Map();
  for (const one of Array.isArray(fn) ? fn : [fn]) {
    const pass = typeof one === "function" ? { fn: one } : one, opt = (k, d) => pass[k] ?? options[k] ?? d;
    const pose = opt("pose", {}), only = opt("only", null), apart = opt("apart", 3), soft = Math.max(1, Math.round(opt("soft", 1))), want = opt("islands", null) && new Set(opt("islands", null));
    const stand = JSON.stringify(pose); if (!stands.has(stand)) stands.set(stand, posed(src, pose));
    const { info, tris } = stands.get(stand);
    info.textures.forEach((t, ti) => {
      if (only && !only.includes(t.name)) return;
      const mine = tris.filter((x) => x.tex === t && (!want || want.has(I.of(x)?.island))); if (!mine.length) return;
      if (!work.has(ti)) { const tex = textureOf(src, t.name), holes = Boolean(t.flags & 64), size = tex.width * tex.height; work.set(ti, { t, w: tex.width, h: tex.height, holes, rgba: rgbaOf(tex, holes), worn: new Uint8Array(size), place: new Float32Array(size * 3), twice: 0, once: 0, changed: false }); }
      const st = work.get(ti), { w, h, holes } = st, was = st.rgba, rgba = Uint8Array.from(was), done = new Uint8Array(w * h), at = new Float32Array(w * h * 3), dot3 = (i) => [was[i * 4] / 255, was[i * 4 + 1] / 255, was[i * 4 + 2] / 255];
      const wrap = (u, v) => (((Math.floor(v) % h) + h) % h) * w + (((Math.floor(u) % w) + w) % w);
      // which island lies on each pixel, and the picture smoothed within one: made only when a function asks
      let cover = null, last = null;
      const covered = () => {
        if (cover) return cover; cover = new Int32Array(w * h).fill(-1);
        for (const x of mine) {
          const [a, b, c] = x.c, det = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v), id = I.of(x)?.island ?? -2; if (Math.abs(det) < 1e-6) continue;
          for (let py = Math.floor(Math.min(a.v, b.v, c.v)); py <= Math.ceil(Math.max(a.v, b.v, c.v)); py++) for (let px = Math.floor(Math.min(a.u, b.u, c.u)); px <= Math.ceil(Math.max(a.u, b.u, c.u)); px++) {
            const u = px + 0.5, v = py + 0.5, wb = ((u - a.u) * (c.v - a.v) - (c.u - a.u) * (v - a.v)) / det, wc = ((b.u - a.u) * (v - a.v) - (u - a.u) * (b.v - a.v)) / det;
            if (wb >= 0 && wc >= 0 && wb + wc <= 1) cover[wrap(px, py)] = id;
          }
        }
        return cover;
      };
      const blur = (i, id, r) => {
        if (last && last.i === i && last.r === r && last.id === id) return last.rgb.slice();
        const C = covered(), R = Math.max(1, Math.ceil(r)), px = i % w, py = (i - px) / w, sum = [0, 0, 0]; let K = kernels.get(r), all = 0;
        if (!K) { K = new Float32Array((2 * R + 1) ** 2); for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) K[(y + R) * (2 * R + 1) + x + R] = x * x + y * y > R * R ? 0 : Math.exp(-(x * x + y * y) / (0.5 * R * R)); kernels.set(r, K); }
        for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
          const k = K[(y + R) * (2 * R + 1) + x + R], j = wrap(px + x, py + y); if (!k || C[j] !== id || (holes && was[j * 4 + 3] < 128)) continue;
          all += k; for (let q = 0; q < 3; q++) sum[q] += was[j * 4 + q] * k;
        }
        last = { i, r, id, rgb: all ? sum.map((v) => v / all / 255) : dot3(i) }; return last.rgb.slice();
      };
      for (const x of mine) {
        const [a, b, c] = x.c, det = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
        if (Math.abs(det) < 1e-6) continue;
        const x0 = Math.floor(Math.min(a.u, b.u, c.u)) - 1, x1 = Math.ceil(Math.max(a.u, b.u, c.u)) + 1, y0 = Math.floor(Math.min(a.v, b.v, c.v)) - 1, y1 = Math.ceil(Math.max(a.v, b.v, c.v)) + 1;
        const slack = 1.2 / Math.sqrt(Math.abs(det));           // about a pixel past each edge, so that seams are covered
        const mesh = I.of(x), island = mesh?.island ?? null, segs = mesh?.group.segs ?? NONE, per = Math.sqrt(Math.hypot(...cross(sub(b.p, a.p), sub(c.p, a.p))) / Math.abs(det)), body = x.where.model * info.bodyparts[x.where.bodypart].base;
        const ask = (i, u, v, wa, wb, wc, p, n) => {
          const near = wa >= wb && wa >= wc ? a : wb >= wc ? b : c; let far = null; const border = () => (far ??= borderAt(segs, u, v));
          return pass.fn({ p, n, rgb: dot3(i), tex: t.name, u, v, bone: info.bones[near.bone], boneIndex: near.bone, where: x.where, body, tri: x.tri, island, per, get edge() { return border()[0]; }, get open() { return border()[1]; }, at: (s, q) => dot3(wrap(s, q)), blur: (r) => blur(i, island ?? -2, r) });
        };
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const u = px + 0.5, v = py + 0.5;
          const wb = ((u - a.u) * (c.v - a.v) - (c.u - a.u) * (v - a.v)) / det, wc = ((b.u - a.u) * (v - a.v) - (u - a.u) * (b.v - a.v)) / det, wa = 1 - wb - wc;
          if (wa < -slack || wb < -slack || wc < -slack) continue;
          const inside = wa >= 0 && wb >= 0 && wc >= 0, i = (((py % h) + h) % h) * w + (((px % w) + w) % w);
          const p = [0, 1, 2].map((k) => a.p[k] * wa + b.p[k] * wb + c.p[k] * wc);
          if (done[i]) {
            if (!inside) continue;
            if (done[i] === 2 && Math.hypot(p[0] - at[i * 3], p[1] - at[i * 3 + 1], p[2] - at[i * 3 + 2]) > apart) { done[i] = 3; if (!(st.worn[i] & 2)) { st.worn[i] |= 2; st.twice++; } }      // counted once, however many wear it
            if (done[i] >= 2) continue;                    // a pixel first reached only by the margin of a triangle is painted again by the one it lies in
          }
          if (inside) {
            if (!(st.worn[i] & 1)) { st.worn[i] |= 1; st.once++; st.place.set(p, i * 3); }
            else if (!(st.worn[i] & 2) && Math.hypot(p[0] - st.place[i * 3], p[1] - st.place[i * 3 + 1], p[2] - st.place[i * 3 + 2]) > apart) { st.worn[i] |= 2; st.twice++; }      // worn by another place in a pass before
          }
          done[i] = inside ? 2 : 1; at.set(p, i * 3);
          if (holes && was[i * 4 + 3] < 128) continue;
          const n = unit([0, 1, 2].map((k) => a.n[k] * wa + b.n[k] * wb + c.n[k] * wc));
          let out;
          if (soft === 1) out = ask(i, u, v, wa, wb, wc, p, n);
          else {
            // asked at soft x soft points of the pixel; a point that is left alone keeps the colour it had
            const sum = [0, 0, 0], had = dot3(i); let any = false;
            for (let sy = 0; sy < soft; sy++) for (let sx = 0; sx < soft; sx++) {
              const su = px + (sx + 0.5) / soft, sv = py + (sy + 0.5) / soft, qb = ((su - a.u) * (c.v - a.v) - (c.u - a.u) * (sv - a.v)) / det, qc = ((b.u - a.u) * (sv - a.v) - (su - a.u) * (b.v - a.v)) / det, qa = 1 - qb - qc;
              const o = ask(i, su, sv, qa, qb, qc, [0, 1, 2].map((k) => a.p[k] * qa + b.p[k] * qb + c.p[k] * qc), unit([0, 1, 2].map((k) => a.n[k] * qa + b.n[k] * qb + c.n[k] * qc)));
              if (o) any = true; for (let k = 0; k < 3; k++) sum[k] += clamp((o || had)[k]);
            }
            if (any) out = sum.map((s) => s / (soft * soft));
          }
          if (out) { st.changed = true; for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(clamp(out[k]) * 255); }
        }
      }
      st.rgba = rgba;
    });
  }
  let mdl = src; const shared = {};
  for (const ti of [...work.keys()].sort((x, y) => x - y)) {
    const { t, w, h, holes, rgba, twice, once, changed } = work.get(ti);
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
 *   list   [{ id, tex, part, model, where, tris (how many), mn, mx, mid }] in model space, as the model stands in `pose`
 *          (`where`: its mesh, { bodypart, model, mesh }; every submodel's pieces are listed, whatever body `pose` names)
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
      list.push({ id, tex: m.tex, part: m.part, model: m.model, where: m.where, tris: g.length, mn: b.mn.map(r1), mx: b.mx.map(r1), mid: b.mn.map((v, a) => r1((v + b.mx[a]) / 2)) });
      for (const t of g) by.set(`${m.where.bodypart}|${m.where.model}|${m.where.mesh}|${t.map(keyOf).join("|")}`, id);
    }
  }
  return { list, of: (t) => by.get(`${t.where.bodypart}|${t.where.model}|${t.where.mesh}|${t.p.map(keyOf).join("|")}`) };
}

/**
 * A copy of the model without the triangles `drop` accepts. It is given { p: [three points], mid, tex, part, model, where, tri }
 * in model space, as the model stands in `pose` (`tri`: the triangle's number in its mesh). Points, normals, bones, animations
 * and the other triangles stay as they are (`filterMesh` does the cutting). Returns { mdl, gone }.
 *   const P = pieces(src); dropTriangles(src, (t) => [59, 36].includes(P.of(t)))     // two pieces off
 *   dropTriangles(src, (t) => t.mid[2] > 60)                                          // everything above a height
 *   const I = uvIslands(src); dropTriangles(src, (t) => I.of(t) === 4)                // one island of a picture off
 */
export function dropTriangles(src, drop, pose = {}) {
  let mdl = src, gone = 0;
  for (const m of meshes(src, pose)) {
    let at = 0, cut = 0;
    const next = filterMesh(mdl, m.where, () => { const tri = at, p = m.tris[at++], d = drop({ p, mid: [0, 1, 2].map((a) => (p[0][a] + p[1][a] + p[2][a]) / 3), tex: m.tex, part: m.part, model: m.model, where: m.where, tri }); if (d) cut++; return !d; });
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

/**
 * A body again, as a new body, wearing another texture: the way a game adds an armour or a team's colours to a model
 * (the same shape, point for point, on the same bones, under a new name and number). Returns the model with the new
 * submodel after the others of its bodypart: its body number is that bodypart's old count of submodels times its `base`.
 *   body      the body to copy: its submodel's name, or the body number that shows it
 *   name      the new submodel's name
 *   texture   what it wears: the name of a texture already in the file, or a new one, as a texture ({ name, width, height,
 *             pixels, palette, flags }) or as an image with a name ({ name, width, height, rgb }: cut to 256 colours here).
 *             Of another size than the one it replaces, the corners are moved to the same place in it
 *   instead   the name of the texture of the old body that the new one takes the place of. Needed only when the body
 *             wears several: its other meshes are copied wearing what they wore
 *   bodypart  for a body number: which bodypart's submodel is meant (the first unless told)
 * In a model of several bodyparts add to the last one only: the body numbers of the bodyparts after it are counted from
 * how many submodels it has. Mind the engine's count of submodels (`check` tells).
 */
export function copyBody(src, body, name, texture, { instead = null, bodypart = 0 } = {}) {
  const info = readMdl(src); let bp = bodypart, j;
  if (typeof body === "number") j = bodyOf(src, body)[bp];
  else { bp = info.bodyparts.findIndex((x) => x.models.some((m) => m.name.toLowerCase() === String(body).toLowerCase())); j = bp < 0 ? -1 : info.bodyparts[bp].models.findIndex((m) => m.name.toLowerCase() === String(body).toLowerCase()); }
  const from = info.bodyparts[bp]?.models[j], full = from?.meshes.filter((me) => me.numtris) ?? [];
  if (!from) throw new Error(`copyBody: no body ${body}: it has ${info.bodyparts.map((x) => x.models.map((m, k) => `${k * x.base}=${m.name}`).join(" ")).join("; ")}`);
  if (!full.length) throw new Error(`copyBody: the body ${from.name} is empty`);
  if (full.some((me) => !me.texture)) throw new Error("copyBody: the model's textures are in another file: put them inside with withTextures first");
  const worn = [...new Set(full.map((me) => me.texture.name))], old = instead ?? (worn.length === 1 ? worn[0] : null);
  if (!worn.includes(old)) throw new Error(`copyBody: the body ${from.name} wears ${worn.join(", ")}: say which the new texture takes the place of with { instead: name }`);
  const tex = typeof texture === "string" ? textureOf(src, texture) : texture.pixels ? texture : indexed(texture, texture.name);
  if (!tex.name) throw new Error("copyBody: the texture needs a name");
  const n = info.bodyparts[bp].models.length; let mdl = addModel(src, bp, name);
  full.forEach((me, k) => {
    const verts = [], vertBones = [], norms = [], normBones = [], vi = new Map(), ni = new Map(), mine = me.texture.name === old, kx = mine ? tex.width / me.texture.width : 1, ky = mine ? tex.height / me.texture.height : 1;
    const index = (list, bn, map, v, b) => { const q = b + ":" + v.join(); if (!map.has(q)) { map.set(q, list.length); list.push(v); bn.push(b); } return map.get(q); };
    const tris = readMesh(src, from, me).map((t) => t.map((c) => [index(verts, vertBones, vi, c.p, c.bone), index(norms, normBones, ni, c.n, c.bone), Math.round(c.s * kx), Math.round(c.t * ky)]));
    if (k) mdl = addMesh(mdl, { bodypart: bp, model: n });
    mdl = replaceMesh(mdl, { bodypart: bp, model: n, mesh: k }, { bone: vertBones[0], verts, norms, vertBones, normBones, tris }, mine ? tex : textureOf(src, me.texture.name));
  });
  return mdl;
}

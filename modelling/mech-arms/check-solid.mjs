// A check that a Mech arm model has no hole in it: no open edge, no face wound against its neighbour, no part wound inside
// out, nowhere a ray from outside meets the inside of the model first. The engine draws only the front of a triangle, so a
// surface that is missing, wound the wrong way or left open at an end shows the background, or another part, through the model.
//
//   node check-solid.mjs <model.mdl> [<model.mdl> ...] [--full] [--world]      exit status 1 when any model fails
//   --world: a model that is not seen from the eye (w_mechminigun.mdl): the first-person camera is left out
//
// Stages (all in SMAK's reading of the file, which draws a triangle as the engine does: clockwise seen from outside):
//   textures    no picture flag that makes part of a surface a hole or a glow (masked 64, additive 32, alpha 16).
//   open edges  every edge belongs to two triangles, at the idle pose: a part is closed on its own, however the parts around
//               it overlap. An open end is exactly what lets a ray in. Edges are matched by position, to 1/512 of a unit.
//   twisted     the two triangles of an edge run along it in opposite directions: a face wound against its neighbour is not.
//   parts       every piece of connected surface (joined by edges) is wound outward (its volume, counted with the engine's
//               winding, is positive) and hangs from one bone, so no animation can tear it open.
//   normals     the stored normals agree with the winding on 95 percent of every mesh's triangles (audit-holes.mjs's test).
//   rays        an item buffer: at every pixel the nearest surface of any facing against the nearest front-facing one. A pixel
//               whose nearest surface is a back face looks into the model: nothing front-facing behind it shows the background
//               (see-through), something behind it shows another surface (a layer). Cameras: the game's first-person camera
//               (eye at the origin, 90 degrees across, and 110 and 120 for players who widen it) at every frame of every
//               animation; a sphere of outside cameras at the idle pose; a coarser sphere at every 15th frame of every
//               animation (every 3rd with --full).
//
// What it cannot see: a gap between two separate closed parts (a slit between a plate and the arm is a view through empty
// space, not through a surface: it cannot be told from a gap meant to be there, as between the barrels); a hole smaller than
// a pixel of the cameras above (the open-edge, twisted and part tests have no such limit, for what they cover); the engine's
// own clipping and lighting; a model whose animation bends a part between bones (the part test refuses one).
//
// sameGeometry() says whether two files differ only in their picture: the three side sets of a weapon must.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { K } from "./common.mjs";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const FLAG_NAMES = { 16: "alpha", 32: "additive", 64: "masked" };
const POSITION_STEP = 512;               // edges and corners are matched to 1/512 of a unit
const AGREE_LOW = 95;                    // percent of a mesh's triangles whose winding must agree with the stored normals
const EPS = 2e-4;                        // two depths this near (relative) are one surface
const FIRST_PERSON_FOVS = [90, 110, 120];

// -- the cameras --------------------------------------------------------------------------------------------------------

/** A perspective camera: where it stands, what it looks at, the field of view across the picture, the picture's size. */
function camera({ eye, at, fov = 40, w = 640, h = 480, near = 1 }) {
  const forward = unit(sub(at, eye));
  let right = cross(forward, [0, 0, 1]);
  if (Math.hypot(...right) < 1e-6) right = cross(forward, [1, 0, 0]);
  right = unit(right);
  return { eye, forward, right, up: cross(right, forward), f: w / 2 / Math.tan((fov * Math.PI) / 360), w, h, near };
}
/** The game's first-person camera: the eye at the origin looking along +x, `fov` degrees across. */
const firstPerson = (fov = 90, w = 640, h = 480) => camera({ eye: [0, 0, 0], at: [1, 0, 0], fov, w, h });

/** Cameras on a sphere round a box: azimuths in `az` degrees, elevations in `el`, and both poles. */
function sphere(box, az, el, fov = 35, w = 480, h = 360) {
  const mid = box.mn.map((v, a) => (v + box.mx[a]) / 2);
  const reach = Math.hypot(...box.mx.map((v, a) => v - mid[a]));
  const dist = (reach * 1.15) / Math.sin((fov * Math.PI) / 360);
  const dirs = [];
  for (const e of el) for (const a of az) dirs.push([a, e]);
  dirs.push([0, 90], [0, -90]);
  return dirs.map(([a, e]) => {
    const ar = (a * Math.PI) / 180, er = (e * Math.PI) / 180;
    const eye = [mid[0] + dist * Math.cos(er) * Math.cos(ar), mid[1] + dist * Math.cos(er) * Math.sin(ar), mid[2] + dist * Math.sin(er)];
    return { label: `az ${a} el ${e}`, cam: camera({ eye, at: mid, fov, w, h }) };
  });
}
const range = (from, to, step) => { const out = []; for (let v = from; v <= to; v += step) out.push(v); return out; };

// -- the item buffer ----------------------------------------------------------------------------------------------------

/** The nearest triangle of any facing, and the nearest front-facing one, at every pixel's middle. */
function raster(tris, cam) {
  const { w, h, f } = cam;
  const n = w * h;
  const anyId = new Int32Array(n).fill(-1), frontId = new Int32Array(n).fill(-1);
  const anyZ = new Float32Array(n).fill(Infinity), frontZ = new Float32Array(n).fill(Infinity);
  for (let id = 0; id < tris.length; id++) {
    const t = tris[id];
    const nrm = cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]));
    if (Math.hypot(...nrm) < 1e-12) continue;
    // clockwise seen from the eye is the front: (b - a) x (c - a) points away from it
    const isFront = dot(nrm, sub(cam.eye, t.p[0])) < 0;
    const cs = t.p.map((p) => { const d = sub(p, cam.eye); return [dot(d, cam.right), dot(d, cam.up), dot(d, cam.forward)]; });
    const cut = [];
    cs.forEach((a, i) => {
      const b = cs[(i + 1) % 3];
      if (a[2] >= cam.near) cut.push(a);
      if ((a[2] >= cam.near) !== (b[2] >= cam.near)) {
        const k = (cam.near - a[2]) / (b[2] - a[2]);
        cut.push(a.map((v, j) => v + (b[j] - v) * k));
      }
    });
    if (cut.length < 3) continue;
    const s = cut.map(([x, y, z]) => ({ x: w / 2 + (x * f) / z, y: h / 2 - (y * f) / z, w: 1 / z }));
    for (let i = 1; i + 1 < s.length; i++) {
      const a = s[0], b = s[i], c = s[i + 1];
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const wa = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
          const wb = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
          const wc = 1 - wa - wb;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          const z = 1 / (wa * a.w + wb * b.w + wc * c.w);
          const k = y * w + x;
          if (z < anyZ[k]) { anyZ[k] = z; anyId[k] = id; }
          if (isFront && z < frontZ[k]) { frontZ[k] = z; frontId[k] = id; }
        }
    }
  }
  return { w, h, anyId, anyZ, frontId, frontZ };
}

/** The pixels that look into the model: the nearest surface is a back face. */
function lookIn(buf) {
  let silhouette = 0, see = 0, layer = 0;
  const blame = new Map();
  for (let k = 0; k < buf.w * buf.h; k++) {
    if (buf.anyId[k] < 0) continue;
    silhouette++;
    if (buf.frontId[k] >= 0 && buf.frontZ[k] <= buf.anyZ[k] * (1 + EPS) + EPS) continue;
    if (buf.frontId[k] < 0) see++; else layer++;
    blame.set(buf.anyId[k], (blame.get(buf.anyId[k]) ?? 0) + 1);
  }
  return { silhouette, see, layer, blame };
}

// -- the model's triangles ----------------------------------------------------------------------------------------------

/** Every triangle as the engine draws it in a pose, in model space, with the bone of each corner. */
function trianglesAt(mdl, seq, frame) {
  return K.posed(mdl, { seq, frame }).tris.map((t) => ({ p: t.c.map((c) => c.p), bones: t.c.map((c) => c.bone), mesh: t.where }));
}
const keyOf = (p) => p.map((v) => Math.round(v * POSITION_STEP)).join(",");
const describe = (p) => p.map((v) => v.toFixed(2)).join(" ");

/** The edges by position: how many triangles run along each, and in which direction each runs. */
function edgesOf(tris) {
  const edges = new Map();
  for (const t of tris) for (let i = 0; i < 3; i++) {
    const a = keyOf(t.p[i]), b = keyOf(t.p[(i + 1) % 3]);
    if (a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const e = edges.get(k) ?? { n: 0, same: 0, forward: 0, p: [t.p[i], t.p[(i + 1) % 3]] };
    e.n++;
    e.forward += a < b ? 1 : -1;
    edges.set(k, e);
  }
  return edges;
}

/** Pieces of surface joined by shared edges: for each, its triangles, its bones and its volume as the engine's winding counts it. */
function piecesOf(tris) {
  const parent = tris.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const owner = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = keyOf(t.p[k]), b = keyOf(t.p[(k + 1) % 3]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (owner.has(key)) parent[find(i)] = find(owner.get(key)); else owner.set(key, i);
    }
  });
  const groups = new Map();
  tris.forEach((t, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))).push(t));
  return [...groups.values()].map((list) => {
    // the engine's front is clockwise seen from outside, so the outward normal is minus (b - a) x (c - a)
    let volume = 0;
    const bones = new Set();
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const t of list) {
      volume -= dot(t.p[0], cross(t.p[1], t.p[2])) / 6;
      t.bones.forEach((b) => bones.add(b));
      for (const p of t.p) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
    }
    return { triangles: list.length, volume, bones: [...bones], mn, mx };
  });
}

function boxOf(tris) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const t of tris) for (const p of t.p) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
  return { mn, mx };
}

// -- the check ----------------------------------------------------------------------------------------------------------

/**
 * `{ errors, notes }` for a model's bytes. `full`: the thorough rays (every 3rd frame, a finer sphere); `viewmodel` false for a model
 * that is not seen from the eye (a world model): the first-person camera is left out; `log`: a function for progress lines.
 */
export function solidity(mdl, { full = false, viewmodel = true, log = () => {} } = {}) {
  const errors = [], notes = [];
  const md = K.readMdl(mdl);
  const boneNames = K.bones(mdl).map((b) => b.name);

  // textures
  for (const tex of md.textures) {
    const bad = Object.entries(FLAG_NAMES).filter(([bit]) => tex.flags & Number(bit)).map(([, name]) => name);
    if (bad.length) errors.push(`texture ${tex.name} is drawn ${bad.join(" and ")} (flags ${tex.flags}): part of a surface is a hole or a glow`);
  }
  notes.push(`textures ${md.textures.length}, flags ${md.textures.map((t) => t.flags).join(",")}`);

  // open and twisted edges, at the idle pose
  const idle = trianglesAt(mdl, 0, 0);
  const edges = edgesOf(idle);
  const open = [...edges.values()].filter((e) => e.n === 1);
  const twisted = [...edges.values()].filter((e) => e.n === 2 && e.forward !== 0);
  const over = [...edges.values()].filter((e) => e.n > 2).length;
  if (open.length) {
    // loops of open edges, joined at their end points, the longest first
    const at = new Map();
    open.forEach((e, i) => e.p.forEach((p) => { const k = keyOf(p); (at.get(k) ?? at.set(k, []).get(k)).push(i); }));
    const seen = new Set(), loops = [];
    open.forEach((_, i) => {
      if (seen.has(i)) return;
      const stack = [i], members = [];
      seen.add(i);
      while (stack.length) {
        const j = stack.pop();
        members.push(j);
        for (const p of open[j].p) for (const q of at.get(keyOf(p))) if (!seen.has(q)) { seen.add(q); stack.push(q); }
      }
      loops.push(members);
    });
    const rows = loops.map((m) => {
      const pts = m.flatMap((i) => open[i].p);
      const mn = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), mx = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
      return { n: m.length, mn, mx, len: m.reduce((s, i) => s + Math.hypot(...sub(open[i].p[0], open[i].p[1])), 0) };
    }).sort((a, b) => b.len - a.len);
    errors.push(`${open.length} open edges in ${loops.length} loops (a ray can enter there)`);
    for (const r of rows.slice(0, 12)) errors.push(`  open loop of ${r.n} edges, from ${describe(r.mn)} to ${describe(r.mx)}`);
  }
  if (twisted.length) {
    errors.push(`${twisted.length} edges are run the same way by both their triangles (a face is wound against its neighbour)`);
    for (const e of twisted.slice(0, 8)) errors.push(`  twisted edge from ${describe(e.p[0])} to ${describe(e.p[1])}`);
  }
  if (over) notes.push(`${over} edges are shared by more than two triangles`);
  notes.push(`${idle.length} triangles, ${edges.size} edges, ${open.length} open, ${twisted.length} twisted`);

  // pieces
  const pieces = piecesOf(idle);
  pieces.forEach((p) => {
    if (open.length === 0 && p.volume <= 0) errors.push(`a piece of ${p.triangles} triangles at ${describe(p.mn)} to ${describe(p.mx)} is wound inside out (volume ${p.volume.toFixed(3)})`);
    if (p.bones.length > 1) errors.push(`a piece of ${p.triangles} triangles at ${describe(p.mn)} to ${describe(p.mx)} hangs from bones ${p.bones.map((b) => boneNames[b]).join(", ")}: an animation can tear it open`);
  });
  notes.push(`${pieces.length} pieces, smallest volume ${Math.min(...pieces.map((p) => p.volume)).toFixed(4)}`);

  // normals against winding, per mesh
  const pose = K.poseAt(mdl, 0, 0);
  md.bodyparts.forEach((bp, bi) => bp.models.forEach((mo, mi) => mo.meshes.forEach((me, k) => {
    let n = 0, agree = 0;
    for (const t of K.readMesh(mdl, mo, me)) {
      const w = t.map((c) => K.apply34(pose[c.bone], c.p));
      const nr = [0, 0, 0];
      for (const c of t) for (let r = 0; r < 3; r++) nr[r] += dot(pose[c.bone][r], c.n);
      const out = cross(sub(w[1], w[0]), sub(w[2], w[0])).map((v) => -v);
      if (Math.hypot(...out) < 1e-9 || Math.hypot(...nr) < 1e-9) continue;
      n++;
      if (dot(out, nr) > 0) agree++;
    }
    const share = n ? Math.round((100 * agree) / n) : 100;
    if (share < AGREE_LOW) errors.push(`mesh ${bi}.${mi}.${k} (${bp.name}): the winding agrees with the stored normals on ${share}% of ${n} triangles`);
  })));

  // rays
  const seqs = K.sequences(mdl);
  const worst = { see: 0, layer: 0, label: "" };
  const total = { views: 0, see: 0, layer: 0 };
  const blamed = new Map();
  const view = (label, cam, tris) => {
    const r = lookIn(raster(tris, cam));
    total.views++;
    total.see += r.see;
    total.layer += r.layer;
    if (r.see + r.layer > worst.see + worst.layer) { worst.see = r.see; worst.layer = r.layer; worst.label = label; }
    for (const [id, n] of r.blame) {
      const t = tris[id];
      const where = `${boneNames[t.bones[0]]} near ${describe(t.p[0])}`;
      blamed.set(where, (blamed.get(where) ?? 0) + n);
    }
  };
  let frames = 0;
  if (viewmodel) for (let s = 0; s < seqs.length; s++) for (let f = 0; f < seqs[s].frames; f++) {
    const tris = trianglesAt(mdl, s, f);
    frames++;
    for (const fov of FIRST_PERSON_FOVS) {
      if (fov !== FIRST_PERSON_FOVS[0] && f % 3 !== 0) continue;
      view(`first person fov ${fov} ${seqs[s].name} frame ${f}`, firstPerson(fov), tris);
    }
  }
  log(`first person: ${frames} frames, ${total.views} views, ${total.see} see-through, ${total.layer} layer pixels`);
  const fine = sphere(boxOf(idle), range(0, 345, 15), range(-75, 75, 25));
  for (const v of fine) view(`${v.label} (idle)`, v.cam, idle);
  log(`idle sphere: ${fine.length} cameras, ${total.see} see-through, ${total.layer} layer pixels so far`);
  const step = full ? 3 : 15;
  for (let s = 0; s < seqs.length; s++) for (let f = 0; f < seqs[s].frames; f += step) {
    const tris = trianglesAt(mdl, s, f);
    const coarse = full ? sphere(boxOf(tris), range(0, 330, 30), range(-60, 60, 30)) : sphere(boxOf(tris), range(0, 300, 60), [-45, 20, 60]);
    for (const v of coarse) view(`${v.label} (${seqs[s].name} frame ${f})`, v.cam, tris);
  }
  notes.push(`${total.views} cameras: ${viewmodel ? `first person at fov ${FIRST_PERSON_FOVS.join("/")} over ${frames} frames, ` : ""}${fine.length} round the idle pose, the rest round the animations; worst: ${worst.label || "none"}`);
  if (total.see || total.layer) {
    errors.push(`${total.see} pixels see through the model to the background and ${total.layer} see a layer behind (nearest surface a back face); worst ${worst.label}: ${worst.see} and ${worst.layer}`);
    for (const [where, n] of [...blamed].sort((a, b) => b[1] - a[1]).slice(0, 8)) errors.push(`  ${n} pixels first meet the inside of a triangle on ${where}`);
  }
  return { errors, notes };
}

/**
 * null when two model files are the same up to their picture (the bytes before the first picture's pixels, and the file's
 * length), else a sentence saying where they differ first. The side sets of a weapon differ only in the band's colours.
 */
export function sameGeometry(a, b) {
  const picture = (m) => K.readMdl(m).textures.map((t) => t.index).reduce((x, y) => Math.min(x, y), Infinity);
  const upTo = Math.min(picture(a), picture(b));
  if (a.length !== b.length) return `the files are ${a.length} and ${b.length} bytes long`;
  for (let i = 0; i < upTo; i++) if (a[i] !== b[i]) return `the files differ at byte ${i}, before the picture (byte ${upTo})`;
  return null;
}

// -- the command ----------------------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const viewmodel = !args.includes("--world");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("usage: node check-solid.mjs <model.mdl> [...] [--full] [--world]"); process.exit(2); }
  let failed = 0;
  for (const file of files) {
    const t0 = Date.now();
    const { errors, notes } = solidity(readFileSync(file), { full, viewmodel });
    console.log(`${file}: ${errors.length ? "FAIL" : "PASS"}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    for (const n of notes) console.log(`  ${n}`);
    for (const e of errors) console.log(`  ERROR ${e}`);
    if (errors.length) failed++;
  }
  process.exit(failed ? 1 : 0);
}

// Holes in a player model: arms and hands that are torn open or built inside out.
//
//     node audit-holes.mjs <model> [<model> ...]
//
// A model is a folder name under the models folder (TS_MODELS, or the install lib.mjs points at) or the path of a
// .mdl file. Four tests, each a way of seeing through a surface that check() does not notice:
//
//   open edges   An edge that belongs to one triangle is the rim of a hole (arm-holes.mjs lists them by bone). A
//                hand is closed on every sound model, so a hand with open edges is torn.
//   arm segments The share of an upper arm's, a forearm's and a hand's triangles whose front side (the one the
//                engine draws) faces away from the segment's own long axis, and the share whose stored normals do.
//                A sound arm reads 55 to 100 on both. An arm built inside out reads under 40: the engine draws the
//                far wall of the tube from the inside, so the arm looks hollow and its hand is made of shards.
//   meshes       The same two shares for every mesh of a hundred triangles or more, about that mesh's own middle.
//                A closed piece (a mask, a pouch, a sleeve) reads over 50 when sound and under 40 inside out. Only
//                large meshes are judged because a small or flat one reads near half either way.
//   windings     For every mesh of eight triangles or more, the share of its triangles whose front (the side the engine
//                draws) looks the same way as their stored normal. A sound mesh reads 95 or more on the female player
//                models. A mesh with its winding turned and not its normals, or its normals and not its winding, reads
//                under 40: it is drawn from the inside, or lit from the wrong side. This needs no middle to look from,
//                so it judges a thin or open piece (the skin on a forearm) as well as a closed one. Which of the two is
//                the wrong one it does not say: the render does, or a mirrored partner. fix-inverted-meshes.mjs turns
//                the normals alone with --normals-only.
//
// Prints one line a model, OK or HOLES, with a line under HOLES for each finding. Exit status 1 when any model is
// flagged. Pose 1 frame 0 (standard_idle), the pose everything else in this folder measures in.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { K, IN, POSE } from "./lib.mjs";

const OPEN_HAND = 6, OPEN_UPPER = 24, OPEN_FORE = 20;       // open edges a segment may carry
const SEGMENT_MIN = 12, SEGMENT_LOW = 40;                    // triangles a segment needs to be judged; share under which it is inside out
const MESH_MIN = 100, MESH_WINDING_LOW = 45, MESH_NORMALS_LOW = 35;
const AGREE_MIN = 8, AGREE_LOW = 40;                         // triangles a mesh needs for the windings test; share agreeing under which it fails

const SIDES = [["SX", "left"], ["DX", "right"]];             // sinistra, destra

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const percent = (n, of) => Math.round((100 * n) / of);

/** The file of a model given by folder name or by path. */
function fileOf(arg) {
  if (/\.mdl$/i.test(arg) && existsSync(arg)) return arg;
  return join(IN, arg, `${arg}.mdl`);
}

/** Every triangle of the model in model space, with the bones of its corners and its stored normals, in the pose. */
function trianglesOf(mdl, pose) {
  const md = K.readMdl(mdl);
  const out = [];
  md.bodyparts.forEach((bp, bi) => bp.models.forEach((mo, mi) => mo.meshes.forEach((me, k) => {
    for (const t of K.readMesh(mdl, mo, me)) {
      const w = t.map((c) => K.apply34(pose[c.bone], c.p));
      const n = [0, 0, 0];
      for (const c of t) for (let r = 0; r < 3; r++) n[r] += dot(pose[c.bone][r], c.n);
      out.push({
        mesh: `${bi}.${mi}.${k}`,
        tex: md.textures[me.skinref]?.name,
        bones: t.map((c) => c.bone),
        w,
        mid: [0, 1, 2].map((a) => (w[0][a] + w[1][a] + w[2][a]) / 3),
        // the engine draws a triangle clockwise seen from outside, so outward is against (b - a) x (c - a)
        out: cross(sub(w[1], w[0]), sub(w[2], w[0])).map((v) => -v),
        stored: n,
      });
    }
  })));
  return out;
}

/** Open edges by bone: edges with one triangle, matched by position to a sixteenth of a unit. */
function openEdgesByBone(tris) {
  const edges = new Map();
  const key = (p) => p.map((v) => Math.round(v * 16)).join(",");
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const a = key(t.w[i]), b = key(t.w[j]);
      if (a === b) continue;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(k) ?? { n: 0, bones: new Set() };
      e.n++;
      e.bones.add(t.bones[i]);
      e.bones.add(t.bones[j]);
      edges.set(k, e);
    }
  }
  const byBone = new Map();
  for (const e of edges.values()) if (e.n === 1) for (const b of e.bones) byBone.set(b, (byBone.get(b) ?? 0) + 1);
  return byBone;
}

/** Share of the triangles in `list` whose `vector` looks away from `centre`, as a percentage; null for an empty list. */
function outward(list, centre, vector) {
  let n = 0, away = 0;
  for (const t of list) {
    const v = vector(t);
    if (length(v) < 1e-6) continue;
    n++;
    if (dot(v, sub(t.mid, centre)) > 0) away++;
  }
  return n ? percent(away, n) : null;
}

function audit(file) {
  const mdl = readFileSync(file);
  const bn = K.bones(mdl).map((b) => b.name.replace("Bip01 ", ""));
  const pose = K.poseAt(mdl, POSE.seq, POSE.frame);
  const tris = trianglesOf(mdl, pose);
  const open = openEdgesByBone(tris);
  const origin = (name) => { const i = bn.indexOf(name); return i < 0 ? null : [pose[i][0][3], pose[i][1][3], pose[i][2][3]]; };
  const found = [];

  for (const [side, label] of SIDES) {
    const bone = (part) => bn.indexOf(`${side} ${part}`);
    const upper = bone("Braccio superiore"), fore = bone("Avambraccio"), hand = bone("Mano");
    if (upper < 0 || fore < 0 || hand < 0) continue;

    const edges = (b) => open.get(b) ?? 0;
    const torn = [];
    if (edges(upper) > OPEN_UPPER) torn.push(`${edges(upper)} on the upper arm`);
    if (edges(fore) > OPEN_FORE) torn.push(`${edges(fore)} on the forearm`);
    if (edges(hand) > OPEN_HAND) torn.push(`${edges(hand)} on the hand`);
    if (torn.length) found.push(`${label} arm is torn: open edges ${torn.join(", ")}`);

    // each segment's long axis: joint to joint, and the hand along the forearm's direction
    const a = origin(`${side} Braccio superiore`), f = origin(`${side} Avambraccio`), h = origin(`${side} Mano`);
    const segments = [
      ["upper arm", upper, a, f],
      ["forearm", fore, f, h],
      ["hand", hand, h, h.map((v, k) => v + (h[k] - f[k]))],
    ];
    for (const [what, b, from, to] of segments) {
      const axis = sub(to, from), long = length(axis);
      const unit = axis.map((v) => v / long);
      const mine = tris.filter((t) => t.bones.every((x) => x === b));
      if (mine.length < SEGMENT_MIN) continue;
      const radial = (t) => { const rel = sub(t.mid, from); return sub(rel, unit.map((v) => v * dot(rel, unit))); };
      let n = 0, byWinding = 0, byNormals = 0;
      for (const t of mine) {
        const r = radial(t);
        if (length(r) < 1e-3 || length(t.out) < 1e-6) continue;
        n++;
        if (dot(t.out, r) > 0) byWinding++;
        if (dot(t.stored, r) > 0) byNormals++;
      }
      if (!n) continue;
      const w = percent(byWinding, n), s = percent(byNormals, n);
      if (Math.min(w, s) < SEGMENT_LOW) found.push(`${label} ${what} is inside out: ${n} triangles, front faces outward on ${w}%, normals on ${s}%`);
    }
  }

  const byMesh = new Map();
  for (const t of tris) (byMesh.get(t.mesh) ?? byMesh.set(t.mesh, []).get(t.mesh)).push(t);
  for (const [id, list] of byMesh) {
    let n = 0, agree = 0;
    for (const t of list) {
      if (length(t.out) < 1e-6 || length(t.stored) < 1e-6) continue;
      n++;
      if (dot(t.out, t.stored) > 0) agree++;
    }
    if (n >= AGREE_MIN && percent(agree, n) < AGREE_LOW) {
      found.push(`mesh ${id} (${list[0].tex}, ${list.length} triangles): winding disagrees with its stored normals on ${100 - percent(agree, n)}%`);
    }

    if (list.length < MESH_MIN) continue;
    const centre = [0, 1, 2].map((a) => list.reduce((s, t) => s + t.mid[a], 0) / list.length);
    const w = outward(list, centre, (t) => t.out), s = outward(list, centre, (t) => t.stored);
    if (w !== null && w < MESH_WINDING_LOW && s < MESH_NORMALS_LOW) {
      found.push(`mesh ${id} (${list[0].tex}, ${list.length} triangles) is inside out: front faces outward on ${w}%, normals on ${s}%`);
    }
  }
  return found;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node audit-holes.mjs <model> [<model> ...]");
  process.exit(2);
}
let flagged = 0;
for (const arg of args) {
  const file = fileOf(arg);
  if (!existsSync(file)) {
    console.log(`${arg.padEnd(26)} no model at ${file}`);
    flagged++;
    continue;
  }
  const found = audit(file);
  console.log(`${arg.padEnd(26)} ${found.length ? "HOLES" : "OK"}`);
  for (const line of found) console.log(`    ${line}`);
  if (found.length) flagged++;
}
process.exit(flagged ? 1 : 0);

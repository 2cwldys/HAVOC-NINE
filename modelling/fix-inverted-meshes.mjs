// Turns meshes of a model right way out, in place.
//
//     node fix-inverted-meshes.mjs <in.mdl> <out.mdl> <mesh> [<mesh> ...] [--normals-only <mesh>] ... [--force]
//
// A mesh is named by its place, bodypart.model.mesh, as audit-holes.mjs prints it ("mesh 0.0.8 (head.bmp, ...)").
//
// A mesh can be wrong in two ways, and they are independent of each other:
//     its triangles are wound the wrong way. The engine draws only the front of a triangle, so it draws the far wall
//     of the piece from the inside: a mask looks hollow, an arm looks torn.
//     its normals point into the piece. What is drawn is lit from the wrong side.
// A piece built inside out is wrong in both. A piece made by reflecting another can be wrong in either: the skin of a
// reflected forearm can keep its winding and lose its normals. So the two are read separately, and a mesh is turned
// in the way its readings say.
//
//     <mesh>                 Turns both. The second and third corner of every triangle swap places and every normal
//                            of the mesh changes sign. Done when the winding and the normals both look inward from
//                            the mesh's middle (under half of its triangles face away from it), left alone when both
//                            look outward, and refused when they differ: a mesh wrong in one way only is not put
//                            right by turning both. A thin or open piece, the skin on a forearm, has no inside to
//                            look from, so its middle says nothing about it.
//     --normals-only <mesh>  Turns the normals alone and leaves the winding as it is. Done when the stored normals
//                            disagree with the winding on most triangles (the side the engine draws and the normal
//                            look opposite ways), left alone when they agree. That needs no middle, so it reads a thin
//                            piece too. That the winding is the right one is for the caller to know, for instance
//                            from the same piece on the other side of a model whose two sides are reflections.
//     --force                Turns the named meshes whatever they look like.
//
// ins_medic_bfem, which no script here builds, is put right from its original file with
//     node fix-inverted-meshes.mjs <original>/ins_medic_bfem.mdl <out>/ins_medic_bfem.mdl 0.0.6 0.0.7 0.0.8 --normals-only 0.0.5
// The cloth sleeve (0.0.6), the medkit pouches (0.0.7) and the gas mask (0.0.8) are wrong in both ways. The skin on the
// right forearm (0.0.5, 2.bmp, 42 triangles) is wound as its left partner is and only its normals are inverted.
//
// No vertex, texture, bone or animation moves and the file keeps its length. A mesh is turned in both ways only when
// its triangles are separate (strips of three corners, which is how the kit writes a mesh it builds); a mesh holding
// longer strips or fans is refused. A mesh's normals are turned only when every corner of the mesh takes them from the
// mesh's own block and no other mesh uses that block. A second run on the result changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { K, POSE } from "./lib.mjs";

const MODEL_NORMALS = 100;          // offset of normindex in a submodel's record
const COUNT = 2, CORNER = 8;        // bytes in a command's count, and in one corner (vertex, normal, s, t as 16 bit numbers)
const VEC3 = 12;
const HALF = 50;                    // percent of a mesh's triangles that must look outward for a reading to count as outward

const USAGE = "usage: node fix-inverted-meshes.mjs <in.mdl> <out.mdl> <bodypart.model.mesh> [...] [--normals-only <bodypart.model.mesh>] ... [--force]";
const args = process.argv.slice(2);
const force = args.includes("--force");
const normalsOnly = [];
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--force") continue;
  if (args[i] === "--normals-only") {
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) { console.error(USAGE); process.exit(2); }
    normalsOnly.push(args[++i]);
  } else {
    positional.push(args[i]);
  }
}
const [input, output, ...named] = positional;
if (!input || !output || !(named.length + normalsOnly.length)) {
  console.error(USAGE);
  process.exit(2);
}
if (input === output) {
  console.error("the output must be another file than the input: the original stays as it is");
  process.exit(2);
}
const jobs = [...named.map((id) => ({ id, both: true })), ...normalsOnly.map((id) => ({ id, both: false }))];
for (const { id } of jobs) {
  if (jobs.filter((j) => j.id === id).length > 1) {
    console.error(`mesh ${id} is named more than once`);
    process.exit(2);
  }
}

const src = readFileSync(input);
const md = K.readMdl(src);
const out = Buffer.from(src);
const pose = K.poseAt(src, POSE.seq, POSE.frame);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const percent = (n, of) => (of ? Math.round((100 * n) / of) : 100);

/** Where the first corner of each triangle of a mesh is, in the file; throws on a command that is not one triangle. */
function triangleCommands(buffer, mesh, label) {
  const found = [];
  let at = mesh.triindex;
  for (;;) {
    const count = buffer.readInt16LE(at);
    if (count === 0) break;
    if (count !== 3) throw new Error(`${label}: a ${count < 0 ? "fan" : "strip"} of ${Math.abs(count)} corners; only separate triangles can be turned in place`);
    found.push(at + COUNT);
    at += COUNT + 3 * CORNER;
  }
  return found;
}

/** Where the normal number of every corner of a mesh is, in the file, whatever kind of command holds the corner. */
function normalFields(buffer, mesh) {
  const fields = [];
  let at = mesh.triindex;
  for (;;) {
    const count = Math.abs(buffer.readInt16LE(at));
    at += COUNT;
    if (!count) break;
    for (let i = 0; i < count; i++, at += CORNER) fields.push(at + 2);
  }
  return fields;
}

/**
 * What a mesh looks like, in the idle pose, as percentages of its triangles: how many have a front (the side the
 * engine draws) looking away from the mesh's middle, how many have a stored normal looking away from it, and how
 * many have a front and a stored normal looking the same way. 100 each for a mesh with nothing to read.
 */
function readings(model, mesh) {
  const rows = K.readMesh(src, model, mesh).map((t) => {
    const w = t.map((c) => K.apply34(pose[c.bone], c.p));
    const stored = [0, 0, 0];
    for (const c of t) for (let r = 0; r < 3; r++) stored[r] += dot(pose[c.bone][r], c.n);
    return {
      mid: [0, 1, 2].map((a) => (w[0][a] + w[1][a] + w[2][a]) / 3),
      // the engine draws a triangle clockwise seen from outside, so outward is against (b - a) x (c - a)
      front: cross(sub(w[1], w[0]), sub(w[2], w[0])).map((v) => -v),
      stored,
    };
  });
  const centre = [0, 1, 2].map((a) => rows.reduce((s, r) => s + r.mid[a], 0) / (rows.length || 1));
  let nFront = 0, awayFront = 0, nStored = 0, awayStored = 0, nBoth = 0, together = 0;
  for (const r of rows) {
    const away = sub(r.mid, centre);
    const hasFront = length(r.front) >= 1e-6, hasStored = length(r.stored) >= 1e-6;
    if (hasFront) { nFront++; if (dot(r.front, away) > 0) awayFront++; }
    if (hasStored) { nStored++; if (dot(r.stored, away) > 0) awayStored++; }
    if (hasFront && hasStored) { nBoth++; if (dot(r.front, r.stored) > 0) together++; }
  }
  return { winding: percent(awayFront, nFront), normals: percent(awayStored, nStored), agree: percent(together, nBoth) };
}

const turned = [];
for (const { id, both } of jobs) {
  const [bi, mi, ki] = id.split(".").map(Number);
  const model = md.bodyparts[bi]?.models[mi];
  const mesh = model?.meshes[ki];
  if (!mesh) throw new Error(`no mesh ${id}: the model has ${md.bodyparts.map((b) => b.models.map((m) => m.meshes.length).join("+")).join(" / ")} meshes`);
  const label = `mesh ${id} (${md.textures[mesh.skinref]?.name}, ${mesh.numtris} triangles)`;

  const r = readings(model, mesh);
  const shown = `winding faces outward on ${r.winding}%, normals on ${r.normals}%, normals and winding agree on ${r.agree}%`;
  if (!force) {
    if (!both) {
      if (r.agree >= HALF) {
        console.log(`${label}: ${shown}, left alone`);
        continue;
      }
    } else if (r.winding >= HALF && r.normals >= HALF) {
      console.log(`${label}: ${shown}, left alone`);
      continue;
    } else if (r.winding >= HALF || r.normals >= HALF) {
      throw new Error(`${label}: ${shown}. Only one of the two looks inward, which turning both does not put right; --normals-only turns the normals alone`);
    }
  }

  // the mesh's normals are the block of the submodel's list that comes after the meshes before it
  const first = model.meshes.slice(0, ki).reduce((s, m) => s + m.numnorms, 0);
  const last = first + mesh.numnorms;
  for (const at of normalFields(src, mesh)) {
    const normal = src.readInt16LE(at);
    if (normal < first || normal >= last) throw new Error(`${label}: a corner uses normal ${normal}, outside its own block ${first}..${last - 1}`);
  }
  model.meshes.forEach((other, oi) => {
    if (oi === ki) return;
    if (other.triindex === mesh.triindex) throw new Error(`${label}: shares its triangles with mesh ${bi}.${mi}.${oi}`);
    for (const at of normalFields(src, other)) {
      const normal = src.readInt16LE(at);
      if (normal >= first && normal < last) throw new Error(`${label}: mesh ${bi}.${mi}.${oi} uses its normals too`);
    }
  });

  // winding: corners two and three change places
  const corners = both ? triangleCommands(src, mesh, label) : [];
  for (const at of corners) {
    const second = Buffer.from(src.subarray(at + CORNER, at + 2 * CORNER));
    const third = Buffer.from(src.subarray(at + 2 * CORNER, at + 3 * CORNER));
    third.copy(out, at + CORNER);
    second.copy(out, at + 2 * CORNER);
  }
  // normals: the block's signs
  const base = src.readInt32LE(model.at + MODEL_NORMALS) + first * VEC3;
  for (let i = 0; i < mesh.numnorms * 3; i++) {
    const v = src.readFloatLE(base + i * 4);
    out.writeFloatLE(v === 0 ? 0 : -v, base + i * 4);
  }
  turned.push({ id, bi, mi, ki, label, both });
  console.log(`${label}: ${shown}, ${both ? `turned both (${mesh.numtris} triangles` : "turned the normals alone (winding kept"}, ${mesh.numnorms} normals)`);
}

// what came out: every triangle of a turned mesh is the original, with its second and third corner changed over when
// both were turned, and with its normals negated
if (turned.length) {
  const after = K.readMdl(out);
  for (const t of turned) {
    const was = K.readMesh(src, md.bodyparts[t.bi].models[t.mi], md.bodyparts[t.bi].models[t.mi].meshes[t.ki]);
    const now = K.readMesh(out, after.bodyparts[t.bi].models[t.mi], after.bodyparts[t.bi].models[t.mi].meshes[t.ki]);
    if (was.length !== now.length) throw new Error(`${t.label}: ${was.length} triangles became ${now.length}`);
    was.forEach((tri, i) => {
      const want = t.both ? [tri[0], tri[2], tri[1]] : tri;
      want.forEach((c, k) => {
        const g = now[i][k];
        const same = g.bone === c.bone && g.s === c.s && g.t === c.t
          && g.p.every((v, a) => v === c.p[a]) && g.n.every((v, a) => Math.abs(v + c.n[a]) < 1e-6);
        if (!same) throw new Error(`${t.label}: triangle ${i} corner ${k} did not come out as asked`);
      });
    });
  }
}
let changed = 0;
for (let i = 0; i < out.length; i++) if (out[i] !== src[i]) changed++;
const checked = K.check(out, "goldsrc");
if (checked.errors.length) throw new Error(`the result does not check: ${checked.errors.join("; ")}`);
if (!K.isEngineLayout(out)) throw new Error("the result is not in engine layout");
writeFileSync(output, out);
console.log(`${turned.length} of ${jobs.length} meshes turned, ${changed} bytes changed of ${out.length}, check 0 errors, written to ${output}`);

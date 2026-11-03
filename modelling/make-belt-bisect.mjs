// A bisect build, to find why ins_medic_belt draws as nothing in the game.
//
//     node make-belt-bisect.mjs    -> ../export-mdl/ins_medic_b1/ins_medic_b1.mdl
//
// ins_medic renders. ins_medic_belt does not. They differ in exactly two ways: the
// belt has an APPENDED MESH, and that mesh wears an APPENDED TEXTURE. Every structural
// check passes on both -- header length, skin table, per-vertex bone tables, texture
// data pointers all inside the file -- so inspection has run out and this splits the
// two by building the mesh with NO new texture.
//
//   b1 renders  -> the appended texture is the problem; paint the kit into the
//                  existing sheet instead, which has room.
//   b1 invisible -> appending a mesh to a submodel is the problem, and the kit has to
//                  be a separate bodypart or a separate model entirely.
//
// The geometry is deliberately the same as the real thing, so nothing else varies.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, checked, texturesLast, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = readFileSync(join(OUT, "ins_medic", "ins_medic.mdl"));

const C = { x: 3.3, y: -6.6, z: 0.4 };
const D = { x: 2.5, y: 2.7, z: 4.0 };

// The box, as in make-medic-belt.mjs. Its UVs land on the existing body sheet, which
// will look wrong -- that is fine. This build is asking whether it DRAWS, not whether
// it looks right.
const T0 = K.textureOf(base, 0);
const M = W.shape(T0.width, T0.height);

const bulge = (sx, sy, sz) => [
  C.x + sx * D.x * (1 - 0.14 * Math.abs(sy) - 0.10 * Math.abs(sz)),
  C.y + sy * D.y * (1 - 0.12 * Math.abs(sx) - 0.10 * Math.abs(sz)),
  C.z + sz * D.z * (1 - 0.10 * Math.abs(sx) - 0.12 * Math.abs(sy)),
];
const ZONE = { x: 8, y: 300, w: 60, h: 60 };     // a quiet corner of the body sheet
const uv = (a, b) => [ZONE.x + ZONE.w * a, ZONE.y + ZONE.h * b];
const inside = [C.x, C.y, C.z];

const FACES = [
  { c: [[-1,-1,-1],[ 1,-1,-1],[ 1,-1, 1],[-1,-1, 1]] },
  { c: [[ 1, 1,-1],[-1, 1,-1],[-1, 1, 1],[ 1, 1, 1]] },
  { c: [[ 1,-1,-1],[ 1, 1,-1],[ 1, 1, 1],[ 1,-1, 1]] },
  { c: [[-1, 1,-1],[-1,-1,-1],[-1,-1, 1],[-1, 1, 1]] },
  { c: [[-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1]] },
  { c: [[-1, 1,-1],[ 1, 1,-1],[ 1,-1,-1],[-1,-1,-1]] },
];
for (const f of FACES) {
  const vs = f.c.map((s, i) => M.V(bulge(...s), uv([0.02, 0.98, 0.98, 0.02][i], [0.02, 0.02, 0.98, 0.98][i])));
  M.quad(vs[0], vs[1], vs[2], vs[3], inside);
}

const names = K.bones(base).map((b) => b.name);
const bone = names.indexOf("Bip01 Bacino");
const P = K.poseAt(base, POSE.seq, POSE.frame);
const to = K.inverse34(P[bone]);
const where = { bodypart: 0, model: 0 };
const mesh = K.readMdl(base).bodyparts[0].models[0].meshes.length;

// The ONE difference from the real build: the mesh is given a texture the file already
// has, so nothing is appended to the texture table.
const out = texturesLast(K.replaceMesh(
  K.addMesh(base, where), { ...where, mesh },
  K.meshOf(null, M.tris.map((t) => t.map((c) => ({ ...c, bone, to }))), T0, bone, 55), T0,
));

const t = K.readMdl(out);
console.log(`  b1: ${M.tris.length} triangles, ${t.textures.length} textures (ins_medic has 2, the belt has 3)`);

mkdirSync(join(OUT, "ins_medic_b1"), { recursive: true });
writeFileSync(join(OUT, "ins_medic_b1", "ins_medic_b1.mdl"), checked("b1", out));
console.log("  wrote export-mdl/ins_medic_b1/ins_medic_b1.mdl");

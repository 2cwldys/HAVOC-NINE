import { K } from "./lib.mjs";
import { readFileSync } from "node:fs";

// submodel struct offsets, from smak's own mdl.mjs
const M = { numverts: 80, vertinfoindex: 84, vertindex: 88, numnorms: 92, norminfoindex: 96, normindex: 100 };
const i32 = (b, o) => b.readInt32LE(o);

for (const name of ["ins_medic", "ins_medic_belt"]) {
  const b = readFileSync(`../export-mdl/${name}/${name}.mdl`);
  const t = K.readMdl(b);
  const nbones = K.bones(b).length;
  console.log(`\n=== ${name} ===  (${nbones} bones, so a valid index is 0..${nbones - 1})`);
  for (const bp of t.bodyparts) for (const md of bp.models) {
    const nv = i32(b, md.at + M.numverts), vi = i32(b, md.at + M.vertinfoindex);
    const nn = i32(b, md.at + M.numnorms), ni = i32(b, md.at + M.norminfoindex);
    let badV = 0, maxV = -1, badN = 0, maxN = -1;
    for (let i = 0; i < nv; i++) { const v = b[vi + i]; if (v >= nbones) badV++; if (v > maxV) maxV = v; }
    for (let i = 0; i < nn; i++) { const v = b[ni + i]; if (v >= nbones) badN++; if (v > maxN) maxN = v; }
    console.log(`  verts ${nv} @${vi}: max bone ${maxV}, out of range ${badV}`);
    console.log(`  norms ${nn} @${ni}: max bone ${maxN}, out of range ${badN}`);
    // where do the APPENDED entries sit relative to the file's old end?
    console.log(`  vertinfo spans ${vi}..${vi + nv}   norminfo spans ${ni}..${ni + nn}   file ${b.length}`);
  }
}

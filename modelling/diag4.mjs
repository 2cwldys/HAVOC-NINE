import { K } from "./lib.mjs";
import { readFileSync } from "node:fs";
const i32 = (b,o)=>b.readInt32LE(o);
const M = { nummesh:72, meshindex:76, numverts:80, vertinfoindex:84, vertindex:88, numnorms:92, norminfoindex:96, normindex:100 };
for (const name of ["ins_medic","ins_medic_b1","ins_medic_belt"]) {
  const b = readFileSync(`../export-mdl/${name}/${name}.mdl`);
  const t = K.readMdl(b);
  const md = t.bodyparts[0].models[0];
  const nm = i32(b, md.at+M.nummesh), mi = i32(b, md.at+M.meshindex);
  const nv = i32(b, md.at+M.numverts), vx = i32(b, md.at+M.vertindex);
  const nn = i32(b, md.at+M.numnorms), nx = i32(b, md.at+M.normindex);
  console.log(`\n=== ${name} === file ${b.length}  submodel@${md.at}`);
  console.log(`  nummesh ${nm} meshindex ${mi}  (array needs ${nm*20} bytes -> ends ${mi+nm*20})`);
  console.log(`  verts ${nv} @${vx} -> ends ${vx+nv*12}   norms ${nn} @${nx} -> ends ${nx+nn*12}`);
  for (let i=0;i<nm;i++){
    const o = mi + i*20;
    console.log(`    mesh ${i}: numtris ${i32(b,o)} triindex ${i32(b,o+4)} skinref ${i32(b,o+8)} numnorms ${i32(b,o+12)} normindex ${i32(b,o+16)}`);
  }
  // does any triangle command reference a vertex or normal out of range?
  let maxV=-1, maxN=-1, bad=0;
  for (let i=0;i<nm;i++){
    const o = mi+i*20, tri = i32(b,o+4);
    let p = tri;
    for (let guard=0; guard<200000; guard++){
      const c = b.readInt16LE(p); p+=2;
      if (c===0) break;
      const cnt = Math.abs(c);
      for (let k=0;k<cnt;k++){
        const v = b.readInt16LE(p), n = b.readInt16LE(p+2); p+=8;
        if (v>maxV) maxV=v; if (n>maxN) maxN=n;
        if (v>=nv || n>=nn) bad++;
      }
    }
  }
  console.log(`  triangle commands: max vert ${maxV} (of ${nv}), max norm ${maxN} (of ${nn}), OUT OF RANGE ${bad}`);
}

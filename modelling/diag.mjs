import { K } from "./lib.mjs";
import { readFileSync } from "node:fs";

const H = { numskinref: 192, numskinfamilies: 196, skinindex: 200 };
const i32 = (b, o) => b.readInt32LE(o);

for (const name of ["ins_medic", "ins_medic_belt"]) {
  const b = readFileSync(`../export-mdl/${name}/${name}.mdl`);
  const t = K.readMdl(b);
  console.log(`\n=== ${name} ===`);
  console.log(`  header length field : ${i32(b, 72)}   actual file ${b.length}  ${i32(b,72)===b.length ? "match" : "MISMATCH"}`);
  console.log(`  numskinref ${i32(b, H.numskinref)}  numskinfamilies ${i32(b, H.numskinfamilies)}  skinindex ${i32(b, H.skinindex)}`);
  const sk = i32(b, H.skinindex), nref = i32(b, H.numskinref), nfam = i32(b, H.numskinfamilies);
  const rows = [];
  for (let f = 0; f < nfam; f++) {
    const r = [];
    for (let s = 0; s < nref; s++) r.push(b.readInt16LE(sk + (f * nref + s) * 2));
    rows.push(r.join(","));
  }
  console.log(`  skin table          : ${rows.join("  |  ")}`);
  console.log(`  textures            : ${t.textures.length}`);
  for (const bp of t.bodyparts) for (const md of bp.models) {
    console.log(`  submodel ${md.name}: numverts ${md.numverts} numnorms ${md.numnorms}`);
    md.meshes.forEach((me, i) => {
      console.log(`     mesh ${i}: numtris ${me.numtris} skinref ${me.skinref} numnorms ${me.numnorms} tex ${me.texture ? me.texture.name : "?"}`);
    });
  }
}

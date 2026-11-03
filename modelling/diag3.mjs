import { readFileSync } from "node:fs";
const i32 = (b, o) => b.readInt32LE(o);
// studiohdr: numtextures 180, textureindex 184, texturedataindex 188
for (const name of ["ins_medic", "ins_medic_belt"]) {
  const b = readFileSync(`../export-mdl/${name}/${name}.mdl`);
  const n = i32(b, 180), ti = i32(b, 184), tdi = i32(b, 188);
  console.log(`\n=== ${name} ===  file ${b.length}`);
  console.log(`  numtextures ${n}  textureindex ${ti}  texturedataindex ${tdi}`);
  for (let i = 0; i < n; i++) {
    const o = ti + i * 80;                       // mstudiotexture_t is 80 bytes
    const nm = b.toString("latin1", o, o + 64).replace(/\0.*$/, "");
    const fl = i32(b, o + 64), w = i32(b, o + 68), h = i32(b, o + 72), ix = i32(b, o + 76);
    const need = w * h + 768;
    const end = ix + need;
    console.log(`  [${i}] ${nm.padEnd(20)} ${w}x${h} flags ${fl}  data @${ix}..${end}  ${end <= b.length ? "inside file" : "PAST END OF FILE"}`);
  }
}

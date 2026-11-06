import { readFileSync } from "node:fs";
import { readMdl, posed } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const TS = "D:/Downloads/TSM/H9XASH/ts/models/";
for (const name of ["v_m4.mdl", "p_m4.mdl", "w_m4.mdl", "v_ak47.mdl"]) {
  const src = readFileSync(TS + name);
  const info = readMdl(src);
  const out = posed(src, { seq: 0, frame: 0 });
  const tris = out.tris ?? out.triangles ?? [];
  console.log(`\n${name}: keys ${Object.keys(out).join(",")}  tris ${tris.length}`);
  const by = new Map();
  for (const t of tris) {
    const k = t.tex?.name ?? t.tex ?? "?";
    const b = by.get(k) ?? { n: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9], bones: new Set() };
    b.n++;
    for (const c of t.c) { for (let a = 0; a < 3; a++) { b.mn[a] = Math.min(b.mn[a], c.p[a]); b.mx[a] = Math.max(b.mx[a], c.p[a]); } b.bones.add(info.bones[c.bone]); }
    by.set(k, b);
  }
  for (const [k, b] of by) console.log(`  ${String(k).padEnd(16)} ${String(b.n).padStart(4)} tris box ${b.mn.map((v) => v.toFixed(1))} .. ${b.mx.map((v) => v.toFixed(1))} size ${b.mx.map((v, a) => (v - b.mn[a]).toFixed(1))}`);
}

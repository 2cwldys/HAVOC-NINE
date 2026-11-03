// Scratch: every island of the mech's upper half, its centre and the bones it
// hangs on -- the gear pieces bind to the same bones as what they wrap.
import { K, load, POSE } from "./lib.mjs";

const src = load("ed209_ts");
const isl = K.uvIslands(src, POSE);
const short = (n) => n.replace(/^Bip01 /, "").replace(/^(SX|DX) /, "$1 ");
const mine = isl.list.filter((e) => e.tex === "ed209_sheet0.bmp" && e.mid[2] > 16);
console.log(`islands z>16: ${mine.length}`);
for (const e of mine) {
  const f = (v) => v.map((n) => n.toFixed(0).padStart(4)).join(" ");
  const tris = Array.isArray(e.tris) ? e.tris.length : e.tris;
  const bones = [...new Set((e.bones ?? []).map(short))].join(" + ");
  console.log(`  id ${String(e.id).padStart(3)} tris ${String(tris).padStart(4)} deltas [${f(e.mid)}]  ${bones}`);
}

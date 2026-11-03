import { load, surface, K, POSE } from "./lib.mjs";
const m = load("merc"), s = surface(m);
const P = K.poseAt(m, POSE.seq, POSE.frame), names = K.bones(m).map(b=>b.name);
const at = (n) => { const i = names.indexOf(n); return [P[i][0][3], P[i][1][3], P[i][2][3]]; };
console.log("  DX Mano (right hand) ", at("Bip01 DX Mano").map(v=>v.toFixed(1)).join(" "));
console.log("  DX Coscia (r thigh)  ", at("Bip01 DX Coscia").map(v=>v.toFixed(1)).join(" "));
console.log("  Bacino (pelvis)      ", at("Bip01 Bacino").map(v=>v.toFixed(1)).join(" "));
console.log("");
for (const [lo,hi] of [[-6,-2],[-2,2],[2,6],[6,10]]) {
  const band = s.filter(q=>q.p[2]>lo && q.p[2]<hi);
  // torso only: drop anything out where the arms hang
  const torso = band.filter(q=>Math.abs(q.p[1])<8.5);
  const f=(a,k,fn)=>a.length?fn(...a.map(q=>q.p[k])).toFixed(1):"-";
  console.log(`  z ${String(lo).padStart(3)}..${String(hi).padStart(3)}  all |y|max ${f(band,1,Math.max).padStart(5)} / ${f(band,1,Math.min).padStart(5)}   torso(|y|<8.5) ymin ${f(torso,1,Math.min).padStart(5)} ymax ${f(torso,1,Math.max).padStart(5)}  x ${f(torso,0,Math.min)}..${f(torso,0,Math.max)}`);
}

import { K, load, surface } from "./lib.mjs";
const m = load("merc"), s = surface(m);
const ax = ["x","y","z"];
for (let i = 0; i < 3; i++) {
  const v = s.map((q) => q.p[i]);
  console.log(`  ${ax[i]}: ${Math.min(...v).toFixed(1)} .. ${Math.max(...v).toFixed(1)}`);
}
const byTex = {};
for (const q of s) (byTex[q.tex] ??= []).push(q.p[2]);
for (const [t, zs] of Object.entries(byTex)) console.log(`  ${t}: z ${Math.min(...zs).toFixed(1)} .. ${Math.max(...zs).toFixed(1)}  (${zs.length} tris)`);

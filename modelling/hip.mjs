import { load, surface } from "./lib.mjs";
const s = surface(load("merc"));
const band = s.filter((q) => q.p[2] > -4 && q.p[2] < 6);
const R = band.filter((q) => q.p[1] < 0), L = band.filter((q) => q.p[1] > 0);
const f = (a, k, fn) => fn(...a.map((q) => q.p[k]));
console.log(`  waist band z -4..6: ${band.length} tris`);
console.log(`  right hip  y min ${f(R,1,Math.min).toFixed(1)}   x ${f(R,0,Math.min).toFixed(1)}..${f(R,0,Math.max).toFixed(1)}`);
console.log(`  left  hip  y max ${f(L,1,Math.max).toFixed(1)}   x ${f(L,0,Math.min).toFixed(1)}..${f(L,0,Math.max).toFixed(1)}`);

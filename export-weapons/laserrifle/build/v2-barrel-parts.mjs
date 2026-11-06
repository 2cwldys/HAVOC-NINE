import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const g = scene.groups.find((x) => x.material === "Barrel");
const key = (p) => p.map((v) => v.toFixed(3)).join();
const parent = new Map();
const find = (k) => { let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
for (const t of g.tris) for (const c of t) if (!parent.has(key(c.p))) parent.set(key(c.p), key(c.p));
for (const t of g.tris) { const a = find(key(t[0].p)); for (const j of [1, 2]) { const b = find(key(t[j].p)); if (a !== b) parent.set(b, a); } }
const comps = new Map();
for (const t of g.tris) { const r = find(key(t[0].p)); (comps.get(r) ?? comps.set(r, []).get(r)).push(t); }
const rows = [...comps.values()].map((tris) => {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const t of tris) for (const c of t) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c.p[a]); mx[a] = Math.max(mx[a], c.p[a]); }
  return { n: tris.length, mn: mn.map((v) => +v.toFixed(1)), mx: mx.map((v) => +v.toFixed(1)), size: mx.map((v, a) => +(v - mn[a]).toFixed(1)) };
}).sort((a, b) => b.n - a.n);
console.log("components", rows.length);
for (const r of rows.slice(0, 16)) console.log(String(r.n).padStart(5), "tris  min", r.mn.join(","), " max", r.mx.join(","), " size", r.size.join("x"));

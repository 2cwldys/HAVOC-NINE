// Scratch: what the mech's arm/cannon region is made of in space, and which
// bones own it -- so added gear can be sized to the surface and bound to the
// same bone as the thing it wraps.
import { K, load, surface, POSE } from "./lib.mjs";

const src = load("ed209_ts");
const names = K.bones(src).map((b) => b.name);

const isl = K.uvIslands(src, POSE);
const mine = isl.list.filter((e) => e.tex === "ed209_sheet0.bmp" && e.mid[1] < -12 && e.mid[2] > 18);
console.log(`right-side upper islands: ${mine.length}  (bones named by index too)`);
for (const e of mine) {
  const f = (v) => v.map((n) => n.toFixed(1).padStart(6)).join(" ");
  const tris = Array.isArray(e.tris) ? e.tris.length : e.tris;
  let bb = "";
  if (Array.isArray(e.tris) && e.tris[0] && e.tris[0][0] && e.tris[0][0].p) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const t of e.tris) for (const c of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c.p[k]); hi[k] = Math.max(hi[k], c.p[k]); }
    bb = ` box [${f(lo)} | ${f(hi)}]`;
  }
  console.log(`  id ${String(e.id).padStart(3)} tris ${String(tris).padStart(4)} mid [${f(e.mid)}]${bb}  bones ${(e.bones ?? []).join(", ")}`);
}

const cloud = surface(src);

const table = (label, pts, key, lo, hi, step) => {
  const m = new Map();
  for (const q of pts) {
    const b = Math.floor(q.p[key] / step) * step;
    if (b < lo || b >= hi) continue;
    if (!m.has(b)) m.set(b, []);
    m.get(b).push(q.p);
  }
  console.log(`\n${label}: bucket ${"xyz"[key]} ${lo}..${hi} step ${step}`);
  for (const [b, ps] of [...m].sort((a, c) => a[0] - c[0])) {
    const rng = (k) => { const v = ps.map((p) => p[k]).sort((a, c) => a - c); return [v[0], v[v.length - 1]]; };
    const x = rng(0), y = rng(1), z = rng(2);
    console.log(`  ${String(b).padStart(4)} n ${String(ps.length).padStart(4)}  x ${x[0].toFixed(1)}..${x[1].toFixed(1)}  y ${y[0].toFixed(1)}..${y[1].toFixed(1)}  z ${z[0].toFixed(1)}..${z[1].toFixed(1)}`);
  }
};

const arm = cloud.filter((q) => q.p[1] < -15 && q.p[2] > 18);
table("RIGHT arm, along x", arm, 0, -12, 32, 4);
table("RIGHT arm, across y", arm, 1, -42, -14, 2);
table("shoulder tops (|y|>14)", cloud.filter((q) => q.p[2] > 32 && Math.abs(q.p[1]) > 14), 2, 32, 48, 2);
table("rear body (x<-2)", cloud.filter((q) => q.p[0] < -2 && Math.abs(q.p[1]) < 18 && q.p[2] > -16 && q.p[2] < 20), 2, -16, 20, 4);
table("dome (z>38)", cloud.filter((q) => q.p[2] > 38), 2, 38, 50, 2);
table("right muzzle (x>16, y<-24)", cloud.filter((q) => q.p[0] > 16 && q.p[1] < -24 && q.p[2] > 20), 0, 16, 32, 2);
table("legs low (z<-14)", cloud.filter((q) => q.p[2] < -14), 1, -28, 28, 4);

import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const o = scene.groups.find((x) => x.object === "Optic" && x.material === "Optic");
// triangles lying in a plane x = const (all three corners within 0.15), area by plane
const planes = new Map();
for (const t of o.tris) {
  const xs = t.map((c) => c.p[0]);
  if (Math.max(...xs) - Math.min(...xs) > 0.15) continue;
  const key = (xs[0] + xs[1] + xs[2]) / 3;
  const k = Math.round(key * 2) / 2;
  const [a, b, c] = t.map((q) => q.p);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  const e = planes.get(k) ?? { area: 0, n: 0, mn: [1e9, 1e9], mx: [-1e9, -1e9] };
  e.area += area; e.n++;
  for (const q of t) { e.mn[0] = Math.min(e.mn[0], q.p[1]); e.mn[1] = Math.min(e.mn[1], q.p[2]); e.mx[0] = Math.max(e.mx[0], q.p[1]); e.mx[1] = Math.max(e.mx[1], q.p[2]); }
  planes.set(k, e);
}
for (const [x, e] of [...planes].sort((a, b) => b[0] - a[0]).slice(0, 14)) console.log("x", x, "tris", e.n, "area", e.area.toFixed(0), "y", e.mn[0].toFixed(1), e.mx[0].toFixed(1), "z", e.mn[1].toFixed(1), e.mx[1].toFixed(1));
console.log("--- the x=49 face");
const face = o.tris.filter((t) => t.every((c) => Math.abs(c.p[0] - 49) < 0.3));
const pts = new Map();
for (const t of face) for (const c of t) pts.set(`${c.p[1].toFixed(1)},${c.p[2].toFixed(1)}`, c.p);
console.log([...pts.values()].map((p) => `(${p[1].toFixed(1)},${p[2].toFixed(1)})`).join(" "));
const normals = face.map((t) => { const [a,b,c] = t.map((q)=>q.p); const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]]; return Math.sign(u[1]*v[2]-u[2]*v[1]); });
console.log("x-facing sign (CCW normal x):", normals.join(" "));

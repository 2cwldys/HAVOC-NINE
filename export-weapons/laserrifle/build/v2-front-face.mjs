import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const o = scene.groups.find((x) => x.object === "Optic" && x.material === "Optic");
// big triangles (area) whose normal points toward -x (front)
const big = [];
for (const t of o.tris) {
  const [a, b, c] = t.map((q) => q.p);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n);
  if (len / 2 < 10) continue;
  const nx = n[0] / len;
  const cx = (a[0] + b[0] + c[0]) / 3;
  if (cx < -5 && Math.abs(nx) > 0.6) big.push({ area: len / 2, nx, ny: n[1] / len, nz: n[2] / len, c: [cx, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], pts: [a, b, c] });
}
console.log("front-facing big tris", big.length);
for (const r of big.slice(0, 20)) console.log("area", r.area.toFixed(0), "n", r.nx.toFixed(2), r.ny.toFixed(2), r.nz.toFixed(2), "c", r.c.map((v) => v.toFixed(1)).join(","), "pts", r.pts.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)},${p[2].toFixed(1)})`).join(" "));

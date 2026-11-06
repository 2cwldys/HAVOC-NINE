// What the FBX holds, part by part: triangles, whether its corners carry normals, and how many triangles wind
// the way their own normals say (a part whose triangles mostly do not is turned inside out for a viewer that
// culls back faces, as GoldSrc does).
import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";

const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
console.log("groups:", scene.groups.length, "keys:", Object.keys(scene).join(","));
const g0 = scene.groups[0];
console.log("group keys:", Object.keys(g0).join(","), "corner keys:", Object.keys(g0.tris[0][0]).join(","));
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rows = [];
for (const g of scene.groups) {
  let agree = 0, against = 0, zero = 0, noNormal = 0, area = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const tri of g.tris) {
    const [a, b, c] = tri.map((corner) => corner.p);
    const fn = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(...fn);
    area += len / 2;
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    if (len < 1e-12) { zero++; continue; }
    const n = tri.map((corner) => corner.n).filter(Boolean);
    if (!n.length) { noNormal++; continue; }
    const avg = [0, 0, 0];
    for (const v of n) for (let k = 0; k < 3; k++) avg[k] += v[k];
    const d = fn[0] * avg[0] + fn[1] * avg[1] + fn[2] * avg[2];
    if (d >= 0) agree++; else against++;
  }
  rows.push({ name: `${g.object || "-"} | ${g.material}`, tris: g.tris.length, agree, against, zero, noNormal, size: mx.map((v, k) => (v - mn[k]).toFixed(1)).join("x") });
}
for (const r of rows) console.log(r.name.padEnd(46), String(r.tris).padStart(7), "tris", "agree", String(r.agree).padStart(6), "against", String(r.against).padStart(6), "zero", r.zero, "nonormal", r.noNormal, "box", r.size);
console.log("total tris", rows.reduce((s, r) => s + r.tris, 0));

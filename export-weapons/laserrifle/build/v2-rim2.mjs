import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const o = scene.groups.find((x) => x.object === "Optic" && x.material === "Optic");
const rows = [];
for (const t of o.tris) {
  const xs = t.map((c) => c.p[0]);
  const cx = (xs[0] + xs[1] + xs[2]) / 3;
  if (cx < 46 || cx > 49.4) continue;
  const planar = Math.max(...xs) - Math.min(...xs) < 0.35;
  const ys = t.map((c) => c.p[1]), zs = t.map((c) => c.p[2]);
  rows.push({ cx: cx.toFixed(1), planar, x: `${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}`, y: `${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)}`, z: `${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}` });
}
const non = rows.filter((r) => !r.planar);
console.log("triangles with centroid x 46..49.4:", rows.length, "non-planar", non.length);
for (const r of non.slice(0, 60)) console.log(r.x.padEnd(12), "y", r.y.padEnd(14), "z", r.z);

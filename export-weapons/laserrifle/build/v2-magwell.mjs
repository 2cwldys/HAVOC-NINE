import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const g = (o, m) => scene.groups.find((x) => x.object === o && x.material === m);
const bottom = g("Rifle", "RifleBodyBottom"), mag = g("Magazine", "Magazine"), handle = g("Rifle", "Handle");
const box = (tris, sel = () => true) => {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const t of tris) for (const c of t) if (sel(c.p)) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c.p[a]); mx[a] = Math.max(mx[a], c.p[a]); }
  return { mn: mn.map((v) => +v.toFixed(1)), mx: mx.map((v) => +v.toFixed(1)) };
};
console.log("bottom", box(bottom.tris));
console.log("mag", box(mag.tris));
console.log("handle", box(handle.tris));
// the underside of the bottom body over the magazine's x range, in slices
for (let x = -14; x <= 28; x += 6) {
  const b = box(bottom.tris, (p) => p[0] >= x && p[0] < x + 6 && Math.abs(p[1]) < 3);
  console.log(`bottom x ${x}..${x + 6}: z ${b.mn[2]} .. ${b.mx[2]}`);
}
// the magazine's top slice
const m = box(mag.tris, (p) => p[2] > -52);
console.log("mag top slice", m);

import { readFileSync, writeFileSync } from "node:fs";
import { posed, render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const file = process.argv[2] ?? "D:/Downloads/TSM/laserrifle/out2/p_laserrifle.mdl";
const tag = process.argv[3] ?? "p";
const depth = Number(process.argv[4] ?? 2.6);
const src = readFileSync(file);
const out = posed(src, { seq: 0, frame: 0 });
let maxZ = -1e9;
for (const t of out.tris) for (const c of t.c) maxZ = Math.max(maxZ, c.p[2]);
const cen = (t, a) => (t.c[0].p[a] + t.c[1].p[a] + t.c[2].p[a]) / 3;
const hull = out.tris.filter((t) => cen(t, 2) > maxZ - 0.9);
const x0 = Math.min(...hull.map((t) => cen(t, 0))), x1 = Math.max(...hull.map((t) => cen(t, 0)));
const sel = out.tris.filter((t) => cen(t, 0) > x0 - 0.8 && cen(t, 0) < x1 + 0.8 && cen(t, 2) > maxZ - depth);
console.log("optic region tris", sel.length, "of", out.tris.length, "maxZ", maxZ.toFixed(2));
for (const [name, yaw, pitch] of [["rear", 180, 12], ["rear_l", 150, 20], ["rear_r", -150, 20], ["front_l", 30, 20], ["top", 180, 80]]) {
  const img = render(src, { tris: sel, view: "orbit", yaw, pitch, zoom: 1.0, width: 800, height: 520, cull: process.env.NOCULL ? false : true });
  writeFileSync(`D:/temp/lr/iso_${tag}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");

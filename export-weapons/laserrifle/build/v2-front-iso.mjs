import { readFileSync, writeFileSync } from "node:fs";
import { posed, render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const file = process.argv[2] ?? "D:/Downloads/TSM/laserrifle/out2/p_laserrifle.mdl";
const tag = process.argv[3] ?? "p";
const span = Number(process.argv[4] ?? 7);
const src = readFileSync(file);
const out = posed(src, { seq: 0, frame: 0 });
let maxX = -1e9;
for (const t of out.tris) for (const c of t.c) maxX = Math.max(maxX, c.p[0]);
const sel = out.tris.filter((t) => (t.c[0].p[0] + t.c[1].p[0] + t.c[2].p[0]) / 3 > maxX - span);
console.log("front tris", sel.length, "of", out.tris.length, "maxX", maxX.toFixed(2));
for (const [name, yaw, pitch] of [["left", 90, 0], ["top", 90, 85], ["fl", 55, 22], ["front", 0, 8]]) {
  const img = render(src, { tris: sel, view: "orbit", yaw, pitch, zoom: 1.0, width: 800, height: 480 });
  writeFileSync(`D:/temp/lr/front_${tag}_${name}.png`, png(img.width, img.height, img.rgba));
}

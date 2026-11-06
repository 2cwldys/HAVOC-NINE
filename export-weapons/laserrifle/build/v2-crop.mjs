import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync(process.argv[2] ?? "D:/Downloads/TSM/laserrifle/out2/p_laserrifle.mdl");
const tag = process.argv[3] ?? "p";
for (const [name, yaw, pitch] of [["fl", 35, 20], ["fr", -35, 20], ["front", 8, 10], ["top", 90, 80]]) {
  const img = render(src, { view: "orbit", yaw, pitch, zoom: 1.0, width: 2400, height: 1400 });
  writeFileSync(`D:/temp/lr/big_${tag}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");

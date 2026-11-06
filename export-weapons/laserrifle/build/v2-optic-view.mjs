import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync(process.argv[2] ?? "D:/Downloads/TSM/laserrifle/out2/p_laserrifle.mdl");
const tag = process.argv[3] ?? "p";
for (const [name, yaw, pitch] of [["rear_l", 150, 18], ["rear_r", -150, 18], ["rear_top", 180, 50], ["front_l", 35, 18]]) {
  const img = render(src, { view: "orbit", yaw, pitch, zoom: 2.2, width: 900, height: 600 });
  writeFileSync(`D:/temp/lr/opt_${tag}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");

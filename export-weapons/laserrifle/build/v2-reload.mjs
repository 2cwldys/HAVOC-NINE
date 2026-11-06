import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync("D:/Downloads/TSM/laserrifle/out2/v_laserrifle.mdl");
for (const f of [8, 22, 36, 50]) {
  const img = render(src, { view: "first", seq: 1, frame: f, width: 700, height: 520 });
  writeFileSync(`D:/temp/lr/reload_${f}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");

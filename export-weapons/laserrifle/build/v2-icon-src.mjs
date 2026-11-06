// The weapon select picture's source: the third person model from the side, lit, on black; where the model is dark
// (the black underside, the grip) a floor of grey so that the whole gun is drawn.
import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync("D:/Downloads/TSM/laserrifle/out2/p_laserrifle.mdl");
const o = { view: "side", pitch: 0, width: 1400, height: 520, zoom: 1.5 };
const lit = render(src, { ...o, background: [0, 0, 0] });
const sil = render(src, { ...o, background: [255, 0, 255] });
const rgba = new Uint8Array(lit.rgba);
for (let i = 0; i < lit.width * lit.height; i++) {
  const r = sil.rgba[i * 4], g = sil.rgba[i * 4 + 1], b = sil.rgba[i * 4 + 2];
  const background = r > 240 && g < 20 && b > 240;
  if (background) continue;
  for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(rgba[i * 4 + c], 78);
}
writeFileSync("D:/Downloads/TSM/laserrifle/out2/icon_src.png", png(lit.width, lit.height, rgba));
console.log("ok");

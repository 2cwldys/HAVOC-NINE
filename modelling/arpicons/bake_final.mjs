// Renders the weapons of Apollo RP's inventory to the pictures of its icon sheet: SMAK's software renderer (smak/src/icon.mjs), the
// long thing laid on the diagonal, 8 times the picture's size and reduced, the ground transparent.
//   node bake_final.mjs <manifest.json> <out folder> [picture size = 32]
// A manifest entry: {"name", "model" (a file of the TS models folder, or an absolute path), "flip" (the heavy end down: pistols), "roll", "lean"}.
// Writes <out folder>/<index>.png for each entry, RGBA.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { iconPicture, reducedPicture } from "file:///D:/Downloads/TSM/smak/src/icon.mjs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";

const MODELS = "D:/SteamLibrary/steamapps/common/Half-Life/ts/models/";
const items = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outDir = process.argv[3];
const to = Number(process.argv[4] || 32);
const k = 8;
const side = to * k;
mkdirSync(outDir, { recursive: true });

items.forEach((it, i) => {
  // a model of the TS models folder by its file name, or any model by an absolute path (H9's own weapons are in H9XASH	s\models\h9)
  const buf = readFileSync(/^([A-Za-z]:|\/)/.test(it.model) ? it.model : MODELS + it.model);
  const r = iconPicture(buf, { side, lie: "diagonal", flip: !!it.flip, roll: it.roll || 0, lean: it.lean || 0, levels: { gamma: 0.7, gain: 1.25 } });
  const rgb = reducedPicture(r.rgb, side, k);
  const rgba = new Uint8Array(to * to * 4);
  for (let p = 0; p < to * to; p++) {
    const R = rgb[p * 3], G = rgb[p * 3 + 1], B = rgb[p * 3 + 2];
    rgba[p * 4] = R; rgba[p * 4 + 1] = G; rgba[p * 4 + 2] = B;
    rgba[p * 4 + 3] = R + G + B > 6 ? 255 : 0;
  }
  writeFileSync(`${outDir}/${String(i).padStart(2, "0")}.png`, png(to, to, rgba));
});
console.log(`${items.length} pictures of ${to} x ${to} in ${outDir}`);

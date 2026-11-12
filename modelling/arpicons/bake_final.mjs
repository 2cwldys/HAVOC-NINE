// Renders the weapons of Apollo RP's inventory to the pictures of its icon sheet: SMAK's software renderer (smak/src/icon.mjs), the
// long thing laid on the diagonal, 8 times the picture's size and reduced, the ground transparent.
//   node bake_final.mjs <manifest.json> <out folder> [picture size = 32]
// A manifest entry: {"name", "model", "flip" (the heavy end down: pistols), "roll", "lean"}. "model" is a file of TS 3.0's models folder
// (the folder the environment variable H9_TS_MODELS names, else the Steam install's ts\models), a path from the repository's root written
// "@repo/H9XASH/ts/models/h9/w_ppsh41.mdl" (H9's own weapons), or an absolute path.
// Writes <out folder>/<index>.png for each entry, RGBA. SMAK is the repository's own (smak/), found from this file's place.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { iconPicture, reducedPicture } = await import(pathToFileURL(resolve(ROOT, "smak/src/icon.mjs")).href);
const { png } = await import(pathToFileURL(resolve(ROOT, "smak/src/image.mjs")).href);

const MODELS = (process.env.H9_TS_MODELS || "D:/SteamLibrary/steamapps/common/Half-Life/ts/models").replace(/\\/g, "/").replace(/\/+$/, "") + "/";
const items = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outDir = process.argv[3];
const to = Number(process.argv[4] || 32);
const k = 8;
const side = to * k;
mkdirSync(outDir, { recursive: true });

function modelFile(model) {
  if (model.startsWith("@repo/")) return resolve(ROOT, model.slice(6));
  if (/^([A-Za-z]:|\/)/.test(model)) return model;
  return MODELS + model;
}

items.forEach((it, i) => {
  const buf = readFileSync(modelFile(it.model));
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

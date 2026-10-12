// A model's texture changed: taken out, painted over by rule, and put back. The shape and its layout in the picture
// stay, so this is the least risky change there is.
//
//   node examples/03-reskin.mjs <model.mdl> <texture name or number> [output folder, default out]
//
// Three ways are shown, from the cheapest:
//   1. the palette alone (256 colours): a tint, a darker or a worn look, with every pixel left where it was
//   2. the pixels, painted again from the old ones by a rule
//   3. (in a comment) a picture somebody painted by hand, read from a PNG or a BMP
// To see where each part of the shape takes its colour from before painting: `smak uv <model.mdl> -o <folder>`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { textureOf, replaceTexture, rgbOf, rgbaOf, indexed, check, render, tile, png, uvMap, workshop } from "../src/index.mjs";

const [file, which = "0", OUT = "out"] = process.argv.slice(2);
if (!file) { console.error("usage: node examples/03-reskin.mjs <model.mdl> <texture name or number> [output folder]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const src = readFileSync(file), tex = /^\d+$/.test(which) ? Number(which) : which, old = textureOf(src, tex);
console.log(`${old.name}: ${old.width}x${old.height}, flags ${old.flags}`);

// ── 1. the palette: colder and darker ──
const palette = Uint8Array.from(old.palette, (v, i) => Math.min(255, Math.round(v * [0.62, 0.78, 1.05][i % 3])));
// a masked texture's last colour is its holes: it has to stay as it is
if (old.flags & 64) palette.set(old.palette.subarray(765), 765);
const tinted = replaceTexture(src, tex, { ...old, palette });

// ── 2. the pixels: the old picture with rust eaten into it, by the workshop's noise ──
const image = rgbOf({ width: old.width, height: old.height, rgba: rgbaOf(old) });
for (let y = 0; y < old.height; y++) for (let x = 0; x < old.width; x++) {
  const i = (y * old.width + x) * 3, was = [image.rgb[i] / 255, image.rgb[i + 1] / 255, image.rgb[i + 2] / 255];
  const eaten = workshop.step(0.5, 0.68, workshop.fbm(x / 14, y / 14, 3, 4)), c = workshop.mix(was, workshop.rust(x / 9, y / 9, 5), eaten * 0.85);
  for (let k = 0; k < 3; k++) image.rgb[i + k] = Math.round(255 * Math.min(1, c[k]));
}
// (a masked texture would go through `masked` instead of `indexed`, to keep its holes)
const rusted = replaceTexture(src, tex, { ...indexed(image, old.name), flags: old.flags });

// ── 3. a picture painted by hand ──
//   import { textureFrom } from "../src/index.mjs";
//   const mine = replaceTexture(src, tex, { ...textureFrom(readFileSync("painted.png"), old.name), flags: old.flags });
// It may be of another size: every corner that wears it is moved to the same place in the new picture.

for (const [name, mdl] of [["tinted", tinted], ["rusted", rusted]]) {
  const r = check(mdl); if (r.errors.length) { console.error(r.errors.join("\n")); process.exit(1); }
  writeFileSync(join(OUT, `${basename(file, ".mdl")}_${name}.mdl`), mdl);
}
const o = { width: 400, height: 400, body: Number(process.env.BODY ?? 0) }, all = tile([render(src, o), render(tinted, o), render(rusted, o)], 3, ["as it was", "palette tinted", "rusted"]);
writeFileSync(join(OUT, "reskin.png"), png(all.width, all.height, all.rgba));
const map = uvMap(src, tex);
writeFileSync(join(OUT, "reskin_uv.png"), png(map.width, map.height, map.rgba));
console.log(`${OUT}: two models, reskin.png (the three side by side), reskin_uv.png (${map.triangles} triangles wear ${old.name})`);

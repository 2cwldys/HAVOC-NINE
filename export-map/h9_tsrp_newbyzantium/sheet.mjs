// sheet.mjs: several renders laid out on one sheet, half size, two across, to look at side by side.
//   node sheet.mjs out.png a.png b.png ...
import { readFileSync, writeFileSync } from "node:fs";
import { K } from "../lib.mjs";

const [out, ...files] = process.argv.slice(2);
const pics = files.map((f) => K.unpng(readFileSync(f)));
const cw = 400;
const ch = 240;
const cols = 2;
const rows = Math.ceil(pics.length / cols);
const rgba = new Uint8Array(cols * cw * rows * ch * 4);
pics.forEach((p, k) => {
  const ox = (k % cols) * cw;
  const oy = Math.floor(k / cols) * ch;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(p.width - 1, Math.floor((x * p.width) / cw));
      const sy = Math.min(p.height - 1, Math.floor((y * p.height) / ch));
      const s = (sy * p.width + sx) * 4;
      const d = ((oy + y) * cols * cw + ox + x) * 4;
      const edge = x === 0 || y === 0;
      for (let c = 0; c < 3; c++) rgba[d + c] = edge ? 255 : p.rgba[s + c];
      rgba[d + 3] = 255;
    }
});
writeFileSync(out, K.png(cols * cw, rows * ch, rgba));

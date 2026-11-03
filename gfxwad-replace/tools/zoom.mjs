import { readFileSync, writeFileSync } from "node:fs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const b = readFileSync(process.argv[2]);
const t = b.readInt32LE(8);
const only = new Set(["LAMBDA", "LAMBDA64", "LAMBDA32", "PAUSED"]);
for (let i = 0; i < b.readInt32LE(4); i++) {
  const a = t + i * 32;
  const n = b.toString("latin1", a + 16, a + 32).replace(/\0.*$/, "");
  if (!only.has(n)) continue;
  const fp = b.readInt32LE(a);
  const d = b.subarray(fp, fp + b.readInt32LE(a + 4));
  const w = d.readInt32LE(0);
  const h = d.readInt32LE(4);
  const pa = 8 + w * h;
  const pal = [];
  for (let k = 0; k < d.readUInt16LE(pa); k++)
    pal.push([d[pa + 2 + k * 3], d[pa + 3 + k * 3], d[pa + 4 + k * 3]]);
  const S = 4;
  const W = w * S;
  const H = h * S;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const idx = d[8 + ((y / S) | 0) * w + ((x / S) | 0)];
      const c = pal[idx] || [255, 0, 255];
      const o = (y * W + x) * 4;
      const al = idx === 255 ? 0 : 1;
      rgba[o] = Math.round(c[0] * al + 20 * (1 - al));
      rgba[o + 1] = Math.round(c[1] * al + 12 * (1 - al));
      rgba[o + 2] = Math.round(c[2] * al + 32 * (1 - al));
      rgba[o + 3] = 255;
    }
  writeFileSync(`art/original/${n}_x4.png`, png(W, H, rgba));
  console.log(n, w, h);
}

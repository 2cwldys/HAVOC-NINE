import { readFileSync, writeFileSync } from "node:fs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const b = readFileSync(process.argv[2]);
const out = process.argv[3];
const num = b.readInt32LE(4), table = b.readInt32LE(8);
for (let i = 0; i < num; i++) {
  const at = table + i * 32;
  const name = b.toString("latin1", at + 16, at + 32).replace(/\0.*$/, "");
  if (b[at + 12] !== 0x46 || name !== "CONCHARS") continue;
  const fp = b.readInt32LE(at), disk = b.readInt32LE(at + 4);
  const d = b.subarray(fp, fp + disk);
  const W = 256, H = 128, pixAt = 16 + 1024;
  const picks = [
    ["mask_non255", (v) => v !== 255],
    ["only0", (v) => v === 0],
    ["only1", (v) => v === 1],
    ["only2", (v) => v === 2],
    ["only3", (v) => v === 3],
    ["only4_7", (v) => v >= 4 && v <= 7],
    ["other_8_254", (v) => v >= 8 && v <= 254],
  ];
  for (const [label, test] of picks) {
    const rgba = Buffer.alloc(W * H * 4);
    for (let k = 0; k < W * H; k++) {
      const on = test(d[pixAt + k]);
      rgba[k * 4] = on ? 255 : 20;
      rgba[k * 4 + 1] = on ? 255 : 20;
      rgba[k * 4 + 2] = on ? 255 : 20;
      rgba[k * 4 + 3] = 255;
    }
    writeFileSync(`${out}/CONCHARS_${label}.png`, png(W, H, rgba));
  }
  console.log("wrote masks");
}

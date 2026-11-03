import { readFileSync } from "node:fs";
import { unpng } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const p = process.argv[2];
const { width, height, rgba } = unpng(readFileSync(p));
console.log(`${p}: ${width}x${height}`);
const counts = new Map();
let minA = 255, maxA = 0;
for (let i = 0; i < width * height; i++) {
  const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
  minA = Math.min(minA, a);
  maxA = Math.max(maxA, a);
  const key = `${r},${g},${b},${a}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`alpha ${minA}..${maxA}, unique RGBA ${counts.size}`);
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [key, n] of top) console.log(`  ${n.toString().padStart(7)}  ${key}`);
console.log("corners:", [0, width - 1, (height - 1) * width, width * height - 1].map((i) => [...rgba.subarray(i * 4, i * 4 + 4)].join(",")).join(" | "));

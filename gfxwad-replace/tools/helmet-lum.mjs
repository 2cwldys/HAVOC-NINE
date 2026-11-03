import { readFileSync } from "node:fs";
import { unpng } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const { width, height, rgba } = unpng(readFileSync(process.argv[2]));
let minX = width, minY = height, maxX = -1, maxY = -1;
const lums = [];
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const a = rgba[i + 3];
    if (a < 8) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (a > 200) lums.push((0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255);
  }
lums.sort((a, b) => a - b);
const pct = (p) => lums[Math.floor((lums.length - 1) * p)];
console.log(`image ${width}x${height}, opaque bbox ${minX},${minY}..${maxX},${maxY} (${maxX - minX + 1}x${maxY - minY + 1})`);
console.log(`opaque pixels ${lums.length}, luminance percentiles:`);
for (const p of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1]) console.log(`  ${(p * 100).toFixed(0).padStart(3)}% ${pct(p).toFixed(3)}`);
// histogram in 16 buckets
const hist = new Array(16).fill(0);
for (const l of lums) hist[Math.min(15, Math.floor(l * 16))]++;
console.log("hist:", hist.join(" "));

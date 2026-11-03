import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]);
const num = b.readInt32LE(4), table = b.readInt32LE(8);
for (let i = 0; i < num; i++) {
  const at = table + i * 32;
  const name = b.toString("latin1", at + 16, at + 32).replace(/\0.*$/, "");
  if (b[at + 12] !== 0x46) continue;
  const fp = b.readInt32LE(at), disk = b.readInt32LE(at + 4);
  const d = b.subarray(fp, fp + disk);
  const W = 256, H = d.readInt32LE(4);
  const pixAt = 16 + 1024;
  const palAt = pixAt + W * H;
  const n = d.readUInt16LE(palAt);
  const pal = [];
  for (let k = 0; k < n; k++) pal.push([d[palAt + 2 + k * 3], d[palAt + 3 + k * 3], d[palAt + 4 + k * 3]]);
  const counts = new Map();
  for (let k = 0; k < W * H; k++) counts.set(d[pixAt + k], (counts.get(d[pixAt + k]) ?? 0) + 1);
  console.log(`\n=== ${name} palette n=${n} ===`);
  const used = [...counts.entries()].sort((a, c) => c[1] - a[1]);
  for (const [idx, count] of used.slice(0, 30)) {
    const c = pal[idx];
    const L = Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
    console.log(`  ${String(idx).padStart(3)}: ${String(count).padStart(5)}  rgb(${c.join(",")})  L=${L}`);
  }
}

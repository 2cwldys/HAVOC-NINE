import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]);
const num = b.readInt32LE(4), table = b.readInt32LE(8);
for (let i = 0; i < num; i++) {
  const at = table + i * 32;
  const name = b.toString("latin1", at + 16, at + 32).replace(/\0.*$/, "");
  if (b[at + 12] !== 0x46) continue;
  const fp = b.readInt32LE(at), disk = b.readInt32LE(at + 4);
  const d = b.subarray(fp, fp + disk);
  const head = [0, 4, 8, 12].map((o) => d.readInt32LE(o));
  console.log(`\n=== ${name} header=[${head}] ===`);
  const info = [];
  for (let c = 0; c < 256; c++) {
    info.push({ c, start: d.readInt16LE(16 + c * 4), width: d.readInt16LE(18 + c * 4) });
  }
  const used = info.filter((g) => g.start >= 0 && g.width > 0);
  console.log("used glyphs:", used.length);
  console.log("first 8 used:", used.slice(0, 8).map((g) => `${g.c}(${JSON.stringify(String.fromCharCode(g.c))}) @${g.start} w${g.width}`).join(" "));
  for (const ch of "A!ag0W ~") {
    const g = info[ch.charCodeAt(0)];
    console.log(`  '${ch}' code=${ch.charCodeAt(0)} start=${g.start} width=${g.width} -> x=${g.start % 256} y=${Math.floor(g.start / 256)}`);
  }
  const maxEnd = Math.max(...used.map((g) => g.start + g.width));
  const maxStart = Math.max(...used.map((g) => g.start));
  console.log(`maxStart=${maxStart} maxEnd=${maxEnd}`);
  // row extents by startoffset
  const rows = new Map();
  for (const g of used) {
    const y = Math.floor(g.start / 256);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(g);
  }
  for (const [y, gs] of [...rows.entries()].sort((a, c) => a[0] - c[0])) {
    console.log(`  row y=${y}: ${gs.length} glyphs, x ${Math.min(...gs.map((g) => g.start % 256))}..${Math.max(...gs.map((g) => g.start % 256 + g.width))}`);
  }
}

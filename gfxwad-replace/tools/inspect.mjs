// Reads gfx.wad, prints the true lump layout, palettes and pixel histograms,
// and writes correct previews (fonts start after the 1024-byte charinfo table).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";

const src = process.argv[2];
const out = process.argv[3];
mkdirSync(out, { recursive: true });

const b = readFileSync(src);
const numlumps = b.readInt32LE(4);
const table = b.readInt32LE(8);
const lumps = [];

for (let i = 0; i < numlumps; i++) {
  const at = table + i * 32;
  lumps.push({
    name: b.toString("latin1", at + 16, at + 32).replace(/\0.*$/, ""),
    type: b[at + 12],
    filepos: b.readInt32LE(at),
    disk: b.readInt32LE(at + 4),
  });
}

function paletteAt(d, at) {
  const n = d.readUInt16LE(at);
  const pal = [];
  for (let i = 0; i < n; i++)
    pal.push([d[at + 2 + i * 3], d[at + 3 + i * 3], d[at + 4 + i * 3]]);
  return { n, pal };
}

function save(name, w, h, rgba) {
  writeFileSync(`${out}/${name}.png`, png(w, h, rgba));
}

for (const lump of lumps) {
  const d = b.subarray(lump.filepos, lump.filepos + lump.disk);
  console.log(`\n=== ${lump.name} type=0x${lump.type.toString(16)} bytes=${lump.disk} ===`);

  if (lump.type === 0x42) {
    const w = d.readInt32LE(0);
    const h = d.readInt32LE(4);
    const { n, pal } = paletteAt(d, 8 + w * h);
    const used = new Map();
    for (let i = 0; i < w * h; i++) used.set(d[8 + i], (used.get(d[8 + i]) ?? 0) + 1);
    const top = [...used.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8);
    console.log(`picture ${w}x${h} palette n=${n} unique=${used.size}`);
    console.log("  top indices:", top.map(([k, v]) => `${k}:${v}`).join(" "));
    console.log("  palette[0..7]:", pal.slice(0, 8).map((c) => `(${c})`).join(" "));
    console.log("  palette[248..255]:", pal.slice(248, 256).map((c) => `(${c})`).join(" "));

    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = d[8 + i];
      const c = pal[idx] ?? [255, 0, 255];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = idx === 255 ? 0 : 255;
    }
    save(`${lump.name}_true`, w, h, rgba);
    continue;
  }

  if (lump.type === 0x46) {
    const head = [0, 4, 8, 12].map((o) => d.readInt32LE(o));
    const W = 256;
    const H = head[1];
    const pixAt = 16 + 1024;
    const { n, pal } = paletteAt(d, pixAt + W * H);
    const used = new Map();
    for (let i = 0; i < W * H; i++) used.set(d[pixAt + i], (used.get(d[pixAt + i]) ?? 0) + 1);
    const top = [...used.entries()].sort((a, c) => c[1] - a[1]).slice(0, 12);
    console.log(`font header=[${head}] atlas ${W}x${H} palette n=${n} unique=${used.size}`);
    console.log("  top indices:", top.map(([k, v]) => `${k}:${v}`).join(" "));
    console.log("  palette[0..7]:", pal.slice(0, 8).map((c) => `(${c})`).join(" "));
    console.log("  palette[248..255]:", pal.slice(248, 256).map((c) => `(${c})`).join(" "));

    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const idx = d[pixAt + i];
      const c = pal[idx] ?? [255, 0, 255];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = idx === 255 ? 0 : 255;
    }
    save(`${lump.name}_true`, W, H, rgba);

    // a version on a dark background so the glyphs are readable in a viewer
    const bg = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const a = rgba[i * 4 + 3] / 255;
      bg[i * 4] = Math.round(rgba[i * 4] * a + 18 * (1 - a));
      bg[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + 12 * (1 - a));
      bg[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + 28 * (1 - a));
      bg[i * 4 + 3] = 255;
    }
    save(`${lump.name}_on_dark`, W, H, bg);
    continue;
  }

  console.log("  (not a picture or font)");
}

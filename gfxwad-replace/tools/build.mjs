// Builds a purple H9 replacement for Half-Life's gfx.wad.
//
// The safest possible change: start from the original WAD3 byte for byte and
// rewrite only palette RGB triples (plus BACKTILE's pixels for a subtle grid).
// Every lump keeps its name, type, offset and size, so the engine sees exactly
// the structure it expects. Index 255 stays the transparent key everywhere.
//
// Usage:
//   node tools/build.mjs [source.gfx.wad] [dist folder] [art folder]
//
// Defaults:
//   source: D:\Downloads\TSM\backups\valve_TSM_20261030-230114\gfx.wad
//   dist:   dist
//   art:    art\purple

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { png, unpng } from "file:///D:/Downloads/TSM/smak/src/image.mjs";

const SRC =
  process.argv[2] ?? "D:\\Downloads\\TSM\\backups\\valve_TSM_20261030-230114\\gfx.wad";
const DIST = process.argv[3] ?? "dist";
const ART = process.argv[4] ?? "art/purple";
const HELMET = process.argv[5] ?? "D:\\Downloads\\TSM\\havoc9.org\\h9helmet.png";

mkdirSync(DIST, { recursive: true });
mkdirSync(ART, { recursive: true });

const wad = readFileSync(SRC);
const numlumps = wad.readInt32LE(4);
const table = wad.readInt32LE(8);
const original = Buffer.from(wad);

// ---- H9 purple ramps -------------------------------------------------------
// Each stop is [position 0..1, [r, g, b]]. Positions are original luminance.
const PICTURE = [
  [0.0, [10, 4, 18]],
  [0.2, [44, 16, 72]],
  [0.4, [100, 42, 158]],
  [0.6, [158, 92, 224]],
  [0.8, [198, 148, 252]],
  [1.0, [244, 232, 255]],
];

const FONT = [
  [0.0, [44, 18, 72]],
  [0.16, [108, 50, 166]],
  [0.4, [150, 82, 214]],
  [0.58, [186, 126, 246]],
  [0.8, [214, 174, 252]],
  [1.0, [244, 232, 255]],
];

const CREDITS = [
  [0.0, [14, 7, 24]],
  [0.1, [44, 18, 72]],
  [0.5, [150, 82, 214]],
  [0.75, [198, 146, 249]],
  [1.0, [244, 232, 255]],
];

// The helmet is black with orange trim. Its luminance is bimodal: the black
// shell sits at 0..0.1 and the orange trim at 0.45..0.6. This ramp keeps the
// shell almost black and turns the trim into a vivid purple with lavender
// highlights.
const HELMET_RAMP = [
  [0.0, [28, 13, 46]],
  [0.08, [44, 22, 72]],
  [0.2, [62, 32, 100]],
  [0.35, [92, 48, 148]],
  [0.45, [132, 72, 202]],
  [0.52, [176, 106, 246]],
  [0.6, [208, 158, 255]],
  [0.75, [230, 196, 255]],
  [1.0, [246, 236, 255]],
];

const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    if (t <= p1) {
      const [p0, c0] = stops[i - 1];
      const k = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return [0, 1, 2].map((n) => Math.round(c0[n] + (c1[n] - c0[n]) * k));
    }
  }
  return stops[stops.length - 1][1].slice();
}

// ---- lump table ------------------------------------------------------------
const lumps = [];
for (let i = 0; i < numlumps; i++) {
  const at = table + i * 32;
  lumps.push({
    name: wad.toString("latin1", at + 16, at + 32).replace(/\0.*$/, ""),
    type: wad[at + 12],
    filepos: wad.readInt32LE(at),
    disk: wad.readInt32LE(at + 4),
  });
}

function paletteOffset(lump) {
  const d = wad.subarray(lump.filepos, lump.filepos + lump.disk);
  if (lump.type === 0x42) {
    const w = d.readInt32LE(0);
    const h = d.readInt32LE(4);
    return lump.filepos + 8 + w * h;
  }
  if (lump.type === 0x46) {
    const h = d.readInt32LE(4);
    return lump.filepos + 16 + 1024 + 256 * h;
  }
  return -1;
}

function setPalette(lump, fn) {
  const at = paletteOffset(lump);
  if (at < 0) return;
  const count = wad.readUInt16LE(at);
  for (let i = 0; i < count; i++) {
    if (i === 255) continue; // transparent key stays untouched
    const o = at + 2 + i * 3;
    const [r, g, b] = [wad[o], wad[o + 1], wad[o + 2]];
    const [nr, ng, nb] = fn([r, g, b], i);
    wad[o] = nr;
    wad[o + 1] = ng;
    wad[o + 2] = nb;
  }
}

// Replaces the 32x32 lambda logo with the H9 helmet: crop to the visible
// pixels, fit to the canvas without stretching, box-filter the alpha, and
// map the result's luminance through HELMET_RAMP. The palette is rebuilt so
// index i holds ramp(i/254); 255 stays the transparent key.
function paintHelmet(lump) {
  const { width: sw, height: sh, rgba } = unpng(readFileSync(HELMET));

  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (rgba[(y * sw + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error(`${HELMET} has no visible pixels`);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;

  const d = wad.subarray(lump.filepos, lump.filepos + lump.disk);
  const W = d.readInt32LE(0);
  const H = d.readInt32LE(4);

  const fit = Math.min(W / bw, H / bh);
  const tw = Math.max(1, Math.round(bw * fit));
  const th = Math.max(1, Math.round(bh * fit));
  const ox = Math.floor((W - tw) / 2);
  const oy = Math.floor((H - th) / 2);

  const pixels = new Uint8Array(W * H).fill(255);
  let visible = 0;

  for (let ty = 0; ty < th; ty++) {
    const sy0 = y0 + (ty * bh) / th;
    const sy1 = y0 + ((ty + 1) * bh) / th;
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = x0 + (tx * bw) / tw;
      const sx1 = x0 + ((tx + 1) * bw) / tw;

      let aSum = 0, rSum = 0, gSum = 0, bSum = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const i = (sy * sw + sx) * 4;
          const a = rgba[i + 3] / 255;
          aSum += a;
          rSum += rgba[i] * a;
          gSum += rgba[i + 1] * a;
          bSum += rgba[i + 2] * a;
          n++;
        }
      }

      if (!n || aSum / n < 0.5) continue; // transparent edge
      const c = aSum > 0 ? [rSum / aSum, gSum / aSum, bSum / aSum] : [0, 0, 0];
      const idx = Math.max(0, Math.min(254, Math.round(lum(c) * 254)));
      pixels[(oy + ty) * W + (ox + tx)] = idx;
      visible++;
    }
  }

  d.set(pixels, 8);

  const palAt = 8 + W * H;
  for (let i = 0; i < 255; i++) {
    const [r, g, b] = ramp(HELMET_RAMP, i / 254);
    d[palAt + 2 + i * 3] = r;
    d[palAt + 3 + i * 3] = g;
    d[palAt + 4 + i * 3] = b;
  }

  changed.push(
    `${lump.name}: purple h9helmet ${tw}x${th} in ${W}x${H} (${visible} opaque px)`
  );
  return { tw, th, visible, bw, bh };
}

const changed = [];

for (const lump of lumps) {
  if (lump.type === 0x42) {
    if (lump.name === "LAMBDA" || lump.name === "LAMBDA64") {
      // original: index 0 outline (black), index 1 fill (orange)
      setPalette(lump, ([r, g, b], i) =>
        i === 0 ? [20, 10, 32] : i === 1 ? [176, 108, 255] : ramp(PICTURE, lum([r, g, b]))
      );
      changed.push(`${lump.name}: outline #140a20, fill #b06cff`);
    } else if (lump.name === "PAUSED") {
      // original: index 0 fill (orange), index 1 outline (black)
      setPalette(lump, ([r, g, b], i) =>
        i === 0 ? [201, 160, 255] : i === 1 ? [20, 10, 32] : ramp(PICTURE, lum([r, g, b]))
      );
      changed.push(`${lump.name}: fill #c9a0ff, outline #140a20`);
    } else if (lump.name === "LAMBDA32") {
      paintHelmet(lump);
    } else if (lump.name === "BACKTILE") {
      // dark purple tile with a subtle 16 px grid; both repeat seamlessly
      setPalette(lump, ([r, g, b], i) =>
        i === 223 ? [20, 11, 30] : i === 189 ? [34, 20, 52] : ramp(PICTURE, lum([r, g, b]))
      );
      const d = wad.subarray(lump.filepos, lump.filepos + lump.disk);
      const w = d.readInt32LE(0);
      const h = d.readInt32LE(4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          d[8 + y * w + x] = x % 16 === 0 || y % 16 === 0 ? 189 : 223;
        }
      }
      changed.push(`${lump.name}: #140b1e with #221434 grid every 16 px`);
    } else {
      setPalette(lump, ([r, g, b]) => ramp(PICTURE, lum([r, g, b])));
      changed.push(`${lump.name}: purple luminance ramp`);
    }
  } else if (lump.type === 0x46) {
    const stops = lump.name === "CREDITSFONT" ? CREDITS : FONT;
    setPalette(lump, ([r, g, b]) => ramp(stops, lum([r, g, b])));
    changed.push(`${lump.name}: purple ${lump.name === "CREDITSFONT" ? "credits" : "console"} ramp`);
  }
}

// ---- write the WAD ---------------------------------------------------------
const outFile = `${DIST}/gfx.wad`;
writeFileSync(outFile, wad);
const sha = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();

// ---- previews --------------------------------------------------------------
function save(name, w, h, rgba) {
  writeFileSync(`${ART}/${name}.png`, png(w, h, rgba));
}

function previewLump(lump) {
  const d = wad.subarray(lump.filepos, lump.filepos + lump.disk);
  if (lump.type === 0x42) {
    const w = d.readInt32LE(0);
    const h = d.readInt32LE(4);
    const palAt = 8 + w * h;
    const pal = [];
    for (let i = 0; i < d.readUInt16LE(palAt); i++)
      pal.push([d[palAt + 2 + i * 3], d[palAt + 3 + i * 3], d[palAt + 4 + i * 3]]);
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = d[8 + i];
      const c = pal[idx] ?? [255, 0, 255];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = idx === 255 ? 0 : 255;
    }
    save(`${lump.name}_purple`, w, h, rgba);
    if (lump.name === "LAMBDA32") {
      // 8x nearest-neighbour on the H9 dark background, for inspection
      const S = 8;
      const ZW = w * S;
      const ZH = h * S;
      const zoom = Buffer.alloc(ZW * ZH * 4);
      for (let y = 0; y < ZH; y++) {
        for (let x = 0; x < ZW; x++) {
          const s = (((y / S) | 0) * w + ((x / S) | 0)) * 4;
          const t = (y * ZW + x) * 4;
          const a = rgba[s + 3] / 255;
          zoom[t] = Math.round(rgba[s] * a + 20 * (1 - a));
          zoom[t + 1] = Math.round(rgba[s + 1] * a + 12 * (1 - a));
          zoom[t + 2] = Math.round(rgba[s + 2] * a + 32 * (1 - a));
          zoom[t + 3] = 255;
        }
      }
      save(`${lump.name}_purple_x8`, ZW, ZH, zoom);
    }
    return { w, h, rgba };
  }
  if (lump.type === 0x46) {
    const W = 256;
    const H = d.readInt32LE(4);
    const pixAt = 16 + 1024;
    const palAt = pixAt + W * H;
    const pal = [];
    for (let i = 0; i < d.readUInt16LE(palAt); i++)
      pal.push([d[palAt + 2 + i * 3], d[palAt + 3 + i * 3], d[palAt + 4 + i * 3]]);
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const idx = d[pixAt + i];
      const c = pal[idx] ?? [255, 0, 255];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = idx === 255 ? 0 : 255;
    }
    save(`${lump.name}_purple`, W, H, rgba);
    // readable version on a dark H9 background
    const bg = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const a = rgba[i * 4 + 3] / 255;
      bg[i * 4] = Math.round(rgba[i * 4] * a + 20 * (1 - a));
      bg[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + 12 * (1 - a));
      bg[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + 32 * (1 - a));
      bg[i * 4 + 3] = 255;
    }
    save(`${lump.name}_purple_on_dark`, W, H, bg);
    return { w: W, h: H, rgba };
  }
  return null;
}

const previews = new Map();
for (const lump of lumps) {
  const p = previewLump(lump);
  if (p) previews.set(lump.name, p);
}

// ---- plaques contact sheet -------------------------------------------------
// five plaques in a row, each on a dark tile, nearest-neighbour scaled to fit
const cellW = 128;
const sheetW = 5 * cellW;
const sheetH = 128;
const sheet = Buffer.alloc(sheetW * sheetH * 4);
for (let i = 0; i < sheetW * sheetH; i++) {
  sheet[i * 4] = 20;
  sheet[i * 4 + 1] = 12;
  sheet[i * 4 + 2] = 32;
  sheet[i * 4 + 3] = 255;
}
const plaqueNames = ["LAMBDA", "LAMBDA64", "LAMBDA32", "PAUSED", "BACKTILE"];
plaqueNames.forEach((name, n) => {
  const p = previews.get(name);
  if (!p) return;
  const scale = p.w <= 32 ? 4 : p.w <= 64 ? 2 : 1;
  const dw = p.w * scale;
  const dh = p.h * scale;
  const ox = n * cellW + (cellW - dw) / 2;
  const oy = (sheetH - dh) / 2;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const s = ((y / scale | 0) * p.w + (x / scale | 0)) * 4;
      const t = (Math.floor(oy + y) * sheetW + Math.floor(ox + x)) * 4;
      const a = p.rgba[s + 3] / 255;
      sheet[t] = Math.round(p.rgba[s] * a + 20 * (1 - a));
      sheet[t + 1] = Math.round(p.rgba[s + 1] * a + 12 * (1 - a));
      sheet[t + 2] = Math.round(p.rgba[s + 2] * a + 32 * (1 - a));
      sheet[t + 3] = 255;
    }
  }
});
save("plaques_purple", sheetW, sheetH, sheet);

// ---- report ----------------------------------------------------------------
const lines = [];
lines.push("H9 purple gfx.wad replacement");
lines.push(`source : ${SRC}`);
lines.push(`output : ${outFile}`);
lines.push(`size   : ${original.length} bytes in, ${wad.length} bytes out`);
lines.push(`sha256 : ${sha(original)} (original)`);
lines.push(`sha256 : ${sha(wad)} (purple)`);
lines.push("");
lines.push("lumps (unchanged names, types, offsets and sizes):");
for (const l of lumps) {
  lines.push(`  ${l.name.padEnd(12)} type=0x${l.type.toString(16)} pos=${String(l.filepos).padStart(6)} bytes=${l.disk}`);
}
lines.push("");
lines.push("changes:");
for (const c of changed) lines.push(`  ${c}`);
lines.push("");
lines.push("index 255 (transparent key) left untouched in every lump.");
lines.push(`previews: ${ART}`);

const report = lines.join("\r\n") + "\r\n";
writeFileSync(`${DIST}/REPORT.txt`, report);
console.log(report);

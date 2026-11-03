// The havoc9.org level badges: one picture for each level, Lv 0 to 99, the number in it.
//
//     node make-level-badges.mjs [--out <folder>] [--tga <folder>] [--sheet <file.png>] [--only <level>]
//
//   ../havoc9.org/assets/levels/lv-<N>-24.png   inline beside a name (forum posts, lists)
//   ../havoc9.org/assets/levels/lv-<N>-48.png   the same at twice the pixels, for sharp screens
//   ../havoc9.org/assets/levels/lv-<N>-96.png   large, on a profile and the player's card
//   <ts>/gfx/vgui/h9_levels/lv-<N>.tga          the in-game scoreboard's copy (64 x 64, 32-bit
//                                               RLE TGA with alpha, rows top first), which
//                                               client.dll scales to the row: in every client's ts
//                                               folder (CONFIG.tgaOut; --tga writes one folder
//                                               instead)
//   D:/temp/level-badges-sheet.png              every level at 96 and at 24, ten to a row (one
//                                               tier a row, Lv 0 in the last cell), to judge them
//                                               by eye
//
// The art changes every ten levels (TIERS below): Lv 1-10 a plain disc, then a rounded
// square, a diamond, a hexagon, a shield, an octagon with a double rim, a winged hexagon, a
// shield in a laurel, a star, and for 91-99 a radiant disc under a crown, each tier brighter
// and more ornate than the last. Lv 0, an account with no rated match yet (UNRANKED below), is
// the plain disc again, quieter: darker, its rim broken into dashes, its number lavender. All
// of it is drawn here, from shapes and a stroke font, in H9's purple family (#be8cff, and the
// panels' 133 98 178 / 182 145 234); nothing comes from outside art. Everything that decides the
// look sits in CONFIG, TIERS and UNRANKED, so a change is one edit and a rerun (about ten
// seconds).
//
// HOW IT DRAWS. Each badge is drawn at SS times its size, one sample a sub-pixel, then
// averaged down, which is the anti-aliasing. Shapes are signed distances in a square from -1 to
// 1 (negative inside); the number is a stroke font on a 4 by 6 grid, white with a dark edge so
// it reads at 24 pixels. The PNG writer is SMAK's (smak/src/image.mjs); the TGA writer is below.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { png } from "../smak/src/image.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  out: join(HERE, "..", "havoc9.org", "assets", "levels"),
  sheet: "D:/temp/level-badges-sheet.png",
  sizes: [24, 48, 96],
  supersample: { 24: 5, 48: 4, 64: 4, 96: 3 },
  // the in-game scoreboard's copies (reTS cl_dll/vgui_ScorePanel.cpp, H9 LEVEL BADGES): the
  // Xash overlay H9XASH is built from, H9XASH itself, and the GoldSrc package export.bat takes
  tgaSize: 64,
  tgaOut: [
    join(HERE, "..", "xash3d-h9-patches", "overlay", "ts", "gfx", "vgui", "h9_levels"),
    join(HERE, "..", "H9XASH", "ts", "gfx", "vgui", "h9_levels"),
    join(HERE, "..", "reTS", "binaries", "ts", "gfx", "vgui", "h9_levels"),
  ],
  // H9's purple family
  deep: [52, 30, 82],      // the body's lower end and the number's edge
  panel: [133, 98, 178],   // the panels' darker purple
  light: [182, 145, 234],  // the panels' lighter purple
  accent: [190, 140, 255], // #be8cff, the rims
  white: [255, 255, 255],
  glow: [214, 186, 255],   // the radiant tiers' rays and glow
  rim: 0.1,                // the body's rim, of the half-size
  digitHeight: 0.72,       // the number's height, of the half-size
  digitStroke: 0.22,       // its stroke, of the digit height
  digitEdge: 0.1,          // the dark edge around it, of the digit height
  sheetBackground: [10, 6, 8],
};

// One entry a tier (levels 1-10, 11-20, ...): the body's shape, its scale, and what sits
// around it. ring: an outer ring; double: a second rim inside the first; wings, laurel, rays,
// crown: the ornaments; bright: how far the body's colours go toward white (0 to 1).
export const TIERS = [
  { shape: "circle", scale: 0.8, bright: 0.0 },
  { shape: "roundSquare", scale: 0.78, bright: 0.08 },
  { shape: "diamond", scale: 0.98, bright: 0.14 },
  { shape: "hexagon", scale: 0.88, bright: 0.2, ring: true },
  { shape: "shield", scale: 0.9, bright: 0.26, ring: true },
  { shape: "octagon", scale: 0.86, bright: 0.32, ring: true, double: true },
  { shape: "hexagon", scale: 0.78, bright: 0.38, double: true, wings: true },
  { shape: "shield", scale: 0.74, bright: 0.44, double: true, laurel: true },
  { shape: "star", scale: 0.97, bright: 0.5, double: true, rays: true },
  { shape: "circle", scale: 0.7, bright: 0.58, double: true, rays: true, crown: true, ring: true },
];

// Lv 0: the first tier's disc, quieter. quiet: the body darker and greyer, the rim a muted
// purple, the number lavender rather than white; dashes: the rim broken into that many dashes,
// on for dashOn of each.
export const UNRANKED = { shape: "circle", scale: 0.78, bright: 0, quiet: true, dashes: 10, dashOn: 0.62 };

// ---- shapes: signed distance, negative inside --------------------------------------------------

const len = (x, y) => Math.sqrt(x * x + y * y);

function polygon(points) {
  // a convex polygon, as the largest of its edges' half-plane distances; each edge's normal is
  // turned to face away from the middle, whichever way round the points go
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const l = len(ex, ey);
    let nx = ey / l, ny = -ex / l;
    if ((cx - p[0]) * nx + (cy - p[1]) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    return [p[0], p[1], nx, ny];
  });
  return (x, y) => {
    let d = -Infinity;
    for (const [px, py, nx, ny] of edges) d = Math.max(d, (x - px) * nx + (y - py) * ny);
    return d;
  };
}

function regular(n, r, turn) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = turn + (i * 2 * Math.PI) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return polygon(pts);
}

const SHAPES = {
  circle: (s) => (x, y) => len(x, y) - s,
  roundSquare: (s) => {
    const c = s * 0.32;
    return (x, y) => {
      const qx = Math.abs(x) - (s - c), qy = Math.abs(y) - (s - c);
      return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - c;
    };
  },
  diamond: (s) => (x, y) => (Math.abs(x) + Math.abs(y) - s) / Math.SQRT2,
  hexagon: (s) => regular(6, s, -Math.PI / 2),
  octagon: (s) => regular(8, s, Math.PI / 8),
  shield: (s) => polygon([[-s * 0.9, -s * 0.86], [s * 0.9, -s * 0.86], [s * 0.9, s * 0.12], [0, s * 1.02], [-s * 0.9, s * 0.12]]),
  star: (s) => (x, y) => {
    // eight points, the inner radius 0.74 of the outer
    const a = Math.atan2(y, x) + Math.PI / 2;
    const k = (Math.abs(((a / (Math.PI / 4)) % 1 + 1) % 1 - 0.5) * 2);
    const r = s * (0.74 + 0.26 * k);
    return (len(x, y) - r) * 0.9;
  },
};

// ---- the number: a stroke font on a 4 x 6 grid (y down) -------------------------------------------

const DIGITS = {
  0: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  1: [[[0.8, 1.2], [2.2, 0], [2.2, 6]], [[0.8, 6], [3.6, 6]]],
  2: [[[0, 1.2], [1, 0], [3, 0], [4, 1], [4, 2.2], [0, 6], [4, 6]]],
  3: [[[0, 0], [4, 0], [1.8, 2.6], [3, 2.6], [4, 3.6], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4.2], [4, 4.2]]],
  5: [[[4, 0], [0.3, 0], [0, 2.7], [3, 2.7], [4, 3.7], [4, 5], [3, 6], [0, 6]]],
  6: [[[3.6, 0], [1.2, 0], [0, 1.2], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.7], [3, 2.7], [0, 2.7]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  8: [[[1, 0], [3, 0], [4, 0.9], [4, 1.8], [3, 2.75], [1, 2.75], [0, 1.8], [0, 0.9], [1, 0]],
      [[1, 2.75], [3, 2.75], [4, 3.7], [4, 5], [3, 6], [1, 6], [0, 5], [0, 3.7], [1, 2.75]]],
  9: [[[0.4, 6], [2.8, 6], [4, 4.8], [4, 1], [3, 0], [1, 0], [0, 1], [0, 2.3], [1, 3.3], [4, 3.3]]],
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return len(px - ax - t * dx, py - ay - t * dy);
}

// The number's segments, placed: { segs: [[ax, ay, bx, by]], height }.
function numberLayout(n) {
  const text = String(n);
  const h = CONFIG.digitHeight;
  const unit = h / 6;
  const gap = 1.4 * unit;
  const width = text.length * 4 * unit + (text.length - 1) * gap;
  let x0 = -width / 2;
  const y0 = -h / 2;
  const segs = [];
  for (const ch of text) {
    for (const line of DIGITS[ch]) {
      for (let i = 0; i + 1 < line.length; i++) {
        segs.push([x0 + line[i][0] * unit, y0 + line[i][1] * unit, x0 + line[i + 1][0] * unit, y0 + line[i + 1][1] * unit]);
      }
    }
    x0 += 4 * unit + gap;
  }
  return { segs, height: h };
}

// ---- one badge ------------------------------------------------------------------------------------

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function over(dst, rgb, a) {
  // straight alpha "over"
  const out = a + dst[3] * (1 - a);
  if (out <= 0) return [0, 0, 0, 0];
  return [
    (rgb[0] * a + dst[0] * dst[3] * (1 - a)) / out,
    (rgb[1] * a + dst[1] * dst[3] * (1 - a)) / out,
    (rgb[2] * a + dst[2] * dst[3] * (1 - a)) / out,
    out,
  ];
}

// The tier of a ranked level, Lv 1 to 99: 0 for 1-10, up to 9 for 91-99.
export function tierOf(level) {
  return Math.min(TIERS.length - 1, Math.floor((level - 1) / 10));
}

// The look of a level's badge: its tier's, or UNRANKED's for Lv 0.
export function styleOf(level) {
  return level < 1 ? UNRANKED : TIERS[tierOf(level)];
}

// The colour (straight RGBA, 0 to 1 alpha) at a point of the badge for this level.
function sampler(level) {
  const tier = styleOf(level);
  const body = SHAPES[tier.shape](tier.scale);
  const rimW = CONFIG.rim;
  const top = tier.quiet ? mix(CONFIG.panel, CONFIG.deep, 0.4) : mix(CONFIG.light, CONFIG.white, tier.bright * 0.5);
  const bottom = tier.quiet ? mix(CONFIG.deep, [0, 0, 0], 0.3) : mix(CONFIG.panel, CONFIG.deep, 0.35 - tier.bright * 0.3);
  const rimC = tier.quiet ? mix(CONFIG.panel, CONFIG.light, 0.3) : mix(CONFIG.accent, CONFIG.white, tier.bright * 0.6);
  const ink = tier.quiet ? CONFIG.light : CONFIG.white;
  // a dashed rim: on where the angle's place in its dash is under dashOn
  const dashed = (x, y) => {
    if (!tier.dashes) return true;
    const turn = (Math.atan2(y, x) / (2 * Math.PI) + 1.25) % 1;
    return ((turn * tier.dashes) % 1) < tier.dashOn;
  };
  const num = numberLayout(level);
  const stroke = CONFIG.digitStroke * num.height / 2;
  const edge = stroke + CONFIG.digitEdge * num.height;
  const leaves = [];
  if (tier.laurel) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + side * (0.55 + i * 0.42);
        leaves.push([0.9 * Math.cos(a), 0.9 * Math.sin(a), a + side * Math.PI / 2]);
      }
    }
  }
  return (x, y) => {
    let c = [0, 0, 0, 0];
    const r = len(x, y);
    if (tier.rays) {
      // twelve soft rays behind everything
      const a = Math.atan2(y, x);
      const ray = Math.pow(Math.abs(Math.cos(a * 6)), 8);
      const fade = Math.max(0, 1 - r) * (r > 0.35 ? 1 : r / 0.35);
      if (ray * fade > 0.02) c = over(c, CONFIG.glow, Math.min(1, ray * fade * 1.2));
    }
    if (tier.crown) {
      // three crown points above the disc
      for (const [cx, h] of [[-0.42, 0.22], [0, 0.32], [0.42, 0.22]]) {
        const tip = -0.62 - h;
        const ty = (y - tip) / (h + 0.08);
        if (ty >= 0 && ty <= 1 && Math.abs(x - cx) <= 0.17 * ty) c = over(c, rimC, 1);
      }
      if (y < -0.58 && y > -0.72 && Math.abs(x) < 0.62) c = over(c, rimC, 1);
    }
    if (tier.wings) {
      for (const side of [-1, 1]) {
        const wx = side * x;
        if (wx > 0.45 && wx < 1 && Math.abs(y + 0.12) < (1 - wx) * 1.15) c = over(c, mix(rimC, CONFIG.panel, 0.2), 1);
      }
    }
    for (const [lx, ly, la] of leaves) {
      const dx = x - lx, dy = y - ly;
      const u = dx * Math.cos(la) + dy * Math.sin(la), v = -dx * Math.sin(la) + dy * Math.cos(la);
      if ((u * u) / (0.19 * 0.19) + (v * v) / (0.085 * 0.085) <= 1) c = over(c, mix(rimC, CONFIG.light, 0.3), 1);
    }
    if (tier.ring && Math.abs(r - 0.93) < 0.045) c = over(c, rimC, 1);
    const d = body(x, y);
    if (d < 0) {
      const t = Math.min(1, Math.max(0, (y + tier.scale) / (2 * tier.scale)));
      let fill = mix(top, bottom, t);
      // a soft light from the top left
      fill = mix(fill, CONFIG.white, Math.max(0, 0.18 - len(x + 0.35, y + 0.45) * 0.22) * (tier.quiet ? 0.5 : 1));
      c = over(c, fill, 1);
      if (d > -rimW) {
        if (dashed(x, y)) c = over(c, rimC, 1);
      } else if (tier.double && d > -rimW * 1.9 && d < -rimW * 1.35) c = over(c, rimC, 0.85);
    }
    // the number: its dark edge, then the stroke (white; lavender on Lv 0)
    let nd = Infinity;
    for (const s of num.segs) nd = Math.min(nd, segDist(x, y, s[0], s[1], s[2], s[3]));
    if (nd < edge) c = over(c, CONFIG.deep, 0.92);
    if (nd < stroke) c = over(c, ink, 1);
    return c;
  };
}

// The badge for a level at a size: RGBA bytes.
export function badge(level, size) {
  const ss = CONFIG.supersample[size] || 3;
  const at = sampler(level);
  const rgba = new Uint8Array(size * size * 4);
  const n = ss * ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          const c = at(x, y);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / n) * 255);
    }
  }
  return rgba;
}

// A 32-bit TGA with alpha, rows top first (descriptor 0x28), run-length encoded (type 10) with no
// packet across the end of a row; fully clear pixels written as 0 0 0 0, so they run together.
export function tga(w, h, rgba) {
  const out = [];
  const head = new Uint8Array(18);
  head[2] = 10;
  head[12] = w & 255;
  head[13] = w >> 8;
  head[14] = h & 255;
  head[15] = h >> 8;
  head[16] = 32;
  head[17] = 0x28;
  out.push(head);
  const pixel = (i) => (rgba[i + 3] ? [rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]] : [0, 0, 0, 0]);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(pixel((y * w + x) * 4));
    let x = 0;
    while (x < w) {
      let run = 1;
      while (x + run < w && run < 128 && same(row[x + run], row[x])) run++;
      if (run >= 2) {
        out.push(Uint8Array.of(0x80 | (run - 1), ...row[x]));
        x += run;
        continue;
      }
      // a raw packet: up to the next pair of equal pixels, at most 128
      let n = 1;
      while (x + n < w && n < 128 && !(x + n + 1 < w && same(row[x + n], row[x + n + 1]))) n++;
      out.push(Uint8Array.of(n - 1, ...row.slice(x, x + n).flat()));
      x += n;
    }
  }
  return Buffer.concat(out);
}

// Every level at 96 and at 24, a row a tier, Lv 0 in the last cell, on the site's background.
function sheet(images) {
  const cellW = 120, cellH = 132, pad = 16;
  const W = pad * 2 + cellW * 10, H = pad * 2 + cellH * 10;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([...CONFIG.sheetBackground, 255], i * 4);
  const blit = (img, size, ox, oy) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4, d = ((oy + y) * W + ox + x) * 4;
        const a = img[s + 3] / 255;
        for (let k = 0; k < 3; k++) rgba[d + k] = Math.round(img[s + k] * a + rgba[d + k] * (1 - a));
      }
    }
  };
  for (let level = 0; level <= 99; level++) {
    const cell = level === 0 ? 99 : level - 1;
    const col = cell % 10, row = Math.floor(cell / 10);
    const ox = pad + col * cellW, oy = pad + row * cellH;
    blit(images[level][96], 96, ox + (cellW - 96) / 2, oy);
    blit(images[level][24], 24, ox + (cellW - 24) / 2, oy + 102);
  }
  return png(W, H, rgba);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const out = opt("--out", CONFIG.out);
  const tgaOut = args.includes("--tga") ? [opt("--tga", null)].filter(Boolean) : CONFIG.tgaOut;
  const sheetFile = opt("--sheet", CONFIG.sheet);
  const onlyArg = opt("--only", null);
  const only = onlyArg === null ? null : Number(onlyArg);
  if (only !== null && !(Number.isInteger(only) && only >= 0 && only <= 99)) throw new Error("--only takes a level, 0 to 99");
  mkdirSync(out, { recursive: true });
  for (const dir of tgaOut) mkdirSync(dir, { recursive: true });
  const images = {};
  const t0 = Date.now();
  for (let level = 0; level <= 99; level++) {
    if (only !== null && level !== only) continue;
    images[level] = {};
    for (const size of CONFIG.sizes) {
      images[level][size] = badge(level, size);
      writeFileSync(join(out, "lv-" + level + "-" + size + ".png"), png(size, size, images[level][size]));
    }
    const t = tga(CONFIG.tgaSize, CONFIG.tgaSize, badge(level, CONFIG.tgaSize));
    for (const dir of tgaOut) writeFileSync(join(dir, "lv-" + level + ".tga"), t);
  }
  if (only === null && sheetFile) {
    mkdirSync(dirname(sheetFile), { recursive: true });
    writeFileSync(sheetFile, sheet(images));
  }
  console.log((only !== null ? "1 level" : "100 levels") + " x " + CONFIG.sizes.join("/") + " px -> " + out +
    (tgaOut.length ? "; " + CONFIG.tgaSize + " px TGA -> " + tgaOut.join(", ") : "") +
    (only !== null ? "" : "; sheet " + sheetFile) + " (" + (Date.now() - t0) + " ms)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

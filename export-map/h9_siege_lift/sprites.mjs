// The lift's sprite: the radiated haze clinging to the car's outside, written with SMAK.
//
//   h9_lift_haze.spr   red hellfire haze, upright, ADDITIVE (it glows: the burning city's light caught in the
//                      fallout that the climb drags up the tether), 256 x 128, thickest along its foot and
//                      gone by its top, its ends faded; two layers drifting past each other, and a slow ember
//                      flicker through it. lift.mjs hangs it round every gantry ring, the dock and the hatches,
//                      and only outside: the car's inside stays clear.
//
// The frames are painted here, the rest is SMAK's: quantiseFrames for the palette, writeSpr for the file, readSpr
// and measureSprite to check it, sheetOf and animationOf for the pictures. The frames loop: the last runs into
// the first, played by the client's own clock.
//
//   node sprites.mjs            write out\sprites\h9_lift_haze.spr and its pictures, and print the checks
//   node sprites.mjs deploy     and copy it to TSM\sprites (what export.bat ships) and the game's ts\sprites
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, SMAK } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "sprites");
const TSM = join(HERE, "..", "..");

const kit = async (file) => import(pathToFileURL(join(SMAK, "src", "sprite", file)).href);
const { writeSpr } = await kit("spr.mjs");
const { quantiseFrames } = await kit("palette.mjs");
const { sheetOf, animationOf } = await kit("draw.mjs");
const { measureSprite } = await kit("measure.mjs");

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The haze's light: the sky's fire-red, hotter toward orange where it is thick. */
const DEEP = [0.55, 0.08, 0.03];
const HOT = [1.0, 0.36, 0.08];

/** Smooth noise over a lattice that repeats every `period` cells along x, so a field of it tiles sideways. */
function wrappedNoise(x, y, period, seed) {
  const hash = (i, j) => {
    let h = Math.imul(((i % period) + period) % period, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed + 1, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const [sx, sy] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** The haze's frames: two layers drifting a whole tile each way over the loop, and embers flickering in it. */
function hazeFrames(count, { width = 256, height = 128, cells = 6, most = 0.72, seed = 17 } = {}) {
  const layer = (x, y, shift, s) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let k = 0; k < 3; k++) {
      const scale = cells * 2 ** k;
      sum += amp * wrappedNoise(((x / width) * scale + shift * scale) % scale, (y / height) * (scale / 2) + k * 7.3, scale, s + k);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
  return Array.from({ length: count }, (_, f) => {
    const p = f / count;
    const rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      const up = 1 - (y + 0.5) / height;
      const thick = (1 - smooth(0.05, 0.98, up)) ** 1.1;
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const ends = smooth(0, 0.22, u) * (1 - smooth(0.78, 1, u));
        const haze = 0.6 * layer(x, y, p, seed) + 0.4 * layer(x, y, -p, seed + 11);
        const a = clamp01(most * thick * ends * (0.3 + 1.0 * (haze - 0.3)));
        // embers: a few hot motes riding up through it, brightening and fading over the loop
        const ember = haze > 0.7 ? 0.4 * Math.max(0, Math.sin((p + haze * 3) * Math.PI * 2)) : 0;
        const colour = DEEP.map((c, k) => c + (HOT[k] - c) * clamp01((haze - 0.45) * 2 + ember));
        rgb.set(colour.map((c) => c * a), (y * width + x) * 3);
      }
    }
    return { width, height, rgb, a: new Float32Array(width * height) };
  });
}

const groupsOf = (lists, step) => {
  let first = 0;
  return lists.map((list) => {
    const g = { first, count: list.length, ends: list.map((_, k) => +(step * (k + 1)).toFixed(4)) };
    first += list.length;
    return g;
  });
};

const SPRITES = [{ name: "h9_lift_haze", type: "upright", lists: [hazeFrames(16)], step: 0.45 }];

mkdirSync(OUT, { recursive: true });
const written = [];
for (const s of SPRITES) {
  const frames = s.lists.flat();
  const { palette, pixels, colours } = quantiseFrames(frames, "additive");
  const bytes = writeSpr({
    type: s.type,
    format: "additive",
    palette,
    frames: frames.map((f, i) => ({ width: f.width, height: f.height, pixels: pixels[i] })),
    groups: groupsOf(s.lists, s.step),
  });
  const file = join(OUT, `${s.name}.spr`);
  writeFileSync(file, bytes);
  const spr = M.readSpr(bytes);
  const sheet = sheetOf(spr, { cols: 8, cell: 128 });
  writeFileSync(join(OUT, `${s.name}-sheet.png`), K.png(sheet.width, sheet.height, sheet.rgba));
  writeFileSync(join(OUT, `${s.name}-animated.png`), animationOf(spr, { fps: Math.round(1 / s.step), cell: 200, loop: true }));
  const m = measureSprite(spr, { loop: true });
  console.log(`${s.name}.spr  ${bytes.length} bytes  ${spr.type}  ${s.lists[0].length} frames  ${colours} colours  border max ${m.border?.max?.toFixed?.(3) ?? "?"}  wrap ${m.wrap?.toFixed?.(2) ?? "?"}`);
  written.push(file);
}

if (process.argv.includes("deploy")) {
  for (const dir of [join(TSM, "sprites"), join(GAME_DIR, "ts", "sprites")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of written) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
    console.log(`deployed ${written.length} sprite(s) to ${dir}`);
  }
}

// The travel-zone sprites: one animated portal per city, in that city's colour, made here so the map ships its
// own and borrows nothing from valve\ -- sprites/h9_portal_<city>.spr, the one over a zone being the colour of
// the city the zone leads to.
//
// Each is a loop: three spiral arms turning inside a glowing ring, a core that pulses, the brightest parts
// going to white. The arms turn one arm's spacing a loop, so the last frame meets the first.
//
//   node portals.mjs     write the sprites and a preview sheet of each into out\, and copy the sprites into
//                        H9XASH\ts\sprites
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quantiseFrames } from "../../smak/src/sprite/palette.mjs";
import { writeSpr } from "../../smak/src/sprite/spr.mjs";
import { sheetOf } from "../../smak/src/sprite/draw.mjs";
import { readSpr } from "../../smak/src/maps/sprites.mjs";
import { png } from "../../smak/src/image.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SHIP = "D:/Downloads/TSM/H9XASH/ts/sprites";

export const PORTAL_COLOURS = {
  pc: [255, 176, 87], // Paradise amber
  al: [122, 165, 255], // Alexandria blue
  xe: [111, 242, 200], // Xenon teal
};
export const portalSprite = (city) => `sprites/h9_portal_${city}.spr`;

const SIZE = 64;
const FRAMES = 24;
const ARMS = 3;
const TWIST = 1.1; // how many turns an arm makes from the middle to the rim

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function portalFrames(colour) {
  const c = colour.map((v) => v / 255);
  const frames = [];
  for (let n = 0; n < FRAMES; n++) {
    const p = n / FRAMES;
    const rgb = new Float32Array(SIZE * SIZE * 3);
    const a = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const u = ((x + 0.5) / SIZE) * 2 - 1;
        const v = 1 - ((y + 0.5) / SIZE) * 2;
        const r = Math.hypot(u, v);
        const turn = Math.atan2(v, u);
        const arm = (0.5 + 0.5 * Math.cos(ARMS * turn + TWIST * 2 * Math.PI * r - 2 * Math.PI * p)) ** 3;
        const band = Math.exp(-(((r - 0.55) / 0.22) ** 2));
        const core = 0.55 * Math.exp(-((r / 0.22) ** 2)) * (0.8 + 0.2 * Math.cos(4 * Math.PI * p));
        const halo = 0.2 * Math.exp(-(((r - 0.6) / 0.4) ** 2));
        const rim = clamp01((1 - r) / 0.15);
        const e = Math.min(1.2, arm * band * 1.1 + core + halo) * rim;
        const hot = Math.max(0, e - 0.75) * 1.6;
        const i = y * SIZE + x;
        for (let k = 0; k < 3; k++) rgb[i * 3 + k] = clamp01(c[k] * e + (1 - c[k]) * hot);
        a[i] = clamp01(e);
      }
    frames.push({ width: SIZE, height: SIZE, rgb, a });
  }
  // the engine plays a looping sprite's frames 0 .. count-2 and wraps, so the last stands for the first
  frames.push(frames[0]);
  return frames;
}

/** One city's portal as the bytes of a .spr. */
export function portalBytes(city) {
  const frames = portalFrames(PORTAL_COLOURS[city]);
  const { palette, pixels } = quantiseFrames(frames, "additive");
  return writeSpr({
    type: "parallel",
    format: "additive",
    palette,
    frames: frames.map((frame, n) => ({ width: frame.width, height: frame.height, pixels: pixels[n] })),
  });
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SHIP, { recursive: true });
  for (const city of Object.keys(PORTAL_COLOURS)) {
    const bytes = portalBytes(city);
    const name = `h9_portal_${city}.spr`;
    writeFileSync(join(OUT, name), bytes);
    copyFileSync(join(OUT, name), join(SHIP, name));
    const sheet = sheetOf(readSpr(bytes), { cols: 8, cell: 96 });
    writeFileSync(join(OUT, `h9_portal_${city}.preview.png`), png(sheet.width, sheet.height, sheet.rgba));
    console.log(`${name}: ${bytes.length} bytes, ${FRAMES} frames ${SIZE}x${SIZE} -> ${SHIP}`);
  }
}

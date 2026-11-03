// A contact sheet of the class icons, read back out of the sprite the engine will load.
//
//     node show-class-sprite.mjs
//
// Read from the .spr rather than re-drawn from the generator, deliberately: this shows
// what was actually written to disk, palette and all, so a frame that came out wrong shows
// up here instead of looking right because the drawing code was asked a second time.
//
// Each icon sits on a split background, dark on one side and pale on the other. That is
// the whole test for SPR_ALPHTEST artwork -- there is no soft edge and no blending, so an
// icon either holds its shape against both or it does not, and the black rim is there to
// make sure it does.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { K } from "./lib.mjs";

const SPR = join(process.cwd(), "..", "sprites", "tsm_class.spr");
const OUT = join(process.cwd(), "..", "export-mdl");

// The class names, in the order the plugin indexes frames by. Kept beside the sheet
// rather than read from the cfg so a mismatch between the two is visible here.
const NAMES = ["Assault", "Combat Engineer", "Marksman", "Heavy", "Breacher", "Medic", "Officer", "Recon", "Mech"];

// The sheet carries the classes twice: 0 upwards for the MSR, and from TSM_ICON_RED a red
// copy of the first few for the insurgents. Anything past the names above is one of those.
const RED_BASE = NAMES.length;

/*
 * Which class each red frame is a copy of, in the order the generator appends them: every class
 * drawn in cyan, skipping the two that are role-coloured and have no second icon.
 *
 * It used to be `i - RED_BASE`, which only worked while the two-colour classes were the first ones
 * in the table. Recon and Mech are appended after Medic and Officer, so that arithmetic now labels
 * the wrong icons.
 */
/*
 * Read from what the generator wrote, not kept here. The hand-maintained copy of this drifted the
 * first time a class was added and captioned two icons with the wrong names.
 */
const MAP_FILE = join(process.cwd(), "..", "export-mdl", "tsm_class_frames.json");
const FRAME_MAP = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, "utf8")) : null;
if (FRAME_MAP) {
  NAMES.length = 0;
  NAMES.push(...FRAME_MAP.names);
}
// class index -> the frame holding its red copy; invert it to label a red frame with its class
const RED_SOURCE = FRAME_MAP
  ? FRAME_MAP.redOf.map((f, ci) => [f, ci]).filter(([f]) => f >= 0).sort((a, b) => a[0] - b[0]).map(([, ci]) => ci)
  : [0, 1, 2, 3, 4, 7, 8];
const nameOf = (i) =>
  i < RED_BASE ? `${NAMES[i]}  [MSR]` : `${NAMES[RED_SOURCE[i - RED_BASE]] ?? "?"}  [INS]`;

// -- read the sprite --------------------------------------------------------
const b = readFileSync(SPR);
if (b.toString("ascii", 0, 4) !== "IDSP") throw new Error(`${SPR} is not a sprite`);
const version = b.readInt32LE(4);
const type = b.readInt32LE(8);
const texFormat = b.readInt32LE(12);
const numframes = b.readInt32LE(28);
const palsize = b.readInt16LE(40);

let off = 42;
const pal = b.subarray(off, off + palsize * 3);
off += palsize * 3;
const TRANSPARENT = palsize - 1;

const frames = [];
for (let f = 0; f < numframes; f++) {
  off += 4;                                   // group
  const ox = b.readInt32LE(off), oy = b.readInt32LE(off + 4);
  const w = b.readInt32LE(off + 8), h = b.readInt32LE(off + 12);
  off += 16;
  frames.push({ ox, oy, w, h, px: b.subarray(off, off + w * h) });
  off += w * h;
}
console.log(`  ${SPR}`);
console.log(`  version ${version}  type ${type}  texFormat ${texFormat}  ${numframes} frames  palette ${palsize}`);

// -- draw each one, scaled up, over a split background ----------------------
const Z = 3;                                  // nearest-neighbour, so the hard edge stays hard
const PAD = 10;
const DARK = [26, 30, 36], PALE = [182, 190, 200];

function tileOf(fr) {
  const W = fr.w * Z + PAD * 2, H = fr.h * Z + PAD * 2;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // the split runs corner to corner, so every icon is seen against both
      const bg = (x / W + y / H) < 1 ? DARK : PALE;
      rgba[o] = bg[0]; rgba[o + 1] = bg[1]; rgba[o + 2] = bg[2]; rgba[o + 3] = 255;
    }
  }
  for (let y = 0; y < fr.h * Z; y++) {
    for (let x = 0; x < fr.w * Z; x++) {
      const v = fr.px[((y / Z) | 0) * fr.w + ((x / Z) | 0)];
      if (v === TRANSPARENT) continue;
      const o = ((y + PAD) * W + (x + PAD)) * 4;
      rgba[o] = pal[v * 3]; rgba[o + 1] = pal[v * 3 + 1]; rgba[o + 2] = pal[v * 3 + 2]; rgba[o + 3] = 255;
    }
  }
  return { width: W, height: H, rgba };
}

const shots = frames.map(tileOf);
const labels = frames.map((fr, i) => `${i}  ${nameOf(i)}`);
const sheet = K.tile(shots, 4, labels);
writeFileSync(join(OUT, "tsm_class_reel.png"), K.png(sheet.width, sheet.height, sheet.rgba));
console.log("  wrote export-mdl/tsm_class_reel.png");

/*
 * And the row at the size it is actually seen.
 *
 * The sheet above is three times life size, which flatters everything. Over a head these
 * are small and briefly glanced at, so a second strip is drawn at 1:1 -- if a shape stops
 * reading there, it stops reading in the game.
 */
const small = frames.map((fr) => {
  const W = fr.w + 8, H = fr.h + 8;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const bg = (x / W + y / H) < 1 ? DARK : PALE;
    rgba[o] = bg[0]; rgba[o + 1] = bg[1]; rgba[o + 2] = bg[2]; rgba[o + 3] = 255;
  }
  for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) {
    const v = fr.px[y * fr.w + x];
    if (v === TRANSPARENT) continue;
    const o = ((y + 4) * W + (x + 4)) * 4;
    rgba[o] = pal[v * 3]; rgba[o + 1] = pal[v * 3 + 1]; rgba[o + 2] = pal[v * 3 + 2]; rgba[o + 3] = 255;
  }
  return { width: W, height: H, rgba };
});
/*
 * The short caption for the 1:1 strip, from the SAME lookup the big reel uses.
 *
 * It had its own copy of the arithmetic -- `NAMES[i - RED_BASE]` -- and that copy was not updated
 * with the other one, so the red Recon boot was captioned MEDIC R and the red Mech head OFFICER R.
 * The pictures were right and the words under them were wrong, which is worse than no words.
 */
const shortName = (i) =>
  (i < RED_BASE ? NAMES[i] : NAMES[RED_SOURCE[i - RED_BASE]] ?? "?").split(" ")[0]
  + (i < RED_BASE ? "" : " R");
const strip = K.tile(small, RED_BASE, frames.map((fr, i) => shortName(i)));
writeFileSync(join(OUT, "tsm_class_reel_small.png"), K.png(strip.width, strip.height, strip.rgba));
console.log("  wrote export-mdl/tsm_class_reel_small.png");

frames.forEach((fr, i) => {
  const used = new Set(fr.px);
  used.delete(TRANSPARENT);
  console.log(`    frame ${String(i).padStart(2)}  ${nameOf(i).padEnd(24)} ${fr.w}x${fr.h} at (${fr.ox},${fr.oy})  `
    + `${fr.px.length - fr.px.reduce((a, v) => a + (v === TRANSPARENT ? 1 : 0), 0)} pixels, ${used.size} colours`);
});

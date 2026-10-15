// The sky over Neuropolis, which is the sea.
//
//     node sky.mjs            writes the six sides into out/gfx/env
//     node sky.mjs deploy     and copies them into the game
//
// A GoldSrc sky is six pictures named <skyname>up, dn, lf, rt, ft, bk, in gfx/env, and worldspawn's
// `skyname` key picks which set. Any face wearing the SKY texture becomes a hole through which they
// are drawn, infinitely far away -- which is what makes this better than a block of water texture
// over the glass: the sea gets depth instead of being a flat blue pane a few units up.
//
// THE FORMAT, read off the game's own (valve/gfx/env/2desertbk.tga, 196652 bytes): 256 by 256,
// 24-bit uncompressed TGA, bottom row first, BGR, with the 26-byte TGA 2.0 footer. 18 + 256*256*3
// + 26 comes to exactly 196652.
//
// WHY IT HAS NO SEAMS. Each pixel is turned into a DIRECTION in the world and the colour is a
// function of that direction alone, so two faces meeting along an edge are looking at the same
// directions and agree by construction. The light also depends mostly on how far up a direction
// points, which makes the four side faces near enough identical and the joins invisible.
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, GAME_DIR } from "./lib.mjs";

// Running this file draws and writes the six sides. IMPORTING it -- city.mjs does, for the
// name alone -- writes nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const SKY_NAME = "neuro";
const SIZE = 256;

/*
 * The six sides, each as the way it faces and the two directions its pixels run along.
 * dir = forward + right * u + up * v, for u and v from -1 to 1.
 */
const FACES = {
  ft: { f: [1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
  bk: { f: [-1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] },
  lf: { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  rt: { f: [0, -1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
  up: { f: [0, 0, 1], r: [0, -1, 0], u: [1, 0, 0] },
  dn: { f: [0, 0, -1], r: [0, -1, 0], u: [-1, 0, 0] },
};

/** A repeatable hash of a point, 0 to 1: the grain of the water, and the specks floating in it. */
function hash(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
/** Smooth noise over a direction, by mixing the hash at the corners of a cell. */
function noise(p, scale) {
  const q = p.map((v) => v * scale);
  const i = q.map(Math.floor);
  const f = q.map((v, k) => v - i[k]);
  const s = f.map((v) => v * v * (3 - 2 * v));
  let total = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const w = (dx ? s[0] : 1 - s[0]) * (dy ? s[1] : 1 - s[1]) * (dz ? s[2] : 1 - s[2]);
        total += w * hash(i[0] + dx, i[1] + dy, i[2] + dz);
      }
  return total;
}

/**
 * The colour of the sea in one direction. [r, g, b], 0 to 255.
 *
 * Depth first: straight down is the dark of water with nothing under it, straight up is the surface
 * with the light coming through. Then the shafts of light, which only exist above the horizon and
 * sharpen as they near the vertical; then the dust that hangs in any water and catches that light.
 */
function seaColour(d) {
  const up = d[2]; // -1 looking down, +1 looking up

  // The body of the water. Three stops, mixed: the deep, the middle distance, the lit surface.
  const DEEP = [3, 9, 16];
  const MID = [8, 34, 58];
  const TOP = [54, 132, 178];
  const t = (up + 1) / 2;
  const ramp = t * t * (3 - 2 * t); // eased, so the horizon is a band and not a line
  const base = [0, 1, 2].map((k) => (ramp < 0.5 ? DEEP[k] + (MID[k] - DEEP[k]) * (ramp * 2) : MID[k] + (TOP[k] - MID[k]) * ((ramp - 0.5) * 2)));

  // Shafts of light from the surface. Strongest overhead, gone by the horizon.
  const angle = Math.atan2(d[1], d[0]);
  const shaft = Math.max(0, up) ** 2;
  const rays =
    shaft *
    (0.45 + 0.55 * noise([Math.cos(angle) * 2, Math.sin(angle) * 2, up * 6], 3)) *
    Math.max(0, Math.sin(angle * 7 + noise(d, 2) * 4)) ** 3;

  // The caustic flicker right at the surface, and the dust hanging in the water everywhere.
  const caustic = Math.max(0, up - 0.55) * 2 * noise(d, 14) ** 3;
  const motes = noise(d, 60) ** 14 * 2.2;

  const lit = rays * 90 + caustic * 150 + motes * 110;
  return [0, 1, 2].map((k) => Math.max(0, Math.min(255, Math.round(base[k] + lit * [0.55, 0.85, 1][k]))));
}

/** One side, as a 24-bit TGA the engine reads. */
function tga(face) {
  const { f, r, u } = FACES[face];
  const pixels = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    /*
     * Bottom row FIRST: an image descriptor of 0 means the first row in the file is the bottom of
     * the picture, which is what the game's own skies use. So row 0 has to be the direction that
     * is lowest -- v of -1. Written the other way round, every side came out upside down: dark
     * overhead and the surface light glowing up from below the horizon.
     */
    const v = (2 * (y + 0.5)) / SIZE - 1;
    for (let x = 0; x < SIZE; x++) {
      const uu = (2 * (x + 0.5)) / SIZE - 1;
      let d = [0, 1, 2].map((k) => f[k] + r[k] * uu + u[k] * v);
      const len = Math.hypot(...d);
      d = d.map((c) => c / len);
      const [cr, cg, cb] = seaColour(d);
      const at = (y * SIZE + x) * 3;
      pixels[at] = cb; // TGA keeps them blue, green, red
      pixels[at + 1] = cg;
      pixels[at + 2] = cr;
    }
  }
  const head = Buffer.alloc(18);
  head[2] = 2; // uncompressed true colour
  head.writeUInt16LE(SIZE, 12);
  head.writeUInt16LE(SIZE, 14);
  head[16] = 24; // bits a pixel
  head[17] = 0; // bottom row first
  const foot = Buffer.alloc(26);
  foot.write("TRUEVISION-XFILE.\0", 8, "latin1");
  return Buffer.concat([head, pixels, foot]);
}

if (isMain) {
  const here = join(OUT, "gfx", "env");
  mkdirSync(here, { recursive: true });
  const written = [];
  for (const face of Object.keys(FACES)) {
    const file = join(here, `${SKY_NAME}${face}.tga`);
    const bytes = tga(face);
    writeFileSync(file, bytes);
    written.push(`${SKY_NAME}${face}.tga ${bytes.length}`);
  }
  console.log(`\n  ${written.length} sides into ${here}`);
  for (const w of written) console.log(`     ${w}`);

  if (process.argv.includes("deploy")) {
    const to = join(GAME_DIR, "ts", "gfx", "env");
    mkdirSync(to, { recursive: true });
    for (const face of Object.keys(FACES)) {
      copyFileSync(join(here, `${SKY_NAME}${face}.tga`), join(to, `${SKY_NAME}${face}.tga`));
    }
    console.log(`  deployed to ${to}`);
  }
  console.log(`\n  worldspawn needs "skyname" "${SKY_NAME}", and the dome's ceiling the SKY texture.\n`);
  void existsSync;
}

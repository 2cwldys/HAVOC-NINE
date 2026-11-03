// The sky over the drainage works: a low lid of smog over the city at night, lit from underneath by its
// sodium light, with the city's towers round the horizon and two landmarks the canal points at.
//
//   node sky.mjs            write the six sides into ..\out\gfx\env (beside Neuropolis' sky, where export.bat
//                           collects the skies it ships) and a panorama of them into out\sky
//   node sky.mjs deploy     and copy the six sides into the game's ts\gfx\env
//
// WHAT IS IN IT, from the ground up:
//   the haze      the city's light lying along the horizon, sodium orange going brown
//   the skyline   three rows of towers, far to near: hazy outlines, then dark blocks with a few lit windows
//                 and red lamps on their masts
//   the spire     north, down the canal: a colossal tower, banded with cold light, that climbs into the
//                 smog and lights it from inside
//   the works     south: a squat industrial block with two chimneys, their smoke leaning away
//   searchlights  four beams climbing into the cloud, each ending in a glow on the cloud's underside
//   the smog      an unbroken lid of cloud, lit orange near the horizon and going dark overhead
//
// Every pixel is a function of its direction alone, so the sides meet with no seam. Which side is which, and
// which way up, is SMAK's table (wayOfSide, the engine's own), so the drawn views show the sky the game shows.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, OUT as SHARED_OUT } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Running this file paints the sky; importing it (drainage.mjs does, for the name) paints nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const SKY_NAME = "h9drain";
/** Where the six sides are written: the folder of skies export.bat ships, and that the views read. */
export const SKY_FOLDER = SHARED_OUT;
const SIZE = 256;
const DEG = 180 / Math.PI;

// ---- the colours ---------------------------------------------------------------------------------
const GROUND = [0.016, 0.014, 0.013];
const HAZE = [0.34, 0.3, 0.12]; // sodium light through the toxic murk, lying along the horizon
const LOW_SKY = [0.13, 0.12, 0.055];
const ZENITH = [0.022, 0.02, 0.022];
const CLOUD_DARK = [0.04, 0.042, 0.03];
const CLOUD_LIT = [0.3, 0.28, 0.1];
const TOWER = [0.018, 0.017, 0.02];
const WARM_WINDOW = [0.95, 0.68, 0.36];
const COLD_WINDOW = [0.55, 0.78, 0.95];
const AVIATION = [1.0, 0.16, 0.1];
const SPIRE = [0.022, 0.026, 0.032];
const SPIRE_LIGHT = [0.55, 0.85, 1.0];
const BEAM = [0.62, 0.68, 0.76];
const SMOKE = [0.2, 0.13, 0.085];

// ---- painting ------------------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const add = (a, b, t) => a.map((v, k) => v + b[k] * t);
/** An angle in degrees wrapped into -180 to 180. */
const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** A repeatable number from 0 to 1 for a cell of whole numbers. */
function hash(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise in three dimensions, 0 to 1: the hash at a cell's corners, eased between. */
function noise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        total += (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz) * hash(ix + dx, iy + dy, iz + dz);
  return total;
}

/** Noise of several scales, each half the last: 0 to 1. */
function fbm(x, y, z, octaves) {
  let sum = 0, amp = 0.5, scale = 1, norm = 0;
  for (let k = 0; k < octaves; k++) {
    sum += amp * noise(x * scale, y * scale, z * scale + k * 17.31);
    norm += amp;
    amp *= 0.5;
    scale *= 2.03;
  }
  return sum / norm;
}

/** The air with nothing in it: the haze low, the dark overhead, the ground below. */
function air(el) {
  if (el < 0) return mix(HAZE, GROUND, smooth(0, 8, -el));
  const low = mix(HAZE, LOW_SKY, smooth(0, 10, el));
  return mix(low, ZENITH, smooth(6, 60, el));
}

/** The smog over a direction: how thick it is (0 to 1) and its colour, lit from the city underneath. */
function smog(x, y, z, el, az) {
  if (el <= 0.3) return { thick: 1, colour: HAZE };
  // laid on a plane over the eye, drawn in towards the horizon so the far cloud does not smear to nothing
  const u0 = x / z, v0 = y / z;
  const r = Math.hypot(u0, v0);
  const pull = r > 0 ? r / (1 + r / 5) / r : 1;
  const u = u0 * pull, v = v0 * pull;
  // great rolling masses, and the billows on them
  const big = fbm(u * 0.62 + 11.3, v * 0.62 - 4.7, 0.37, 5);
  const fine = fbm(u * 2.4 - 3.1, v * 2.4 + 8.2, 1.9, 4);
  const shape = big + (fine - 0.5) * 0.4;
  // never clear: where the masses part there is only thinner smog
  const thick = 0.74 + 0.26 * smooth(0.32, 0.56, shape);
  // lit by the city underneath: most where the eye looks low across it, and on the masses more than between
  const glow = 0.08 + 0.92 * Math.exp(-el / 21);
  const relief = smooth(0.32, 0.72, shape);
  let colour = mix(CLOUD_DARK, CLOUD_LIT, clamp01(glow * (0.35 + 0.85 * relief)));
  colour = colour.map((c) => c * (0.78 + 0.5 * (fine - 0.5)));
  // and from inside, round the spire's top: its cold light spread through the cloud, caught by the masses
  const fromSpire = Math.exp(-((wrap(az - SPIRE_AZ) / 10) ** 2)) * smooth(SPIRE_CLOUD - 9, SPIRE_CLOUD + 5, el) * (1 - smooth(36, 66, el));
  colour = add(colour, [0.13, 0.25, 0.32], fromSpire * (0.35 + 0.9 * relief));
  return { thick: clamp01(thick), colour };
}

// ---- the skyline ---------------------------------------------------------------------------------
/** Three rows, far to near: slot width and tower width and height (degrees), how far the haze hides them. */
const ROWS = [
  { id: 1, slot: 1.5, width: [0.5, 1.1], height: [1.5, 7.0], haze: 0.62, windows: 0, gaps: 0.12 },
  { id: 2, slot: 2.8, width: [1.0, 2.2], height: [3.0, 14.0], haze: 0.32, windows: 0.05, gaps: 0.3 },
  { id: 3, slot: 5.0, width: [1.6, 3.8], height: [4.0, 22.0], haze: 0.04, windows: 0.1, gaps: 0.45 },
];

/** How built up the city is round the horizon, 0 to 1: districts, and the tallest round the spire. */
function district(az, row) {
  const r = az / DEG;
  const n = noise(Math.cos(r) * 2.3 + 5, Math.sin(r) * 2.3 + 5, row.id * 3.7);
  return clamp01(0.25 + 0.95 * smooth(0.3, 0.75, n) + 0.55 * Math.exp(-((wrap(az - SPIRE_AZ) / 22) ** 2)));
}

/** One row of towers laid over the colour of a direction. */
function towers(colour, row, az, el) {
  if (el > row.height[1] + 4) return colour;
  const slot = Math.round(az / row.slot);
  const id = (((slot % 1000) + 1000) % 1000);
  const built = district(slot * row.slot, row);
  if (hash(id, row.id, 1) < row.gaps * (1.4 - built)) return colour;
  const half = (row.width[0] + (row.width[1] - row.width[0]) * hash(id, row.id, 2)) / 2;
  const top = row.height[0] + (row.height[1] - row.height[0]) * hash(id, row.id, 3) ** 1.4 * built;
  const edge = Math.abs(az - slot * row.slot);
  const aa = 0.12;
  const stepped = hash(id, row.id, 4) > 0.6 ? top * 0.82 : top;
  let cover = smooth(half + aa, half - aa, edge) * smooth(stepped + aa, stepped - aa, el);
  cover = Math.max(cover, smooth(half * 0.55 + aa, half * 0.55 - aa, edge) * smooth(top + aa, top - aa, el));
  // a mast on some, with a red lamp at its head
  const mast = hash(id, row.id, 5) > 0.72;
  const mastTop = top + 1.4 + 1.6 * hash(id, row.id, 6);
  if (mast) cover = Math.max(cover, smooth(0.07, 0.025, edge) * smooth(mastTop + 0.1, mastTop - 0.1, el) * smooth(top - 0.5, top, el));
  if (!cover) return colour;
  let out = mix(colour, mix(TOWER, HAZE, row.haze), cover);
  if (row.windows) {
    // lit windows on a grid of their own, few: most of this city sleeps dark
    const ca = Math.floor(az / 0.42), ce = Math.floor(el / 0.62);
    const inA = smooth(0.17, 0.11, Math.abs(az - (ca + 0.5) * 0.42));
    const inE = smooth(0.23, 0.16, Math.abs(el - (ce + 0.5) * 0.62));
    const roll = hash(ca, ce, id * 7 + row.id);
    if (roll < row.windows && el < stepped - 0.4 && el > 0.4) {
      const tint = hash(ca, ce, 99) > 0.7 ? COLD_WINDOW : WARM_WINDOW;
      out = mix(out, tint.map((c) => c * (0.35 + 0.4 * hash(ca, ce, 5))), cover * inA * inE);
    }
  }
  if (mast) {
    const lamp = Math.exp(-((edge / 0.09) ** 2 + ((el - mastTop) / 0.09) ** 2));
    out = add(out, AVIATION, lamp * (1 - row.haze));
  }
  return out;
}

// ---- the spire, north ------------------------------------------------------------------------------
const SPIRE_AZ = 97; // just off the canal's line, so it stands over the north end wall
const SPIRE_CLOUD = 25; // where the storm cloud swallows it

/** The spire laid over a direction's colour: a tapering tower, banded with light, into the cloud. */
function spire(colour, az, el, thick) {
  const a = wrap(az - SPIRE_AZ);
  if (Math.abs(a) > 10 || el > 60 || el < -1) return colour;
  // its width: a broad base of buttresses, a block, then a long taper set back in stages
  let half;
  if (el < 4) half = 7.4 - 0.4 * el;
  else if (el < 12) half = 5.2;
  else {
    const t = (el - 12) / 46;
    half = 4.3 - 2.4 * t - 0.45 * (Math.floor(t * 5) / 5);
  }
  const aa = 0.1;
  let cover = smooth(half + aa, half - aa, Math.abs(a));
  // two fins standing off its flanks, up to the first setback
  const fin = Math.abs(Math.abs(a) - (half + 0.75));
  cover = Math.max(cover, smooth(0.2, 0.1, fin) * smooth(20.5, 19.5, el) * smooth(3, 4, el));
  if (!cover) return colour;
  // the cloud in front of it: over SPIRE_CLOUD the smog swallows it, its light still showing through
  const hidden = smooth(SPIRE_CLOUD - 4, SPIRE_CLOUD + 3, el) * clamp01(0.55 + 0.45 * thick);
  // bands of cold light round it, broken in places, and a seam of light up its middle
  const band = el / 1.6;
  const inBand = smooth(0.14, 0.06, Math.abs(band - Math.round(band)));
  const segment = Math.floor((a + 20) / 0.6);
  const lit = hash(segment, Math.round(band), 41) > 0.35 ? 1 : 0.15;
  const seam = Math.exp(-((a / 0.22) ** 2)) * 0.55;
  const glow = clamp01(inBand * lit * 0.9 + seam) * smooth(half, half * 0.6, Math.abs(a));
  let body = mix(SPIRE, HAZE, 0.12 * smooth(0, 8, -el + 8));
  body = add(body, SPIRE_LIGHT, glow * 0.85);
  // its edges catch the haze a little, so it stands off the sky behind
  body = add(body, [0.06, 0.05, 0.04], smooth(half - 0.35, half, Math.abs(a)) * 0.6);
  const seen = cover * (1 - hidden * 0.92);
  return mix(colour, body, seen);
}

// ---- the works, south -------------------------------------------------------------------------------
const WORKS_AZ = 262;
const CHIMNEYS = [
  { at: -2.4, half: 0.62, top: 22, lean: 1.0 },
  { at: 1.8, half: 0.52, top: 18, lean: 1.0 },
];

/** The works laid over a direction's colour: a block, two chimneys, their smoke, the lamps on them. */
function works(colour, az, el) {
  const a = wrap(az - WORKS_AZ);
  if (Math.abs(a) > 70 || el > 62) return colour;
  let out = colour;
  // the smoke first, behind the chimneys: rising, spreading and leaning away (to lower azimuth)
  for (const [n, c] of CHIMNEYS.entries()) {
    if (el < c.top) continue;
    const rise = el - c.top;
    const centre = c.at - rise * 0.9 * c.lean - rise * rise * 0.012;
    const width = 0.7 + rise * 0.36;
    const off = (a - centre) / width;
    const puff = fbm(a * 0.45 + n * 7, el * 0.45, 3.3 + n, 4);
    const density = Math.exp(-off * off) * smooth(0, 1.2, rise) * (1 - smooth(12, 30, rise)) * (0.5 + 0.8 * puff);
    out = mix(out, SMOKE.map((s) => s * (0.7 + 0.6 * puff)), clamp01(density) * 0.85);
  }
  // the block: a long low hall with a stepped roof
  const blockTop = Math.abs(a) < 6 ? 7.4 : Math.abs(a) < 12 ? 5.4 : 3.6;
  const cover = smooth(17.2, 16.8, Math.abs(a)) * smooth(blockTop + 0.1, blockTop - 0.1, el);
  out = mix(out, TOWER, cover);
  // a row of high windows, lit, along the block
  const rowLit = cover * smooth(0.3, 0.1, Math.abs(el - (blockTop - 1.2))) * (Math.floor((a + 30) / 0.7) % 3 !== 0 ? 1 : 0);
  out = add(out, [0.55, 0.36, 0.16], rowLit * 0.7);
  // the chimneys, and the red lamps at their heads
  for (const c of CHIMNEYS) {
    const half = c.half * (1 + 0.25 * smooth(c.top, 0, el));
    const stack = smooth(half + 0.06, half - 0.06, Math.abs(a - c.at)) * smooth(c.top + 0.06, c.top - 0.06, el);
    out = mix(out, TOWER, stack);
    const lamp = Math.exp(-(((a - c.at) / 0.12) ** 2 + ((el - c.top + 0.25) / 0.12) ** 2));
    out = add(out, AVIATION, lamp);
    // the heat at the chimney's mouth, lighting the smoke from under
    out = add(out, [0.35, 0.16, 0.05], Math.exp(-(((a - c.at) / 0.6) ** 2 + ((el - c.top - 0.5) / 0.7) ** 2)) * 0.5);
  }
  return out;
}

// ---- searchlights ----------------------------------------------------------------------------------
/** Each from just under the horizon at one azimuth, up to where it meets the cloud at another. */
const BEAMS = [
  { from: [28, -1.5], to: [44, 33], width: [0.25, 0.9], power: 0.5 },
  { from: [141, -1.5], to: [126, 30], width: [0.25, 0.8], power: 0.38 },
  { from: [204, -1.5], to: [219, 35], width: [0.25, 0.9], power: 0.45 },
  { from: [322, -1.5], to: [307, 29], width: [0.25, 0.8], power: 0.4 },
];

const wayOf = ([az, el]) => [Math.cos(el / DEG) * Math.cos(az / DEG), Math.cos(el / DEG) * Math.sin(az / DEG), Math.sin(el / DEG)];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const l = Math.hypot(...a);
  return a.map((v) => v / l);
};
const BEAM_ARCS = BEAMS.map((b) => {
  const g = wayOf(b.from);
  const t = wayOf(b.to);
  const n = unit(cross(g, t));
  return { ...b, g, t, n, span: Math.acos(dot(g, t)) * DEG, side: unit(cross(n, g)) };
});

/** The light of the beams along a direction, and of the glows where they meet the cloud. */
function beams(colour, d, thick) {
  let out = colour;
  for (const b of BEAM_ARCS) {
    const off = Math.asin(Math.max(-1, Math.min(1, dot(d, b.n)))) * DEG;
    // how far along the arc: the angle from its foot, measured in its own plane
    const inPlane = unit(d.map((v, k) => v - b.n[k] * dot(d, b.n)));
    const along = Math.atan2(dot(inPlane, b.side), dot(inPlane, b.g)) * DEG;
    const share = along / b.span;
    if (share < -0.02 || share > 1.15) continue;
    const width = b.width[0] + (b.width[1] - b.width[0]) * clamp01(share);
    const core = Math.exp(-((off / width) ** 2));
    // strong at the foot, fading as it climbs, gone into the cloud past its end
    const fade = smooth(-0.02, 0.04, share) * (1 - 0.55 * clamp01(share)) * (1 - smooth(0.9, 1.08, share));
    out = add(out, BEAM, core * fade * b.power * (1 - 0.35 * thick * clamp01(share)));
    // where it meets the cloud: a glow spread across the cloud's underside
    const spot = Math.exp(-((off / (width * 3.2)) ** 2) - (((share - 1) * b.span) / 3.5) ** 2);
    out = add(out, [0.26, 0.27, 0.29], spot * b.power * 0.55 * thick);
  }
  return out;
}

/** The colour of the sky along a direction, [r, g, b] from 0 to 1. */
export function skyColourAt(way) {
  const l = Math.hypot(...way);
  const d = way.map((v) => v / l);
  const el = Math.asin(Math.max(-1, Math.min(1, d[2]))) * DEG;
  const az = ((Math.atan2(d[1], d[0]) * DEG) % 360 + 360) % 360;
  let colour = air(el);
  const cloud = smog(d[0], d[1], d[2], el, az);
  if (el > 0) colour = mix(colour, cloud.colour, cloud.thick * smooth(0.3, 4, el));
  // the haze over everything low
  colour = mix(colour, HAZE, 0.55 * Math.exp(-((el / 4.5) ** 2)));
  // the rain the cloud drops: dark shafts hanging from it down to the horizon, streaked
  const shafts = smooth(0.5, 0.78, noise(az * 0.3, 1.3, 7.7)) * smooth(16, 3, el) * smooth(-1, 1.5, el);
  colour = mix(colour, [0.07, 0.075, 0.045], 0.5 * shafts * (0.7 + 0.3 * noise(az * 7, el * 0.15, 3.1)));
  colour = beams(colour, d, el > 0 ? cloud.thick : 0);
  colour = spire(colour, az, el, el > 0 ? cloud.thick : 1);
  colour = works(colour, az, el);
  for (const row of ROWS) colour = towers(colour, row, az, el);
  // the haze in front of even the near towers, at their feet, and under it the city's dark
  colour = mix(colour, HAZE, 0.35 * smooth(1.5, -0.5, el) * smooth(-6, -1, el));
  colour = mix(colour, mix(HAZE.map((c) => c * 0.45), GROUND, smooth(0, 7, -el)), smooth(0.3, -1.2, el));
  // a grain, so nothing bands
  const g = (hash(Math.round(az * 40), Math.round(el * 40), 3) - 0.5) * 0.008;
  return colour.map((c) => clamp01(c + g));
}

/** The six sides, in SMAK's order (M.SKY_SIDES), each { width, height, rgb }. */
export function paintSky(size = SIZE) {
  return M.SKY_SIDES.map((_, side) => {
    const rgb = new Uint8Array(size * size * 3);
    for (let row = 0; row < size; row++)
      for (let column = 0; column < size; column++) {
        const c = skyColourAt(M.wayOfSide(side, ((column + 0.5) / size) * 2 - 1, 1 - ((row + 0.5) / size) * 2));
        for (let k = 0; k < 3; k++) rgb[(row * size + column) * 3 + k] = Math.round(255 * c[k]);
      }
    return { width: size, height: size, rgb };
  });
}

if (isMain) {
  const sides = paintSky();
  const env = join(SKY_FOLDER, "gfx", "env");
  mkdirSync(env, { recursive: true });
  const files = M.skyFiles(SKY_NAME, sides);
  for (const f of files) writeFileSync(join(SKY_FOLDER, f.name), f.bytes);
  console.log(`\n  ${files.length} sides of ${SKY_NAME} into ${env}`);

  // a panorama to look at: all round from the ground's dark to 75 up, north in the middle
  const preview = join(HERE, "out", "sky");
  mkdirSync(preview, { recursive: true });
  const W = 1440, H = 420, LOW = -10, HIGH = 75;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const az = 90 + 180 - (x / W) * 360; // north in the middle, east to its right
      const el = HIGH - (y / H) * (HIGH - LOW);
      const c = skyColourAt(wayOf([az, el]));
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(255 * c[k]);
      rgba[i + 3] = 255;
    }
  writeFileSync(join(preview, `${SKY_NAME}-panorama.png`), K.png(W, H, rgba));
  // and the six sides as the game holds them, read back from the files
  const read = M.skyOf(SKY_NAME, [SKY_FOLDER]);
  if (!read.sides) throw new Error(`the sky does not read back: ${read.why}`);
  const strip = new Uint8Array(SIZE * 6 * SIZE * 4);
  read.sides.forEach((s, k) => {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const from = (y * SIZE + x) * 3, to = (y * SIZE * 6 + k * SIZE + x) * 4;
        strip[to] = s.rgb[from];
        strip[to + 1] = s.rgb[from + 1];
        strip[to + 2] = s.rgb[from + 2];
        strip[to + 3] = 255;
      }
  });
  writeFileSync(join(preview, `${SKY_NAME}-sides.png`), K.png(SIZE * 6, SIZE, strip));
  console.log(`  mean ${read.mean.join(" ")}; pictures in ${preview}`);

  if (process.argv.includes("deploy")) {
    const to = join(GAME_DIR, "ts", "gfx", "env");
    mkdirSync(to, { recursive: true });
    for (const f of files) copyFileSync(join(SKY_FOLDER, f.name), join(to, f.name.split("/").pop()));
    console.log(`  deployed to ${to}`);
  }
  void existsSync;
}

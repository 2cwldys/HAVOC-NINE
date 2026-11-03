// The sky over New Byzantium: a dystopian night. Near-black navy overhead with low cloud lit faintly from the
// city; a sickly green-violet pollution glow along the horizon, the ruins of far cities black against it, a
// snapped spire among them; searchlights climbing; and below the horizon, if a player ever sees that far, the
// sprawl at night -- threads of streets, lit and dark districts, a few fires.
//
//   node sky.mjs            write the six sides (h9byz) into ..\out\gfx\env, beside the other skies export.bat
//                           collects, and a panorama of them into out\sky
//   node sky.mjs deploy     and copy the six sides into the game's ts\gfx\env
//
// Every pixel is a function of its direction alone, so the sides meet with no seam; which side is which is
// SMAK's table (wayOfSide).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, OUT as SHARED_OUT } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Running this file paints the sky; importing it (lift.mjs does, for the name and the colours) paints nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const SKY_NAME = "h9byz";
/** Where the six sides are written: the folder of skies export.bat ships, and that the views read. */
export const SKY_FOLDER = SHARED_OUT;
const SIZE = 256;
const DEG = 180 / Math.PI;

// ---- the colours: drainage's world, pushed to blood and sulphur ---------------------------------------
export const HAZE = [0.13, 0.2, 0.15]; // the horizon: fire-light through the murk
const LOW_SKY = [0.07, 0.11, 0.08];
const ZENITH = [0.008, 0.01, 0.022];
const CLOUD_DARK = [0.02, 0.022, 0.04];
export const CLOUD_LIT = [0.16, 0.24, 0.2]; // the smog's underside over a fire
const SULPHUR = [0.22, 0.36, 0.16];
const ASH = [0.07, 0.07, 0.1];
const RUIN = [0.012, 0.012, 0.02];
const WARM_WINDOW = [0.75, 0.55, 0.95];
const AVIATION = [1.0, 0.14, 0.08];
const FIRE = [0.45, 0.85, 0.55];
const SMOKE = [0.05, 0.06, 0.08];
const BEAM = [0.5, 0.55, 0.7];
const CITY_DARK = [0.008, 0.01, 0.018];
export const SEA = [0.04, 0.05, 0.07]; // the cloud sea below, its own light

// ---- painting -------------------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const add = (a, b, t) => a.map((v, k) => v + b[k] * t);
const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

function hash(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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

/** The air with nothing in it: the haze low, going to the dark overhead. */
function air(el) {
  const low = mix(HAZE, LOW_SKY, smooth(0, 12, el));
  return mix(low, ZENITH, smooth(8, 70, el));
}

// ---- overhead: the smog lid ---------------------------------------------------------------------------
function smog(x, y, z, el) {
  const u0 = x / z, v0 = y / z;
  const r = Math.hypot(u0, v0);
  const pull = r > 0 ? r / (1 + r / 4) / r : 1;
  const u = u0 * pull, v = v0 * pull;
  const big = fbm(u * 0.55 + 3.1, v * 0.55 - 7.7, 0.9, 5);
  const fine = fbm(u * 2.6 + 1.7, v * 2.6 + 4.4, 2.3, 4);
  const shape = big + (fine - 0.5) * 0.45;
  const thick = 0.78 + 0.22 * smooth(0.3, 0.58, shape);
  // lit from below by the burning city: strongest low over the horizon, the masses more than between them
  const glow = 0.06 + 0.94 * Math.exp(-el / 18);
  const relief = smooth(0.3, 0.74, shape);
  let colour = mix(CLOUD_DARK, CLOUD_LIT, clamp01(glow * (0.3 + 0.9 * relief)));
  // a sulphur cast in the thinner parts, where the poison shows
  colour = mix(colour, SULPHUR.map((c) => c * glow), 0.22 * smooth(0.55, 0.3, shape));
  colour = colour.map((c) => c * (0.78 + 0.5 * (fine - 0.5)));
  // high streaks of ash, drawn out in one direction across the top of the sky
  const streak = smooth(0.58, 0.8, fbm(u * 0.8 + v * 0.25, v * 6.5, 5.5, 3)) * smooth(25, 55, el);
  colour = mix(colour, ASH, streak * 0.55);
  return { thick: clamp01(thick), colour };
}

// ---- the horizon: ruins, the spire, the cut tether ----------------------------------------------------
const ROWS = [
  { id: 1, slot: 1.4, width: [0.5, 1.2], height: [0.8, 4.5], haze: 0.7, gaps: 0.18, lamps: 0.04 },
  { id: 2, slot: 2.6, width: [0.9, 2.1], height: [1.5, 7.5], haze: 0.45, gaps: 0.3, lamps: 0.08 },
  { id: 3, slot: 4.4, width: [1.4, 3.4], height: [2.0, 10.0], haze: 0.2, gaps: 0.45, lamps: 0.12 },
];

/** A row of ruined towers along the horizon: broken, jagged tops; a few red lamps still burning. */
function ruins(colour, row, az, el) {
  if (el > row.height[1] + 3 || el < -1.5) return colour;
  const slot = Math.round(az / row.slot);
  const id = ((slot % 1000) + 1000) % 1000;
  if (hash(id, row.id, 1) < row.gaps) return colour;
  const half = (row.width[0] + (row.width[1] - row.width[0]) * hash(id, row.id, 2)) / 2;
  const top = row.height[0] + (row.height[1] - row.height[0]) * hash(id, row.id, 3) ** 1.3;
  const off = az - slot * row.slot;
  // the broken top: a slope from one corner to the other, chewed by noise
  const slope = (hash(id, row.id, 4) - 0.5) * 2.2;
  const chewed = (noise(off * 9 + id, row.id * 3.1, 2.2) - 0.5) * 1.4;
  const roof = top + slope * (off / half) + chewed;
  const aa = 0.1;
  const cover = smooth(half + aa, half - aa, Math.abs(off)) * smooth(roof + aa, roof - aa, el);
  if (!cover) return colour;
  let out = mix(colour, mix(RUIN, HAZE, row.haze), cover);
  // the fire inside some of them, showing through the gaps in their walls
  if (hash(id, row.id, 6) > 0.8) {
    const gap = smooth(0.6, 0.8, noise(off * 5, el * 2.5, id));
    out = add(out, FIRE, cover * gap * 0.35 * (1 - row.haze) * smooth(roof, roof - 2, el));
  }
  if (hash(id, row.id, 5) < row.lamps) {
    const lamp = Math.exp(-((off / 0.1) ** 2 + ((el - roof + 0.2) / 0.1) ** 2));
    out = add(out, AVIATION, lamp * (1 - row.haze * 0.6));
  }
  return out;
}

const SPIRE_AZ = 128;
/** A great spire far off, snapped two-thirds up, its top leaning against the haze. */
function spire(colour, az, el) {
  const a = wrap(az - SPIRE_AZ);
  if (Math.abs(a) > 8 || el > 30 || el < -1) return colour;
  const aa = 0.08;
  // the standing stump: a taper up to the break
  const BREAK = 16;
  const half = 2.6 - el * 0.09;
  let cover = smooth(half + aa, half - aa, Math.abs(a)) * smooth(BREAK + 0.6 * a, BREAK - 0.2 + 0.6 * a, el);
  // the snapped top, fallen over to the right and hanging at an angle off the break
  const t = (el - BREAK) / 10;
  const lean = BREAK + 0.6 * 1.6;
  const axis = 1.6 + (el - lean) * 0.7;
  const topHalf = 1.4 - t * 0.9;
  cover = Math.max(cover, smooth(topHalf + aa, topHalf - aa, Math.abs(a - axis)) * smooth(BREAK - 0.5, BREAK + 0.2, el) * smooth(BREAK + 11, BREAK + 10, el));
  if (!cover) return colour;
  let body = mix(RUIN, HAZE, 0.38);
  // the break itself still burns
  body = add(body, FIRE, Math.exp(-(((el - BREAK) / 0.7) ** 2) - ((a - 0.6) / 1.8) ** 2) * 0.8);
  return mix(colour, body, cover);
}

const CUT_AZ = 214;
/** The second tether, cut: a line hanging out of the smog, frayed at its end high over the horizon. */
function cutTether(colour, az, el, thick) {
  const a = wrap(az - CUT_AZ);
  if (Math.abs(a) > 3 || el < 9) return colour;
  // it hangs a little off true, swaying out of line toward its loose end
  const END = 13;
  const line = 0.08 + 0.02 * smooth(END + 4, END, el);
  const centre = 0.25 * smooth(40, END, el) * Math.sin(el * 0.3);
  const cover = smooth(line + 0.05, line, Math.abs(a - centre)) * smooth(END - 0.3, END + 0.4, el);
  // high up the smog swallows it
  const hidden = smooth(26, 40, el) * thick;
  const frayed = Math.exp(-(((el - END) / 0.35) ** 2) - ((a - centre) / 0.35) ** 2) * 0.5;
  let out = mix(colour, RUIN, cover * (1 - hidden));
  out = add(out, FIRE, frayed * (1 - hidden));
  return out;
}

// ---- below: the city under the cloud sea --------------------------------------------------------------
/**
 * Where a downward direction meets the ground, in units of the lift's height over it. The ground is laid
 * flat; far out it fades into the haze long before the horizon, so no line shows where it would end.
 */
function groundOf(d) {
  const down = -d[2];
  const k = 1 / Math.max(down, 0.02);
  return [d[0] * k, d[1] * k, k];
}

/**
 * The burning city at a ground point, seen from very high: no streets can be told from up here, only the
 * mottled glow of the districts still lit, scattered brighter specks, a few highways winding between them as
 * threads of light, fires burning, and scorched ground where the bombs fell. Nothing in it is straight or
 * regular: from this height a grid would read as a floor. `far` is how far out the point lies, where even
 * the specks run together into a glow.
 */
function city(gx, gy, far) {
  const district = fbm(gx * 0.11 + 40, gy * 0.11 - 12, 4.4, 4);
  const lit = smooth(0.44, 0.62, district);
  const burning = smooth(0.57, 0.68, fbm(gx * 0.07 - 9, gy * 0.07 + 21, 7.7, 4));
  const scorched = smooth(0.6, 0.72, fbm(gx * 0.16 + 5, gy * 0.16 + 5, 2.2, 3));
  const near = 1 - smooth(1.6, 3.6, far);
  // the districts' own glow, mottled at every scale
  const mottle = fbm(gx * 1.7 + 2, gy * 1.7 - 6, 5.1, 4);
  const glow = lit * smooth(0.35, 0.75, mottle);
  // specks: single lights, scattered (a fine noise, cut hard, so they come in clumps and gaps)
  const speck = smooth(0.7, 0.86, noise(gx * 7.3 + 9, gy * 7.3 - 2, 6.6)) * lit * near;
  // highways: where a slow noise crosses its middle, a thread of light winding through
  const road = (k, z) => smooth(0.018, 0.004, Math.abs(fbm(gx * k + z, gy * k - z, z, 3) - 0.5));
  const highways = Math.max(road(0.09, 3.3), road(0.13, 8.1) * 0.7) * (0.35 + 0.65 * lit);
  const tint = WARM_WINDOW;
  const light = glow * 0.28 + speck * 0.75 + highways * 0.6;
  let c = add(CITY_DARK, tint, light * (1 - scorched * 0.85));
  // fires: hot flickering cores in the burning districts, and their glow spread wide round them
  const core = smooth(0.6, 0.82, fbm(gx * 1.1 + 3, gy * 1.1 - 5, 9.9, 3));
  c = add(c, FIRE, burning * (0.3 + 1.4 * core));
  c = mix(c, CITY_DARK.map((v) => v * 0.6), scorched * 0.7);
  return { colour: c, burning };
}

/** The cloud sea between the lift and the city: how much it hides, and its colour, lit red from under. */
function cloudSea(gx, gy) {
  const big = fbm(gx * 0.09 + 7, gy * 0.09 + 3, 1.2, 5);
  const fine = fbm(gx * 0.45 - 4, gy * 0.45 + 9, 3.4, 4);
  const shape = big + (fine - 0.5) * 0.5;
  const cover = smooth(0.36, 0.6, shape);
  let colour = mix(SEA.map((c) => c * 0.5), SEA, smooth(0.45, 0.75, shape));
  colour = colour.map((c) => c * (0.8 + 0.5 * (fine - 0.5)));
  return { cover, colour };
}

/** The colour of a direction below the horizon. */
function below(d, el, az) {
  const [gx, gy, far] = groundOf(d);
  const ground = city(gx * 4, gy * 4, far);
  const sea = cloudSea(gx * 4, gy * 4);
  // the fires light the cloud above them from under
  const seaLit = add(sea.colour, CLOUD_LIT, ground.burning * 0.6);
  let colour = mix(ground.colour, seaLit, sea.cover);
  // smoke columns from the fires, leaning with the wind, catching the fire-light
  const smoke = smooth(0.55, 0.85, fbm(gx * 2.2 + gy * 0.7, gy * 2.2, 6.6, 3)) * ground.burning * (1 - sea.cover);
  colour = mix(colour, SMOKE, smoke * 0.6);
  // distance: the far ground fades into the haze, and well before the horizon there is only haze
  const fade = smooth(1.2, 9, far);
  colour = mix(colour, mix(HAZE, SEA, 0.35), fade);
  return colour;
}

// ---- searchlights, climbing out of the city into the smog ---------------------------------------------
const BEAMS = [
  { from: [52, -9], to: [64, 31], width: [0.2, 0.9], power: 0.42 },
  { from: [171, -14], to: [158, 28], width: [0.2, 0.8], power: 0.34 },
  { from: [287, -7], to: [301, 33], width: [0.2, 0.9], power: 0.4 },
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
  return { ...b, g, n, span: Math.acos(dot(g, t)) * DEG, side: unit(cross(n, g)) };
});

function beams(colour, d, thick) {
  let out = colour;
  for (const b of BEAM_ARCS) {
    const off = Math.asin(Math.max(-1, Math.min(1, dot(d, b.n)))) * DEG;
    const inPlane = unit(d.map((v, k) => v - b.n[k] * dot(d, b.n)));
    const along = Math.atan2(dot(inPlane, b.side), dot(inPlane, b.g)) * DEG;
    const share = along / b.span;
    if (share < -0.02 || share > 1.15) continue;
    const width = b.width[0] + (b.width[1] - b.width[0]) * clamp01(share);
    const core = Math.exp(-((off / width) ** 2));
    const fade = smooth(-0.02, 0.05, share) * (1 - 0.5 * clamp01(share)) * (1 - smooth(0.9, 1.08, share));
    out = add(out, BEAM, core * fade * b.power * (1 - 0.35 * thick * clamp01(share)));
    const spot = Math.exp(-((off / (width * 3.2)) ** 2) - (((share - 1) * b.span) / 3.5) ** 2);
    out = add(out, [0.3, 0.2, 0.16], spot * b.power * 0.5 * thick);
  }
  return out;
}

/** The colour of the sky along a direction, [r, g, b] from 0 to 1. */
export function skyColourAt(way) {
  const l = Math.hypot(...way);
  const d = way.map((v) => v / l);
  const el = Math.asin(Math.max(-1, Math.min(1, d[2]))) * DEG;
  const az = ((Math.atan2(d[1], d[0]) * DEG) % 360 + 360) % 360;
  let colour;
  let thick = 1;
  if (el > 0) {
    colour = air(el);
    const cloud = smog(d[0], d[1], d[2], el);
    thick = cloud.thick;
    colour = mix(colour, cloud.colour, cloud.thick * smooth(0.5, 6, el));
  } else colour = below(d, el, az);
  // the haze along the horizon, over both
  colour = mix(colour, HAZE, 0.6 * Math.exp(-((el / 4) ** 2)));
  colour = beams(colour, d, el > 0 ? thick : 0);
  colour = spire(colour, az, el);
  for (const row of ROWS) colour = ruins(colour, row, az, el);
  // the haze in front of the ruins' feet
  colour = mix(colour, HAZE, 0.4 * smooth(1.2, -0.8, el) * smooth(-4, -0.5, el));
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
  mkdirSync(join(SKY_FOLDER, "gfx", "env"), { recursive: true });
  const files = M.skyFiles(SKY_NAME, sides);
  for (const f of files) writeFileSync(join(SKY_FOLDER, f.name), f.bytes);
  console.log(`\n  ${files.length} sides of ${SKY_NAME} into ${join(SKY_FOLDER, "gfx", "env")}`);

  // pictures: the panorama all round from 60 down to 75 up, and the view straight down
  const preview = join(HERE, "out", "sky");
  mkdirSync(preview, { recursive: true });
  const W = 1440, H = 600, LOW = -60, HIGH = 75;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const az = 90 + 180 - (x / W) * 360;
      const el = HIGH - (y / H) * (HIGH - LOW);
      const c = skyColourAt(wayOf([az, el]));
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(255 * c[k]);
      rgba[i + 3] = 255;
    }
  writeFileSync(join(preview, `${SKY_NAME}-panorama.png`), K.png(W, H, rgba));
  const D = 600;
  const down = new Uint8Array(D * D * 4);
  for (let y = 0; y < D; y++)
    for (let x = 0; x < D; x++) {
      // a fisheye looking straight down, out to 80 degrees off the vertical
      const px = (x / D) * 2 - 1, py = (y / D) * 2 - 1;
      const r = Math.hypot(px, py);
      const i = (y * D + x) * 4;
      if (r > 1) {
        down[i + 3] = 255;
        continue;
      }
      const off = r * 80 / DEG, turn = Math.atan2(py, px);
      const c = skyColourAt([Math.sin(off) * Math.cos(turn), Math.sin(off) * Math.sin(turn), -Math.cos(off)]);
      for (let k = 0; k < 3; k++) down[i + k] = Math.round(255 * c[k]);
      down[i + 3] = 255;
    }
  writeFileSync(join(preview, `${SKY_NAME}-down.png`), K.png(D, D, down));
  const up = new Uint8Array(D * D * 4);
  for (let y = 0; y < D; y++)
    for (let x = 0; x < D; x++) {
      const px = (x / D) * 2 - 1, py = (y / D) * 2 - 1;
      const r = Math.hypot(px, py);
      const i = (y * D + x) * 4;
      up[i + 3] = 255;
      if (r > 1) continue;
      const off = r * 60 / DEG, turn = Math.atan2(py, px);
      const c = skyColourAt([Math.sin(off) * Math.cos(turn), Math.sin(off) * Math.sin(turn), Math.cos(off)]);
      for (let k = 0; k < 3; k++) up[i + k] = Math.round(255 * c[k]);
    }
  writeFileSync(join(preview, `${SKY_NAME}-up.png`), K.png(D, D, up));
  const read = M.skyOf(SKY_NAME, [SKY_FOLDER]);
  if (!read.sides) throw new Error(`the sky does not read back: ${read.why}`);
  console.log(`  mean ${read.mean.join(" ")}; pictures in ${preview}`);

  if (process.argv.includes("deploy")) {
    const to = join(GAME_DIR, "ts", "gfx", "env");
    mkdirSync(to, { recursive: true });
    for (const f of files) copyFileSync(join(SKY_FOLDER, f.name), join(to, f.name.split("/").pop()));
    console.log(`  deployed to ${to}`);
  }
}

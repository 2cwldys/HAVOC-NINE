// The sky over Neuropolis: the sea, and the city on its floor, seen from below.
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
//
// THE CITY is laid out in the same terms. Its towers are slots round the horizon, its windows are a
// grid of azimuth and elevation, and the submarines are angles too, so no seam cuts through a shape.
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, GAME_DIR } from "./lib.mjs";

// Running this file draws and writes the six sides. IMPORTING it -- city.mjs does, for the
// name alone -- writes nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const SKY_NAME = "neuro";
const SIZE = 256;
const DEG = 180 / Math.PI;

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
 *
 * Then the haze along the horizon, the towers, the glow column, the submarines and the steel, each
 * laid over the one before it.
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
  let col = [0, 1, 2].map((k) => base[k] + lit * [0.55, 0.85, 1][k]);

  // Each layer is laid over the one before it, the foreground last. All of them are angles.
  const az = angle * DEG;
  const el = Math.asin(Math.max(-1, Math.min(1, up))) * DEG;
  col = mix(col, HAZE_BAND, 0.5 * Math.exp(-((el / 9) ** 2)));
  for (const row of TOWER_ROWS) col = drawRow(col, row, az, el);
  col = glowColumn(col, az, el);
  for (const s of SUBS) col = drawSub(col, s, az, el);
  return col.map((c) => Math.max(0, Math.min(255, Math.round(c))));
}

/*
 * The city. Everything in it is worked out in degrees: azimuth round the horizon, where 0 is
 * straight out through the front (+x) and the angle runs round to the left, and elevation above
 * the horizon, where the sea floor is below 0. A tower is a slot in azimuth that holds a block of a
 * given width, rising to a given elevation. The colour still comes from the direction alone, so a
 * tower that runs over a face edge is the same tower on both faces.
 */
const TOWER_ROWS = [
  // Far to near. Each row is laid over the one before it, so the nearest towers stand in front.
  { id: 1, slots: 270, width: [0.8, 1.2], height: [3, 9], haze: 0.8, windows: false, floor: -14 },
  { id: 2, slots: 135, width: [1.7, 2.3], height: [7, 17], haze: 0.45, windows: false, floor: -22 },
  // The nearest row fades in from -35.3, just above the bottom face's upper edge at -35.26, so the
  // bottom face is left exactly as it was.
  { id: 3, slots: 72, width: [3.6, 4.4], height: [10, 30], haze: 0, windows: true, floor: -35.3 },
];

/** Submarines: the centre of each hull, its half length and its half height, all in degrees. */
const SUBS = [
  { az: 90, el: 11, len: 13, high: 2.4, haze: 0 }, // the long hull, in the middle of the city
  { az: -120, el: 5, len: 6, high: 1.1, haze: 0.35 }, // a second hull, farther off, in the haze
];

/** Pipes and beams on the back face: x0, y0, x1, y1 and radius, in that face's own coordinates. */
const PIPES = [
  [-0.95, -0.62, 0.95, -0.62, 0.04],
  [-0.9, -0.46, 0.2, -0.46, 0.02],
  [-0.7, -0.95, 0.5, -0.5, 0.025],
  [0.6, -0.95, 0.6, -0.45, 0.022],
];

const HAZE = [22, 104, 118]; // the teal the distance fades into
const HAZE_BAND = [34, 128, 140]; // light lying along the horizon
const TOWER = [4, 16, 28]; // the near towers, blue-black against the haze
const WINDOW = [255, 222, 150]; // warm yellow-white lit windows and portholes
const PORT_DARK = [18, 30, 38]; // unlit portholes
const GLOW = [170, 246, 250]; // the glow column, cyan-white
const STEEL = [44, 58, 66]; // girders and pipes in shadow
const STEEL_LIT = [150, 178, 186]; // and where they catch the light
const HULL_LOW = [48, 58, 66]; // a submarine hull, dark underneath
const HULL_TOP = [156, 170, 176]; // and grey on top, where the light comes from
const LAMP_WHITE = [255, 250, 232];
const LAMP_RED = [255, 72, 58];
const LAMP_GREEN = [110, 255, 176];

/** Eased ramp from 0 at a to 1 at b. With a above b it runs the other way, which makes a soft edge. */
function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Blend from colour a to colour b: t of 0 is a, t of 1 is b. */
function mix(a, b, t) {
  return a.map((c, k) => c + (b[k] - c) * t);
}

/** An angle in degrees, wrapped into -180 to 180. */
function wrap(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** A running light: a bright core with a soft halo around it. */
function lamp(dist, size) {
  return Math.exp(-((dist / size) ** 2)) + 0.25 * Math.exp(-((dist / (size * 4)) ** 2));
}

/** One row of towers, laid over the sky at this direction. */
function drawRow(col, row, az, el) {
  const slotW = 360 / row.slots;
  const slot = Math.round(az / slotW); // the slot this direction falls in; it may be negative
  const id = ((slot % row.slots) + row.slots) % row.slots; // the same slot, wrapped round the ring
  if (id !== 0 && hash(id, row.id, 1) < 0.12) return col; // a gap in the skyline; slot 0 is always built
  const edge = Math.abs(az - slot * slotW); // degrees from the middle of the slot
  const half = (row.width[0] + (row.width[1] - row.width[0]) * hash(id, row.id, 2)) / 2;
  // The tallest towers stand at the front, where the glow column is.
  const landmark = 9 * Math.exp(-((slot * slotW / 16) ** 2));
  const top = row.height[0] + (row.height[1] - row.height[0]) * hash(id, row.id, 3) + landmark;
  const stepTop = hash(id, row.id, 4) > 0.55 ? top * 0.7 : top; // some towers narrow near the top
  const aa = 0.3; // edge softness, in degrees
  const base = smooth(half + aa, half - aa, edge) * smooth(stepTop + aa, stepTop - aa, el);
  const narrow = smooth(half * 0.5 + aa, half * 0.5 - aa, edge) * smooth(top + aa, top - aa, el);
  let cover = Math.max(base, narrow);
  if (row.windows && hash(id, row.id, 5) > 0.8) {
    // An aerial on some of the near towers.
    const aerial = smooth(0.2, 0.04, edge) * smooth(top - 0.2, top + 0.2, el) * smooth(top + 3.2, top + 2.8, el);
    cover = Math.max(cover, aerial);
  }
  cover *= smooth(row.floor, row.floor + 14, el); // each row sinks into the dark floor from its own depth
  col = mix(col, mix(TOWER, HAZE, row.haze), cover);
  if (row.windows) {
    // Lit windows, on a grid of their own, shown only where there is a tower.
    const wa = 1.5, we = 1.8;
    const ca = Math.floor(az / wa), ce = Math.floor(el / we);
    const inA = smooth(0.55, 0.45, Math.abs(az - (ca + 0.5) * wa));
    const inE = smooth(0.65, 0.55, Math.abs(el - (ce + 0.5) * we));
    const roll = hash(ca, ce, id);
    const lit = smooth(0.64, 0.7, roll) * (0.7 + 0.3 * roll);
    col = mix(col, WINDOW, cover * inA * inE * lit * smooth(-35.3, -21, el));
  }
  return col;
}

/** The glow column in the middle of the city: a shaft of light from the floor up to the surface. */
function glowColumn(col, az, el) {
  const along = smooth(-40, -10, el) * smooth(34, 22, el);
  const core = Math.exp(-((az / 1.3) ** 2));
  const halo = Math.exp(-((az / 5) ** 2));
  return col.map((c, k) => c + GLOW[k] * (0.85 * core + 0.3 * halo) * along);
}

/** A submarine: a torpedo hull, a conning tower, a row of portholes and three running lights. */
function drawSub(col, s, az, el) {
  const aa = 0.2;
  const u = wrap(az - s.az) * Math.cos(s.el / DEG); // degrees along the hull, the bow at +u
  const v = el - s.el; // degrees above the hull's centre line
  const hull = s.high * Math.sqrt(Math.max(0, 1 - Math.abs(u / s.len) ** 3)); // blunt, rounded ends
  const body = smooth(hull + aa, hull - aa, Math.abs(v)) * smooth(s.len + aa, s.len - aa, Math.abs(u));
  const shade = Math.max(0, Math.min(1, (v / s.high + 1) / 2));
  const hullCol = mix(mix(HULL_LOW, HULL_TOP, shade), HAZE, s.haze);
  col = mix(col, hullCol, body);
  // The conning tower, forward of the middle, and a row of portholes along the hull.
  const towerU = s.len * 0.15, towerHalf = s.len * 0.09;
  const tower =
    smooth(towerHalf + aa, towerHalf - aa, Math.abs(u - towerU)) *
    smooth(s.high * 0.4 - aa, s.high * 0.4 + aa, v) *
    smooth(s.high * 2 + aa, s.high * 2 - aa, v);
  col = mix(col, mix(hullCol, HULL_TOP, 0.5), tower);
  const step = s.len * 0.2, r = s.high * 0.2;
  const port = smooth(r + aa, r - aa, Math.hypot(u - Math.round(u / step) * step, v + s.high * 0.1)) * body;
  const lit = hash(Math.round(u / step), s.az, 7) > 0.45;
  col = mix(col, lit ? WINDOW : PORT_DARK, port);
  // Running lights: white at the bow, red at the stern, green at the top of the conning tower.
  const size = s.high * 0.3;
  const bow = lamp(Math.hypot(u - s.len * 0.97, v), size);
  const stern = lamp(Math.hypot(u + s.len * 0.97, v - s.high * 0.4), size);
  const mast = lamp(Math.hypot(u - towerU, v - s.high * 2.2), size);
  return col.map((c, k) => c + LAMP_WHITE[k] * bow + LAMP_RED[k] * stern + LAMP_GREEN[k] * mast);
}

/** Steel girders across the top face: a grid in that face's own perspective, fading before its rim. */
function girders(col, d) {
  if (d[2] <= 0) return col;
  const X = d[0] / d[2];
  const Y = d[1] / d[2];
  const edge = Math.max(Math.abs(X), Math.abs(Y));
  if (edge >= 1) return col; // not the top face
  const s = 0.22, t = 0.009, aa = 0.004; // the grid spacing and beam half width, in the face's units
  const gx = Math.abs(X - Math.round(X / s) * s);
  const gy = Math.abs(Y - Math.round(Y / s) * s);
  const beam = Math.max(smooth(t + aa, t - aa, gx), smooth(t + aa, t - aa, gy));
  return mix(col, STEEL, 0.5 * beam * (1 - smooth(0.8, 0.98, edge)));
}

/** The pipes and beams across the foreground of the back face. */
function pipes(col, d) {
  if (d[0] >= 0) return col; // the back face is the one that looks out along -x
  const X = d[1] / -d[0]; // the back face's own coordinates: across, and up
  const Y = d[2] / -d[0];
  if (Math.abs(X) >= 1 || Math.abs(Y) >= 1) return col;
  for (const [x0, y0, x1, y1, r] of PIPES) {
    const ex = x1 - x0, ey = y1 - y0;
    const k = Math.max(0, Math.min(1, ((X - x0) * ex + (Y - y0) * ey) / (ex * ex + ey * ey)));
    const qx = (X - (x0 + ex * k)) / r, qy = (Y - (y0 + ey * k)) / r; // offset from the axis, in radii
    const cover = smooth(1 + 0.006 / r, 1 - 0.006 / r, Math.hypot(qx, qy));
    const nz = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy));
    const light = Math.max(0, 0.7 * qy - 0.4 * qx + 0.6 * nz) ** 2;
    col = mix(col, mix(STEEL, STEEL_LIT, light), cover);
  }
  return col;
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
